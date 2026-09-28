import { query } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { londonDateOf, todayISO } from '../lib/dates.js';
import { ukDate } from './complaintRules.js';
import { fetchMessageDetail } from './graphMail.js';
import { analyseEmail, planFromAnalysis } from './emailAnalysis.js';
import { saveAttachmentBuffer } from './attachments.js';
import { recomputeDeadlines } from './complaintDeadlines.js';
import { scheduleReview } from './complaintReview.js';
import { parseImportedComplaint } from './complaintAssistant.js';
import { createComplaint } from './complaintCreate.js';
import { findOrgByName } from './orgMatch.js';
import { researchOrganisation } from './orgResearch.js';

// ---------------------------------------------------------------------------
// What happens to an email once it has arrived: read it in full, keep its
// attachments as documents, file it against the right complaint, work out what
// it is, record what can safely be recorded, and refresh the complaint's review.
// Each step is best-effort — an email is never lost because the mailbox or the
// AI was unavailable; it simply waits as "New" for a person.
// ---------------------------------------------------------------------------

export const AUTO_BY = 'Automatic (from email)';

const KIND_LABEL = {
  acknowledgement: 'Acknowledgement',
  stage1_response: 'Stage 1 response',
  final_response: 'Final response',
  holding_or_extension: 'Holding letter / extension',
  request_for_information: 'Request for information',
  our_email: 'Our email',
  other: 'Email',
};

async function openCandidates() {
  const { rows } = await query(
    `SELECT id, org_name, subject, property, ref_code, reference FROM complaints
      WHERE state = 'open' ORDER BY raised_on DESC LIMIT 80`,
  );
  return rows;
}

// Read, file and act on one stored email. Safe to run again: attachments are
// saved once, and nothing already recorded is recorded twice.
export async function processEmail(emailId) {
  let em = (await query('SELECT * FROM complaint_emails WHERE id = $1', [emailId])).rows[0];
  if (!em) return null;

  // 1. The whole email and its attachments.
  let detail = { bodyText: em.body_text, attachments: [], skipped: [] };
  try {
    detail = await fetchMessageDetail(em.graph_id, { bodyPreview: em.body_preview }, em.source_mailbox || undefined);
    if (detail.bodyText) {
      await query('UPDATE complaint_emails SET body_text = $2 WHERE id = $1', [em.id, detail.bodyText]);
      em.body_text = detail.bodyText;
    }
  } catch (err) {
    console.error(`[complaints] could not read email ${em.id} in full:`, err.message);
  }

  // 2. Work out what it is (and, from the general inbox, which complaint).
  let analysis = em.analysis || null;
  if (config.anthropic.enabled && !em.analysed_at) {
    try {
      const complaint = em.complaint_id
        ? (await query('SELECT * FROM complaints WHERE id = $1', [em.complaint_id])).rows[0]
        : null;
      analysis = await analyseEmail({
        email: em,
        complaint,
        candidates: complaint ? null : await openCandidates(),
        attachments: detail.attachments,
      });
      await query(
        `UPDATE complaint_emails SET analysis = $2, analysed_at = now(), analysis_error = NULL WHERE id = $1`,
        [em.id, JSON.stringify(analysis)],
      );
      // Filed from the general inbox only on a confident match.
      if (!em.complaint_id && analysis.complaint_id && analysis.confidence === 'high') {
        await query(
          `UPDATE complaint_emails SET complaint_id = $2, match_method = 'ai' WHERE id = $1`,
          [em.id, analysis.complaint_id],
        );
        em.complaint_id = analysis.complaint_id;
      }
    } catch (err) {
      await query('UPDATE complaint_emails SET analysis_error = $2 WHERE id = $1', [
        em.id, String(err.message).slice(0, 500),
      ]);
    }
  }
  if (!em.complaint_id && analysis?.new_complaint && analysis.confidence === 'high' &&
      ['watch_new', 'watch', 'inbox'].includes(em.match_method)) {
    // Our own email making a new complaint: create it, so nobody has to.
    em.complaint_id = await createFromEmail(em, analysis);
  }
  if (!em.complaint_id) {
    // From a watched mailbox and not about any complaint: not ours to keep.
    if (em.match_method === 'watch' || em.match_method === 'watch_new') {
      if (!analysis?.complaint_id) {
        await query('DELETE FROM complaint_emails WHERE id = $1', [em.id]);
        return { filed: false, discarded: true };
      }
    }
    return { filed: false, analysis }; // waits in "Emails to file"
  }

  // 3. Its attachments become documents on the complaint (once).
  const saved = new Set(
    (await query('SELECT filename FROM complaint_attachments WHERE source_email_id = $1', [em.id])).rows
      .map((r) => r.filename),
  );
  {
    for (const a of detail.attachments.filter((x) => !saved.has(x.filename))) {
      try {
        await saveAttachmentBuffer(em.complaint_id, a, em.id);
      } catch (err) {
        console.error(`[complaints] attachment ${a.filename} not saved:`, err.message);
      }
    }
  }

  // 4. Record what it means, if that is clear-cut.
  em = (await query('SELECT * FROM complaint_emails WHERE id = $1', [em.id])).rows[0];
  if (!em.reviewed_at) await applyEmail(em, analysis, detail.skipped);
  scheduleReview(em.complaint_id);
  return { filed: true, analysis };
}

// Write the timeline entry for an email and, when the analysis makes it
// clear-cut, record the step it represents — keeping the values it replaced so
// Undo can put them back exactly.
async function applyEmail(em, analysis, skipped = []) {
  const complaint = (await query('SELECT * FROM complaints WHERE id = $1', [em.complaint_id])).rows[0];
  const arrived = londonDateOf(new Date(em.received_at));
  const who = analysis?.author || em.sender_name || em.sender_email || 'unknown';
  const skippedNote = skipped.length ? ` (not saved, too large: ${skipped.join(', ')})` : '';

  const plan = planFromAnalysis(complaint, analysis);
  const summary = analysis?.summary ? `: ${analysis.summary.replace(/[.\s]+$/, '')}` : '';
  const kind = analysis ? KIND_LABEL[analysis.kind] || 'Email' : 'Email';
  const noteDate = analysis?.sent_on || arrived;

  if (!plan.auto) {
    // Waits for a person, with the suggestion on the email.
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,'note',$3,$4)`,
      [complaint.id, noteDate, `${kind} from ${who}${summary}${skippedNote}. Needs checking: ${plan.reason}.`, AUTO_BY],
    );
    return;
  }

  const before = {};
  for (const k of Object.keys(plan.changes)) before[k] = complaint[k] ?? null;
  const cols = Object.keys(plan.changes);
  if (cols.length) {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await query(`UPDATE complaints SET ${set} WHERE id = $1`, [complaint.id, ...cols.map((c) => plan.changes[c])]);
  }
  const type = plan.event?.type || 'note';
  const recorded = plan.event
    ? ` Recorded automatically as their ${kind.toLowerCase()}, dated ${ukDate(plan.event.date)}.`
    : '';
  const ev = await query(
    `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [complaint.id, plan.event?.date || noteDate, type, `${kind} from ${who}${summary}${skippedNote}.${recorded}`, AUTO_BY],
  );
  await query(
    `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3, applied = $4
      WHERE id = $1`,
    [
      em.id, plan.reviewedAs, AUTO_BY,
      JSON.stringify({ before, after: plan.changes, event_id: ev.rows[0].id, kind: analysis?.kind || null }),
    ],
  );
  if (cols.length) await recomputeDeadlines(complaint.id);
}

// Undo what was recorded automatically from an email: put the replaced values
// back, remove the automatic entry, note who undid it, and return the email to
// "New" for a person to decide.
export async function undoEmail(em, by) {
  const applied = em.applied;
  if (!applied) return false;
  const cols = Object.keys(applied.before || {});
  // Only undo what is still as it was recorded: a date someone has since
  // entered or corrected must never be wiped by undoing an older email.
  const now = (await query('SELECT * FROM complaints WHERE id = $1', [em.complaint_id])).rows[0];
  const moved = cols.filter((c) => (now?.[c] ?? null) !== (applied.after?.[c] ?? null));
  if (moved.length) {
    throw new HttpError(
      409,
      `Can’t undo: ${moved.map((c) => c.replace(/_/g, ' ')).join(', ')} has been changed since. ` +
        'Correct it with Edit details instead.',
    );
  }
  if (cols.length) {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await query(`UPDATE complaints SET ${set} WHERE id = $1`, [em.complaint_id, ...cols.map((c) => applied.before[c])]);
  }
  if (applied.event_id) await query('DELETE FROM complaint_events WHERE id = $1', [applied.event_id]);
  await query(
    `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
     VALUES ($1, $4, 'note', $2, $3)`,
    [
      em.complaint_id,
      `Automatic record from the email "${em.subject || '(no subject)'}" undone` +
        (cols.length ? ` (${cols.map((c) => `${c.replace(/_/g, ' ')} back to ${applied.before[c] ?? 'blank'}`).join('; ')})` : '') + '.',
      by,
      todayISO(),
    ],
  );
  await query(
    `UPDATE complaint_emails SET reviewed_at = NULL, reviewed_as = NULL, reviewed_by = NULL, applied = NULL
      WHERE id = $1`,
    [em.id],
  );
  await recomputeDeadlines(em.complaint_id);
  scheduleReview(em.complaint_id);
  return true;
}

// Create the complaint an email of ours makes. The details come from the email
// (organisation, property, what it's about); the date is the day it was sent.
// The organisation is linked if it is saved, or set up and its complaints
// procedure researched if not — marked "not checked" until a person checks it.
async function createFromEmail(em, analysis) {
  const text =
    `Subject: ${em.subject || ''}\nFrom: ${em.sender_name || ''} <${em.sender_email || ''}>\n` +
    `To: ${(em.to_addresses || []).join(', ')}\nSent: ${analysis.sent_on || londonDateOf(new Date(em.received_at))}\n\n` +
    `${em.body_text || em.body_preview || ''}`;
  let p;
  try {
    p = await parseImportedComplaint({ text });
  } catch {
    return null;
  }
  if (p.is_complaint === false || !p.subject || !p.org_name) return null;

  let org = await findOrgByName(p.org_name);
  if (!org) {
    const type = p.org_type || 'other';
    let prof = {};
    try {
      prof = await researchOrganisation({ name: p.org_name, type });
    } catch {
      /* set up without research; the complaint page says so */
    }
    org = (
      await query(
        `INSERT INTO organisations
          (name, type, complaints_email, complaints_url, phone, ombudsman_name, ombudsman_url,
           ombudsman_referral_months, stage1_response_days, stage2_response_days, ack_days,
           procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from, procedure_summary,
           legal_basis, sources, unconfirmed, procedure_evidence, research_status, researched_at, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 ${prof.procedure_summary ? 'now()' : 'NULL'}, $22)
         RETURNING *`,
        [
          p.org_name, type, prof.complaints_email || null, prof.complaints_url || null, prof.phone || null,
          prof.ombudsman_name || null, prof.ombudsman_url || null, prof.ombudsman_referral_months ?? null,
          prof.stage1_response_days ?? null, prof.stage2_response_days ?? null, prof.ack_days ?? null,
          prof.procedure_ref || null, prof.stage1_clock || null, prof.ombudsman_after_weeks ?? null,
          prof.referral_from || null, prof.procedure_summary || null, prof.legal_basis || null,
          prof.sources ? JSON.stringify(prof.sources) : null, prof.unconfirmed?.length ? prof.unconfirmed : null,
          prof.evidence && Object.keys(prof.evidence).length ? JSON.stringify(prof.evidence) : null,
          prof.procedure_summary ? 'researched' : 'none',
          'Set up automatically from a complaint email. Check its complaints procedure.',
        ],
      )
    ).rows[0];
  }

  const raised = analysis.sent_on || londonDateOf(new Date(em.received_at));
  const created = await createComplaint(
    {
      organisation_id: org.id,
      org_name: org.name,
      org_type: org.type,
      subject: p.subject,
      property: p.property || null,
      category: p.category || null,
      description: p.description || null,
      reference: p.reference || null,
      channel: 'email',
      raised_on: raised,
    },
    { by: AUTO_BY, raisedNote: `Complaint created automatically from your email "${em.subject || '(no subject)'}". Check the details.` },
  );
  await query(`UPDATE complaint_emails SET complaint_id = $2, match_method = 'auto_created' WHERE id = $1`, [em.id, created.id]);
  return created.id;
}

// A past email brought in with an imported complaint: read in full and its
// attachments kept, but nothing recorded from it — the complaint's dates came
// from reading the whole thread, and replaying each email would double them.
export async function processHistoricalEmail(emailId) {
  const em = (await query('SELECT * FROM complaint_emails WHERE id = $1', [emailId])).rows[0];
  if (!em?.complaint_id) return;
  try {
    const detail = await fetchMessageDetail(em.graph_id, { bodyPreview: em.body_preview }, em.source_mailbox || undefined);
    if (detail.bodyText) await query('UPDATE complaint_emails SET body_text = $2 WHERE id = $1', [em.id, detail.bodyText]);
    for (const a of detail.attachments) {
      try {
        await saveAttachmentBuffer(em.complaint_id, a, em.id);
      } catch {
        /* one attachment failing doesn't stop the rest */
      }
    }
  } catch (err) {
    console.error(`[complaints] past email ${em.id} not read in full:`, err.message);
  }
  await query(
    `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = 'correspondence', reviewed_by = 'Import'
      WHERE id = $1 AND reviewed_at IS NULL`,
    [em.id],
  );
}
