import { query } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { londonDateOf, todayISO } from '../lib/dates.js';
import { ukDate } from './complaintRules.js';
import { fetchMessageDetail } from './graphMail.js';
import { analyseEmail, planFromAnalysis } from './emailAnalysis.js';
import { saveAttachmentBuffer } from './attachments.js';
import { recomputeDeadlines, recomputePartyDeadlines } from './complaintDeadlines.js';
import { trackForEmail } from './complaintParties.js';
import { scheduleReview } from './complaintReview.js';
import { parseImportedComplaint } from './complaintAssistant.js';
import { createComplaint } from './complaintCreate.js';
import { findOrgByName, findExistingMatch, PARTY_COLS } from './orgMatch.js';
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
    `SELECT c.id, c.org_name, c.subject, c.property, c.ref_code, c.reference, c.account_numbers, ${PARTY_COLS}
       FROM complaints c WHERE c.state = 'open' ORDER BY c.raised_on DESC LIMIT 80`,
  );
  return rows;
}

// Read, file and act on one stored email. Safe to run again: attachments are
// saved once, and nothing already recorded is recorded twice.
export async function processEmail(emailId) {
  let em = (await query(
    'UPDATE complaint_emails SET attempts = attempts + 1 WHERE id = $1 RETURNING *', [emailId],
  )).rows[0];
  if (!em) return null;

  // 1. The whole email and its attachments.
  let detail = { bodyText: em.body_text, attachments: [], skipped: [] };
  let readNote = null; // set when it had to be read without the full email
  try {
    detail = await fetchMessageDetail(
      em.graph_id,
      { bodyPreview: em.body_preview, messageId: String(em.message_id || '').replace(/#dup-.*$/, '') || null },
      em.source_mailbox || undefined,
    );
    if (detail.bodyText) {
      await query('UPDATE complaint_emails SET body_text = $2 WHERE id = $1', [em.id, detail.bodyText]);
      em.body_text = detail.bodyText;
    }
  } catch (err) {
    // Not read in full. While there are tries left, leave it for the
    // five-minute check to try again rather than record it without its
    // attachments. Once the message is gone from the mailbox (deleted), or on
    // the last try, it is read from what we have, and it says so, so it is
    // never left unread for good.
    const gone = err.status === 404;
    if (!gone && em.attempts < 6) {
      await query('UPDATE complaint_emails SET analysis_error = $2 WHERE id = $1', [
        em.id, `Could not read in full: ${String(err.message).slice(0, 300)}`,
      ]);
      return { filed: Boolean(em.complaint_id), retry: true };
    }
    readNote = `Read from ${em.body_text ? 'the text already saved' : 'the preview only'}` +
      `${gone ? ' (it is no longer in the mailbox)' : ' (the mailbox kept refusing)'}; any attachments were not saved.`;
    await query('UPDATE complaint_emails SET analysis_error = $2 WHERE id = $1', [em.id, readNote]);
  }

  // 2. Work out what it is (and, from the general inbox, which complaint).
  let analysis = em.analysis || null;
  if (config.anthropic.enabled && !em.analysed_at) {
    try {
      const complaint = em.complaint_id
        ? (await query('SELECT * FROM complaints WHERE id = $1', [em.complaint_id])).rows[0]
        : null;
      if (complaint) {
        complaint.parties = (await query(
          'SELECT org_name, relationship, reference, stage FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at',
          [complaint.id],
        )).rows;
      }
      analysis = await analyseEmail({
        email: em,
        complaint,
        candidates: complaint ? null : await openCandidates(),
        attachments: detail.attachments,
      });
      await query(
        `UPDATE complaint_emails SET analysis = $2, analysed_at = now(), analysis_error = $3 WHERE id = $1`,
        [em.id, JSON.stringify(analysis), readNote],
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
  // Our own email making a new complaint: create it, so nobody has to. And
  // anything someone deliberately forwarded to the complaints inbox that
  // isn't on a complaint yet: forwarding it means "track this", so a
  // complaint is made from it (or it joins the one it certainly matches),
  // whether or not it is the very first email of the complaint.
  const forwardedToUs = em.match_method === 'inbox' && analysis && !analysis.complaint_id;
  if (!em.complaint_id && (forwardedToUs || (analysis?.new_complaint && analysis.confidence === 'high' &&
      ['watch_new', 'watch', 'inbox'].includes(em.match_method)))) {
    em.complaint_id = await createFromEmail(em, analysis);
    // Others about it may already be waiting (forwarded together, read first).
    if (em.complaint_id) setImmediate(() => fileWaitingEmails().catch((err) => console.error('[complaints] filing waiting emails:', err.message)));
  }
  if (!em.complaint_id) {
    // From a watched mailbox and not about any complaint: not ours to keep.
    if (em.match_method === 'watch' || em.match_method === 'watch_new') {
      // Only when the AI actually read it and placed it nowhere. If the AI
      // failed, it is kept (and read again later), never thrown away.
      const read = (await query('SELECT analysed_at, analysis_error FROM complaint_emails WHERE id = $1', [em.id])).rows[0];
      if (read?.analysed_at && !analysis?.complaint_id && !analysis?.new_complaint) {
        if (em.message_id) {
          await query('INSERT INTO complaint_email_discards (message_id, mailbox) VALUES ($1,$2) ON CONFLICT DO NOTHING', [em.message_id, em.source_mailbox]);
        }
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
  const summary = analysis?.summary ? `: ${analysis.summary.replace(/[.\s]+$/, '')}` : '';
  const kind = analysis ? KIND_LABEL[analysis.kind] || 'Email' : 'Email';
  const noteDate = analysis?.sent_on || arrived;

  // With more than one organisation on the complaint, an email from "the
  // organisation" is recorded on the track of the one that wrote it — never
  // guessed, since the wrong one would move the other organisation's clock.
  const parties = (await query(
    'SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at', [complaint.id],
  )).rows;
  let party = null;
  let plan;
  const fromThem = analysis?.from_organisation && analysis.kind !== 'our_email' && analysis.confidence === 'high';
  if (parties.length && fromThem) {
    const orgIds = [complaint, ...parties].map((t) => t.organisation_id).filter(Boolean);
    const orgs = orgIds.length
      ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
      : [];
    const pick = trackForEmail({
      complaint, parties, orgs, analysis, email: em, ourDomain: config.complaintEmail.domain,
    });
    if (pick.track) {
      party = pick.track.party;
      plan = planFromAnalysis(party || complaint, analysis);
    } else {
      plan = { auto: false, reason: pick.reason };
    }
  } else {
    plan = planFromAnalysis(complaint, analysis);
  }
  const target = party || complaint;
  const table = party ? 'complaint_parties' : 'complaints';
  const fromWhom = party ? ` (${party.org_name})` : '';

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
  for (const k of Object.keys(plan.changes)) before[k] = target[k] ?? null;
  const cols = Object.keys(plan.changes);
  if (cols.length) {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await query(`UPDATE ${table} SET ${set} WHERE id = $1`, [target.id, ...cols.map((c) => plan.changes[c])]);
  }
  const type = plan.event?.type || 'note';
  const recorded = plan.event
    ? ` Recorded automatically as their ${kind.toLowerCase()}${fromWhom}, dated ${ukDate(plan.event.date)}.`
    : '';
  const ev = await query(
    `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [complaint.id, party?.id || null, plan.event?.date || noteDate, type, `${kind} from ${who}${summary}${skippedNote}.${recorded}`, AUTO_BY],
  );
  await query(
    `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3, applied = $4,
            party_id = $5
      WHERE id = $1`,
    [
      em.id, plan.reviewedAs, AUTO_BY,
      JSON.stringify({
        before, after: plan.changes, event_id: ev.rows[0].id, kind: analysis?.kind || null,
        party_id: party?.id || null,
      }),
      party?.id || null,
    ],
  );
  if (cols.length) {
    if (party) await recomputePartyDeadlines(party.id);
    else await recomputeDeadlines(complaint.id);
  }
}

// Undo what was recorded automatically from an email: put the replaced values
// back, remove the automatic entry, note who undid it, and return the email to
// "New" for a person to decide.
export async function undoEmail(em, by) {
  const applied = em.applied;
  if (!applied) return false;
  const cols = Object.keys(applied.before || {});
  // Recorded on a further organisation's track (migration 029), or the main one.
  const partyId = applied.party_id || null;
  const table = partyId ? 'complaint_parties' : 'complaints';
  const targetId = partyId || em.complaint_id;
  // Only undo what is still as it was recorded: a date someone has since
  // entered or corrected must never be wiped by undoing an older email.
  const now = (await query(`SELECT * FROM ${table} WHERE id = $1`, [targetId])).rows[0];
  if (partyId && !now && cols.length) {
    throw new HttpError(409, 'Can’t undo: that organisation has been removed from this complaint since.');
  }
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
    await query(`UPDATE ${table} SET ${set} WHERE id = $1`, [targetId, ...cols.map((c) => applied.before[c])]);
  }
  if (applied.event_id) await query('DELETE FROM complaint_events WHERE id = $1', [applied.event_id]);
  await query(
    `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by, party_id)
     VALUES ($1, $4, 'note', $2, $3, $5)`,
    [
      em.complaint_id,
      `Automatic record from the email "${em.subject || '(no subject)'}" undone` +
        (cols.length ? ` (${cols.map((c) => `${c.replace(/_/g, ' ')} back to ${applied.before[c] ?? 'blank'}`).join('; ')})` : '') + '.',
      by,
      todayISO(),
      partyId && now ? partyId : null,
    ],
  );
  await query(
    `UPDATE complaint_emails SET reviewed_at = NULL, reviewed_as = NULL, reviewed_by = NULL, applied = NULL,
            party_id = NULL
      WHERE id = $1`,
    [em.id],
  );
  if (partyId && now) await recomputePartyDeadlines(partyId);
  else await recomputeDeadlines(em.complaint_id);
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
  if (p.confidence === 'low') return null; // too unsure to create: it waits for a person

  // Already open about the same issue (same organisation and property, or
  // raised within a fortnight)? File it there rather than start a second one.
  const open = (await query(
    `SELECT c.id, c.org_name, c.organisation_id, c.property, c.raised_on, c.reference, c.our_reference, c.subject, c.account_numbers, ${PARTY_COLS}
       FROM complaints c WHERE c.state = 'open'`,
  )).rows;
  const orgsAll = (await query('SELECT id, name FROM organisations')).rows;
  // Matched first on the account number (orgMatch.js#issueMatch). Only a
  // certain match is filed there; a possible one waits for a person rather
  // than risk either filing it on the wrong complaint or starting a duplicate.
  const accounts = [...new Set([...(p.account_numbers || []), ...(analysis.account_numbers || [])])];
  const match = findExistingMatch(open, orgsAll, { ...p, account_numbers: accounts });
  if (match?.certain) {
    await query(`UPDATE complaint_emails SET complaint_id = $2, match_method = 'same_issue' WHERE id = $1`, [em.id, match.complaint.id]);
    return match.complaint.id;
  }
  if (match) return null;

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

  // The date the complaint was made, from the thread (a forward is often a later email in it).
  const raised = (/^\d{4}-\d{2}-\d{2}$/.test(p.raised_on || '') && p.raised_on <= londonDateOf(new Date()) ? p.raised_on : null)
    || analysis.sent_on || londonDateOf(new Date(em.received_at));
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
      account_numbers: accounts,
      channel: 'email',
      raised_on: raised,
    },
    { by: AUTO_BY, needsCheck: true, raisedNote: `Complaint created automatically from your email "${em.subject || '(no subject)'}". Check the details.` },
  );
  await query(`UPDATE complaint_emails SET complaint_id = $2, match_method = 'auto_created' WHERE id = $1`, [em.id, created.id]);
  await query('UPDATE complaints SET accounts_read_at = now() WHERE id = $1', [created.id]);
  return created.id;
}

// Emails waiting to be filed that now clearly belong to a complaint: several
// emails about one complaint forwarded together arrive in any order, so a
// reply can be read before the email that made the complaint (and so before
// the complaint existed). Filed without asking only on certain evidence, and
// no AI is needed to decide:
//   - the same email thread as an email already on a complaint; or
//   - the same account number (or the same organisation and property) as an
//     open complaint (orgMatch.js#findExistingMatch, certain matches only).
// Each one filed is then read again against that complaint, so an
// acknowledgement or response in it is recorded as usual (with Undo).
// Runs after each 5-minute check and whenever a complaint is created from an
// email.
export async function fileWaitingEmails() {
  const waiting = (await query(
    `SELECT * FROM complaint_emails
      WHERE complaint_id IS NULL AND analysed_at IS NOT NULL AND reviewed_at IS NULL
        AND created_at > now() - interval '60 days'
      ORDER BY received_at LIMIT 200`,
  )).rows;
  if (!waiting.length) return 0;
  const open = (await query(
    `SELECT c.id, c.ref_code, c.org_name, c.organisation_id, c.property, c.raised_on, c.reference, c.our_reference, c.subject, c.account_numbers, ${PARTY_COLS}
       FROM complaints c WHERE c.state = 'open'`,
  )).rows;
  const orgs = (await query('SELECT id, name FROM organisations')).rows;
  let filed = 0;
  for (const em of waiting) {
    let target = null;
    let how = null;
    if (em.conversation_id) {
      const t = (await query(
        `SELECT complaint_id FROM complaint_emails
          WHERE conversation_id = $1 AND complaint_id IS NOT NULL LIMIT 1`,
        [em.conversation_id],
      )).rows[0];
      if (t) { target = t.complaint_id; how = 'thread'; }
    }
    if (!target && (em.analysis?.org_name || em.analysis?.account_numbers?.length)) {
      const m = findExistingMatch(open, orgs, {
        org_name: em.analysis.org_name,
        property: em.analysis.property,
        account_numbers: em.analysis.account_numbers,
        reference: em.analysis.their_reference,
        subject: em.subject,
      });
      if (m?.certain) { target = m.complaint.id; how = 'account'; }
    }
    if (!target) continue;
    const { rowCount } = await query(
      `UPDATE complaint_emails SET complaint_id = $2, match_method = $3, analysed_at = NULL
        WHERE id = $1 AND complaint_id IS NULL`,
      [em.id, target, how],
    );
    if (!rowCount) continue;
    filed += 1;
    try {
      await processEmail(em.id); // read again against its complaint
    } catch (err) {
      console.error(`[complaints] waiting email ${em.id} filed but not read:`, err.message);
    }
  }
  return filed;
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
