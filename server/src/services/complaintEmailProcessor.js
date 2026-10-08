import { query } from '../db/pool.js';
import { LANDLORD, ownText } from './authority.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { londonDateOf, todayISO } from '../lib/dates.js';
import { ukDate, trackOpen, readable, saysReturnedToClient, awaitingFirstEmail, usesComplaintWord, ownEmailCheckReasons } from './complaintRules.js';
import { startFormalComplaint } from './complaintFormal.js';
import { overallState } from './complaintParties.js';
import { fetchMessageDetail } from './graphMail.js';
import { analyseEmail, planFromAnalysis, resolutionSuggestion, isOurOwnEmail } from './emailAnalysis.js';
import { saveAttachmentBuffer } from './attachments.js';
import { recomputeDeadlines, recomputePartyDeadlines } from './complaintDeadlines.js';
import { trackForEmail, tracksOf, removedOrgFor } from './complaintParties.js';
import { buildNumberIndex, complaintByNumber } from './numberMatch.js';
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

const RESEARCH_FIGURES = ['ack_days', 'stage1_response_days', 'stage2_response_days', 'stage1_clock', 'ombudsman_name',
  'ombudsman_url', 'ombudsman_referral_months', 'referral_from', 'ombudsman_after_weeks'];

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

async function openNumberIndex() {
  return buildNumberIndex((await query(
    `SELECT c.id, c.account_numbers, c.reference, c.ref_code, ${PARTY_COLS} FROM complaints c WHERE c.state = 'open'`,
  )).rows);
}

// The open complaints the AI may file an email on. All of them when there
// are few enough to send; otherwise the ones this email points at first (an
// organisation it is to or from, by its complaints address or its name in
// the email), then the newest. `complete` says whether every open complaint
// was offered: an email placed on none of an INCOMPLETE list may belong to
// one left out, so it is never thrown away on that reading.
const MAX_CANDIDATES = 150;
export async function openCandidates(em = null) {
  const { rows } = await query(
    `SELECT c.id, c.org_name, c.subject, c.property, c.ref_code, c.reference, c.account_numbers, ${PARTY_COLS},
            (SELECT array_agg(lower(substring(o.complaints_email from '@([^>\\s]+)'))) FROM organisations o
              WHERE o.complaints_email IS NOT NULL AND (o.id = c.organisation_id
                OR o.id IN (SELECT p.organisation_id FROM complaint_parties p WHERE p.complaint_id = c.id))) AS org_domains
       FROM complaints c WHERE c.state = 'open' ORDER BY c.raised_on DESC`,
  );
  if (rows.length <= MAX_CANDIDATES) return { rows, complete: true };
  const dom = (a) => (String(a || '').toLowerCase().match(/@([a-z0-9.-]+)/) || [])[1] || null;
  const domains = new Set([dom(em?.sender_email), ...(em?.to_addresses || []).map(dom)].filter(Boolean));
  const text = `${em?.subject || ''}\n${em?.body_text || em?.body_preview || ''}`.toLowerCase();
  const points = (c) => (c.org_domains || []).some((d) => d && domains.has(d)) ||
    [c.org_name, ...(c.party_names || [])].some((n) => n && n.length >= 4 && text.includes(String(n).toLowerCase()));
  const first = rows.filter(points);
  const rest = rows.filter((c) => !points(c));
  return { rows: [...first, ...rest].slice(0, MAX_CANDIDATES), complete: false };
}

// Read, file and act on one stored email. Safe to run again: attachments are
// saved once, and nothing already recorded is recorded twice.
export async function processEmail(emailId) {
  // Claimed first: never two at once on one email (a slow check overlapping
  // the next, a retry), which would pay for the read twice and record twice.
  const em = (await query(
    `UPDATE complaint_emails SET attempts = attempts + 1, processing_at = now()
      WHERE id = $1 AND (processing_at IS NULL OR processing_at < now() - interval '15 minutes') RETURNING *`,
    [emailId],
  )).rows[0];
  if (!em) return null; // gone, or being processed right now
  try {
    return await processClaimedEmail(em);
  } finally {
    await query('UPDATE complaint_emails SET processing_at = NULL WHERE id = $1', [em.id]).catch(() => {});
  }
}

async function processClaimedEmail(claimed) {
  let em = claimed;
  // Whether every open complaint was offered to the AI (openCandidates).
  let candidatesComplete = true;

  // 0. Our own email sent from here, come back as a copy: filed, nothing to do.
  if (await settleOwnCopies(em.id)) return { filed: true, ownCopy: true };

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

  // 1b. Not on a complaint yet, but quoting an open complaint's account
  // number or reference in its full text: that complaint, with certainty and
  // no AI (numberMatch.js). Numbers of two complaints: left to the reading.
  if (!em.complaint_id) {
    const byNumber = complaintByNumber(`${em.subject || ''}\n${detail.bodyText || em.body_text || em.body_preview || ''}`, await openNumberIndex());
    if (byNumber) {
      await query(`UPDATE complaint_emails SET complaint_id = $2, match_method = 'account' WHERE id = $1`, [em.id, byNumber]);
      em.complaint_id = byNumber;
      em.match_method = 'account';
    }
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
      const offered = complaint ? null : await openCandidates(em);
      candidatesComplete = offered ? offered.complete : true;
      analysis = await analyseEmail({
        email: em,
        complaint,
        candidates: offered ? offered.rows.map(({ org_domains, ...c }) => c) : null,
        attachments: detail.attachments,
      });
      await query(
        `UPDATE complaint_emails SET analysis = $2, analysed_at = now(), analysis_error = $3 WHERE id = $1`,
        [em.id, JSON.stringify(analysis), readNote],
      );
      // The account numbers / reference the reading found (in an attachment,
      // say) that belong to exactly one open complaint: filed there, certain.
      if (!em.complaint_id) {
        const byNumber = complaintByNumber(
          [...(analysis.account_numbers || []), analysis.their_reference || ''].join(' ; '), await openNumberIndex(),
        );
        if (byNumber) {
          await query(`UPDATE complaint_emails SET complaint_id = $2, match_method = 'account' WHERE id = $1`, [em.id, byNumber]);
          em.complaint_id = byNumber;
        }
      }
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
      // And only when every open complaint was offered to it: one left out of
      // a long list may be the complaint it belongs to.
      if (read?.analysed_at && !analysis?.complaint_id && !analysis?.new_complaint && candidatesComplete) {
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
    // The label the email reading gave each one while it had it open.
    const labelOf = new Map((analysis?.documents || []).map((d) => [d.file.trim().toLowerCase(), d.description]));
    for (const a of detail.attachments.filter((x) => !saved.has(x.filename))) {
      try {
        await saveAttachmentBuffer(em.complaint_id, a, em.id, { description: labelOf.get(String(a.filename || '').trim().toLowerCase()) || null });
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
const EARLIER_BY = 'Automatic (arrived before the complaint was made)';
const COPY_BY = 'Automatic (our copy of an email sent from here)';

// The copy of an email we sent from here, arriving back through the complaint's
// own address or utilities@ (everyone on it is copied in). It is that email,
// already on the complaint as sent, so it is filed as ours with nothing for
// anyone to do — and never read by the AI. Recognised by the Message-ID it
// went out with; failing that (an email sent before that was kept), by the
// same sender, the same subject and within two days of it. `emailId` null:
// every one waiting (start-up).
export async function settleOwnCopies(emailId = null) {
  const r = await query(
    `UPDATE complaint_emails e
        SET reviewed_at = now(), reviewed_as = 'sent', reviewed_by = $2,
            complaint_id = COALESCE(e.complaint_id, o.complaint_id),
            analysed_at = COALESCE(e.analysed_at, now())
       FROM complaint_emails o
      WHERE ($1::uuid IS NULL OR e.id = $1)
        AND o.direction = 'outbound' AND o.complaint_id IS NOT NULL
        AND e.direction <> 'outbound' AND e.reviewed_at IS NULL AND e.id <> o.id
        AND (e.complaint_id IS NULL OR e.complaint_id = o.complaint_id)
        AND (
          (o.message_id = e.message_id)
          -- Sent before the Message-ID was kept (their id is our own 'out-…'):
          -- the same sender, subject AND opening words, within two days. The
          -- opening words keep a different email sent from Outlook with the
          -- same subject (a Stage 2 request, say) from being taken for it.
          OR (o.message_id LIKE 'out-%'
              AND lower(substring(e.sender_email from '[^<>\\s]+@[^<>\\s]+')) = lower(substring(o.sender_email from '[^<>\\s]+@[^<>\\s]+'))
              AND lower(btrim(COALESCE(e.subject, ''))) = lower(btrim(COALESCE(o.subject, '')))
              AND length(btrim(COALESCE(o.body_preview, ''))) >= 20
              AND left(regexp_replace(lower(btrim(COALESCE(e.body_preview, ''))), '\\s+', ' ', 'g'), 60)
                = left(regexp_replace(lower(btrim(o.body_preview)), '\\s+', ' ', 'g'), 60)
              AND e.received_at BETWEEN o.received_at - interval '1 hour' AND o.received_at + interval '2 days')
        )`,
    [emailId, COPY_BY],
  );
  return r.rowCount;
}

// Emails already waiting as "new" that arrived before their complaint was
// made: background, not replies, so marked as correspondence (no AI; runs at
// start-up, and is harmless to run again).
export async function settleEarlierEmails() {
  const r = await query(
    `UPDATE complaint_emails e SET reviewed_at = now(), reviewed_as = 'correspondence', reviewed_by = $1
       FROM complaints c
      WHERE e.complaint_id = c.id AND e.reviewed_at IS NULL AND e.direction <> 'outbound'
        AND (e.received_at AT TIME ZONE 'Europe/London')::date < c.raised_on`,
    [EARLIER_BY],
  );
  return r.rowCount;
}

async function applyEmail(em, analysis, skipped = []) {
  const complaint = (await query('SELECT * FROM complaints WHERE id = $1', [em.complaint_id])).rows[0];
  const arrived = londonDateOf(new Date(em.received_at));
  const who = analysis?.author || em.sender_name || em.sender_email || 'unknown';
  const skippedNote = skipped.length ? ` (not saved, too large: ${skipped.join(', ')})` : '';
  const summary = analysis?.summary ? `: ${analysis.summary.replace(/[.\s]+$/, '')}` : '';
  const kind = analysis ? KIND_LABEL[analysis.kind] || 'Email' : 'Email';
  const noteDate = analysis?.sent_on || arrived;
  const emText = `${em.subject || ''}\n${em.body_text || em.body_preview || ''}`;

  // With more than one organisation on the complaint, an email from "the
  // organisation" is recorded on the track of the one that wrote it — never
  // guessed, since the wrong one would move the other organisation's clock.
  const parties = (await query(
    'SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at', [complaint.id],
  )).rows;
  let party = null;
  let plan;
  // Whose email it is, known for certain: the only organisation, or the one
  // the signs picked. Nothing is closed on a guess.
  let placed = !parties.length;
  // Sent by one of us (not a forward of their email): filed as ours whatever
  // the AI made of it, and never read as theirs.
  const ownEmail = isOurOwnEmail(em, analysis, config.complaintEmail.domain);
  const fromThem = !ownEmail && analysis?.from_organisation && analysis.kind !== 'our_email' && analysis.confidence === 'high';
  // An organisation taken off this complaint writing again (or an email of
  // ours to them alone): history, never a step on another organisation's
  // part. When the signs point at both them and one still on it, a person
  // decides.
  let off = null;
  // To or from the landlord (asked for their authority): landlord
  // correspondence, kept on the complaint, never a step with the
  // organisation and never "they wrote" or "we wrote to them".
  const landlord = String(complaint.landlord_email || '').toLowerCase();
  if (landlord) {
    const ours = String(config.complaintEmail.domain || '').toLowerCase();
    const outside = (em.to_addresses || []).map((a) => String(a).toLowerCase()).filter((a) => !a.endsWith(`@${ours}`));
    const sender = String(em.sender_email || '').toLowerCase();
    if (sender === landlord || (ownEmail && outside.length && outside.every((a) => a === landlord))) {
      off = { org: { name: LANDLORD } };
    }
  }
  if (!off && (complaint.removed_orgs || []).length && analysis) {
    const orgIds = [complaint, ...parties].map((t) => t.organisation_id).filter(Boolean);
    const orgs = orgIds.length
      ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
      : [];
    off = removedOrgFor({
      removed: complaint.removed_orgs, tracks: tracksOf(complaint, parties, orgs), analysis, email: em,
      ourDomain: config.complaintEmail.domain,
    });
  }
  if (off) {
    placed = false;
    plan = off.conflict
      ? { auto: false, reason: `It may be from ${off.org.name}, which was taken off this complaint` }
      : { auto: true, changes: {}, reviewedAs: 'correspondence', event: null };
  } else if (parties.length && fromThem) {
    const orgIds = [complaint, ...parties].map((t) => t.organisation_id).filter(Boolean);
    const orgs = orgIds.length
      ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
      : [];
    const pick = trackForEmail({
      complaint, parties, orgs, analysis, email: em, ourDomain: config.complaintEmail.domain,
    });
    if (pick.track) {
      placed = true;
      party = pick.track.party;
      plan = planFromAnalysis(party || complaint, analysis, { text: emText, ownEmail });
    } else {
      plan = { auto: false, reason: pick.reason };
    }
  } else if (parties.length && analysis?.our_step) {
    // Our Stage 2 request / referral on a complaint with more than one
    // organisation: whose part moves on is decided by who it was sent to
    // (their complaints address's domain), never guessed.
    const orgIds = [complaint, ...parties].map((t) => t.organisation_id).filter(Boolean);
    const orgs = orgIds.length
      ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
      : [];
    const domains = new Set((em.to_addresses || []).map((a) => String(a).toLowerCase().split('@')[1]).filter(Boolean));
    const hits = tracksOf(complaint, parties, orgs).filter((t) => t.domain && domains.has(t.domain));
    if (hits.length === 1) {
      party = hits[0].party;
      plan = planFromAnalysis(party || complaint, analysis, { text: emText, ownEmail });
    } else {
      plan = { auto: false, reason: 'It looks like our Stage 2 request or referral, but it isn’t clear which organisation’s part it moves on' };
    }
  } else {
    plan = planFromAnalysis(complaint, analysis, { text: emText, soleTrack: !parties.length, ownEmail });
  }
  const target = party || complaint;
  const table = party ? 'complaint_parties' : 'complaints';
  const fromWhom = party ? ` (${party.org_name})` : '';

  // A debt collector writing that the account has gone back to their client
  // (or been recalled): they can do nothing more, so THEIR part ends, dated
  // their email, with Undo on it. The supplier's part (if on the complaint)
  // carries on; with only the collector on it, the complaint ends.
  let returnedClose = false;
  if (placed && fromThem && target.org_type === 'debt_collector' && trackOpen(target) && complaint.state === 'open' &&
      saysReturnedToClient(`${em.subject || ''}\n${em.body_text || em.body_preview || ''}`) &&
      !(complaint.raised_on && arrived < complaint.raised_on)) {
    const on = /^\d{4}-\d{2}-\d{2}$/.test(analysis?.sent_on || '') && analysis.sent_on <= arrived ? analysis.sent_on : arrived;
    const othersOpen = party
      ? trackOpen(complaint) || parties.some((p) => p.id !== party.id && trackOpen(p))
      : parties.some((p) => trackOpen(p));
    const outcome = `${target.org_name} no longer has the account: it has gone back to their client, so their part of the complaint has ended.`;
    const changes = { stage: 'resolved', closed_on: on, outcome };
    if (party) changes.state = 'resolved';
    else if (!othersOpen) changes.state = 'resolved';
    plan = {
      auto: true, changes, reviewedAs: 'response',
      event: { type: 'resolved', date: on },
      step: `${target.org_name}’s part closed: the account has gone back to their client${othersOpen ? ' (the rest of the complaint carries on)' : ''}`,
    };
    returnedClose = true;
  }

  // It says it's been put right: flagged "Looks resolved" for a person to
  // confirm (never closed by itself), on whichever track it is about.
  const resolved = resolutionSuggestion(analysis, { arrived });
  // (An email from before the complaint was made can't be saying it's resolved.)
  const beforeComplaint = Boolean(complaint.raised_on && arrived < complaint.raised_on);
  // Only when whose email it is is certain: on a complaint with more than one
  // organisation, one that can't be placed would flag the wrong part.
  if (resolved && placed && trackOpen(target) && !beforeComplaint && !returnedClose && !off) {
    await query('UPDATE complaints SET resolution_suggested = $2 WHERE id = $1', [
      complaint.id,
      JSON.stringify({
        ...resolved, email_id: em.id, subject: em.subject || null, party_id: party?.id || null,
        org_name: party?.org_name || null, at: new Date().toISOString(),
      }),
    ]);
    await query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
       VALUES ($1,$2,$3,'note',$4,$5)`,
      [
        complaint.id, party?.id || null, resolved.on || arrived,
        `Looks resolved: ${resolved.by_us ? 'our' : 'their'} email "${em.subject || '(no subject)'}" says ` +
          `${resolved.outcome ? `"${resolved.outcome.replace(/[.\s]+$/, '')}"` : 'it has been put right'}. ` +
          'Confirm on the complaint (Mark resolved, or Not resolved yet).',
        AUTO_BY,
      ],
    );
  }

  if (!plan.auto && beforeComplaint) {
    // It arrived before the complaint was made (found later by its account
    // number, say): background to the complaint, not a reply to it, so it is
    // never left waiting as "new" for a person to review.
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,'note',$3,$4)`,
      [complaint.id, noteDate, `${kind} from ${who}${summary}${skippedNote}. Kept as background: it arrived before the complaint was made.`, AUTO_BY],
    );
    await query(
      `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = 'correspondence', reviewed_by = $2
        WHERE id = $1 AND reviewed_at IS NULL`,
      [em.id, EARLIER_BY],
    );
    return;
  }

  if (!plan.auto) {
    // Waits for a person, with the suggestion on the email. Said once on the
    // timeline: a retry or a re-read of the same email adds nothing (and an
    // email the AI couldn't read waits under New without a note).
    const note = `${kind} from ${who}${summary}${skippedNote}. Needs checking: ${plan.reason}.`;
    if (analysis) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         SELECT $1,$2,'note',$3,$4
          WHERE NOT EXISTS (SELECT 1 FROM complaint_events WHERE complaint_id = $1 AND note = $3 AND created_by = $4)`,
        [complaint.id, noteDate, note, AUTO_BY],
      );
    }
    return;
  }

  const before = {};
  for (const k of Object.keys(plan.changes)) before[k] = target[k] ?? null;
  const cols = Object.keys(plan.changes);
  if (cols.length) {
    const set = cols.map((c, i) => `${c} = $${i + 2}`).join(', ');
    await query(`UPDATE ${table} SET ${set} WHERE id = $1`, [target.id, ...cols.map((c) => plan.changes[c])]);
  }
  // An email Greenco sent (copied in, or forwarded here afterwards) is a step
  // taken — a chaser, a Stage 2 request, the information they asked for — so
  // it goes on the timeline as one, dated the day it was sent, and the review
  // that follows knows it has been done.
  // Only one that went outside Greenco (or was forwarded here after being
  // sent): colleagues emailing each other about the account is a note.
  const ours = String(config.complaintEmail.domain || '').toLowerCase();
  const wentOutside = (em.to_addresses || []).some((a) => {
    const d = String(a).toLowerCase().split('@')[1];
    return d && d !== ours;
  });
  const sentStep = (ownEmail || analysis?.kind === 'our_email') && (wentOutside || Boolean(analysis?.forwarded));
  // The complaint itself, sent from Outlook (copied to the complaint's
  // address) on a complaint logged before it was sent: it has been made now,
  // so it runs from the day it went, exactly as if it had been sent from here.
  // Only our own email, read, to someone outside, that asks for a complaint in
  // so many words (Greenco's rule: usesComplaintWord).
  if (ownEmail && analysis && wentOutside && awaitingFirstEmail(complaint) &&
      usesComplaintWord(`${em.subject || ''}\n${em.body_text || em.body_preview || ''}`)) {
    const on = /^\d{4}-\d{2}-\d{2}$/.test(analysis.sent_on || '') && analysis.sent_on <= arrived ? analysis.sent_on : arrived;
    await startFormalComplaint(complaint.id, on, 'Automatic (from email)', {
      subject: em.subject || null, how: 'sent from Outlook (its copy reached the complaint)',
    });
  }
  const type = plan.event?.type || (sentStep ? 'chased' : 'note');
  const offOrg = off && !off.conflict ? off.org.name : null;
  const recorded = offOrg === LANDLORD
    ? ' Correspondence with the landlord: kept here, not a step with the organisation.'
    : offOrg
    ? ` ${offOrg} was taken off this complaint, so this is kept as history only.`
    : returnedClose
    ? ` ${plan.step}, dated ${ukDate(plan.event.date)} (Undo on the email if that's wrong).`
    : plan.step
    ? ` ${plan.step}${fromWhom}: the complaint was moved on automatically, dated ${ukDate(plan.event.date)} (Undo on the email if that's wrong).`
    : plan.event
      ? ` Recorded automatically as their ${kind.toLowerCase()}${fromWhom}, dated ${ukDate(plan.event.date)}.`
      : '';
  const ev = await query(
    `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by, removed_org)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [complaint.id, party?.id || null, plan.event?.date || noteDate, type, `${kind} from ${who}${summary}${skippedNote}.${recorded}`, AUTO_BY, offOrg],
  );
  await query(
    `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3, applied = $4,
            party_id = $5, removed_org = $6
      WHERE id = $1`,
    [
      em.id, plan.reviewedAs, AUTO_BY,
      JSON.stringify({
        before, after: plan.changes, event_id: ev.rows[0].id, kind: analysis?.kind || null,
        party_id: party?.id || null,
      }),
      party?.id || null,
      offOrg,
    ],
  );
  if (cols.length) {
    if (party) await recomputePartyDeadlines(party.id);
    else await recomputeDeadlines(complaint.id);
  }
  // A part closed: the complaint is open while any part is (overallState),
  // and ends with its last one.
  if (returnedClose) await settleComplaintState(complaint.id);
}

async function settleComplaintState(id) {
  const now = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  if (!now) return;
  const parts = (await query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [id])).rows;
  const state = overallState(now, parts);
  if (state !== now.state) await query('UPDATE complaints SET state = $2 WHERE id = $1', [id, state]);
}

// Undo what was recorded automatically from an email: put the replaced values
// back, remove the automatic entry, note who undid it, and return the email to
// "New" for a person to decide.
// What an Undo put back, in words a person reads: "back to Stage 1", "date
// acknowledged back to blank" — only what the record had changed, with UK
// dates, never column names or internal flags.
const UNDO_LABEL = {
  acknowledged_on: 'date acknowledged', responded_on: 'date responded', final_response_on: 'final response date',
  stage_started_on: 'stage start date', reference: 'their reference', response_due: 'response due date',
};
const STAGE_WORDS = { stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'the ombudsman', resolved: 'resolved', closed: 'closed' };
export function undoneWords(applied) {
  const out = [];
  const before = applied?.before || {};
  const after = applied?.after || {};
  if ('stage' in before && before.stage !== after.stage) out.push(`back to ${STAGE_WORDS[before.stage] || before.stage}`);
  for (const [col, label] of Object.entries(UNDO_LABEL)) {
    if (!(col in before) || (before[col] ?? null) === (after[col] ?? null)) continue;
    out.push(`${label} back to ${before[col] ? readable(String(before[col]).slice(0, 10)) : 'blank'}`);
  }
  return out;
}

export async function undoEmail(em, by) {
  const applied = em.applied;
  if (!applied) return false;
  const cols = Object.keys(applied.before || {});
  // Recorded on a further organisation's track (migration 029), or the main one.
  if (applied.removed_org && Object.keys(applied.before || {}).length) {
    throw new HttpError(409, `Can’t undo: it was recorded for ${applied.removed_org}, which has been taken off this complaint since.`);
  }
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
      `${applied.by ? `What ${applied.by} recorded` : 'Automatic record'} from the email "${em.subject || '(no subject)'}" undone` +
        (undoneWords(applied).length ? ` (${undoneWords(applied).join('; ')})` : '') + '.',
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
  // A "Looks resolved" this email raised goes with it.
  const withdrawn = await query(
    `UPDATE complaints SET resolution_suggested = NULL WHERE id = $1 AND resolution_suggested->>'email_id' = $2`,
    [em.complaint_id, String(em.id)],
  );
  if (withdrawn.rowCount) {
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [em.complaint_id, todayISO(), `"Looks resolved" from the email "${em.subject || '(no subject)'}" withdrawn with it.`, by],
    );
  }
  if (partyId && now) await recomputePartyDeadlines(partyId);
  else await recomputeDeadlines(em.complaint_id);
  // Undoing a part's closure reopens the complaint if that part was its last.
  await settleComplaintState(em.complaint_id);
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

  // By name, or failing that by the address it went to (their complaints
  // address on file), so a name written slightly differently doesn't set up a
  // second organisation. Only when it went to one outside domain: copied to
  // two bodies, the address can't say which the complaint is against.
  const ourDomain = String(config.complaintEmail.domain || '').toLowerCase();
  const outside = [...new Set((em.to_addresses || []).map((a) => String(a).toLowerCase().split('@')[1]).filter((d) => d && d !== ourDomain))];
  let org = await findOrgByName(p.org_name, { domains: outside.length === 1 ? outside : [], ourDomain });
  const orgOnFile = Boolean(org);
  if (!org) {
    const type = p.org_type || 'other';
    let prof = {};
    let researched = false;
    try {
      prof = await researchOrganisation({ name: p.org_name, type });
      researched = true;
    } catch {
      /* set up without research; the complaint page says so */
    }
    // Each figure found is marked as researched (described as their published
    // information, never "their procedure"), and the research is dated once it
    // has been done, so it is never paid for again by itself.
    const found = Object.fromEntries(RESEARCH_FIGURES
      .filter((k) => prof[k] !== null && prof[k] !== undefined && prof[k] !== '').map((k) => [k, 'research']));
    const gotSome = Object.keys(found).length > 0 || Boolean(prof.procedure_summary);
    org = (
      await query(
        `INSERT INTO organisations
          (name, type, complaints_email, complaints_url, phone, ombudsman_name, ombudsman_url,
           ombudsman_referral_months, stage1_response_days, stage2_response_days, ack_days,
           procedure_ref, stage1_clock, ombudsman_after_weeks, referral_from, procedure_summary,
           legal_basis, sources, unconfirmed, procedure_evidence, research_status, researched_at, notes,
           procedure_sources)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
                 ${researched ? 'now()' : 'NULL'}, $22, $23)
         RETURNING *`,
        [
          p.org_name, type, prof.complaints_email || null, prof.complaints_url || null, prof.phone || null,
          prof.ombudsman_name || null, prof.ombudsman_url || null, prof.ombudsman_referral_months ?? null,
          prof.stage1_response_days ?? null, prof.stage2_response_days ?? null, prof.ack_days ?? null,
          prof.procedure_ref || null, prof.stage1_clock || null, prof.ombudsman_after_weeks ?? null,
          prof.referral_from || null, prof.procedure_summary || null, prof.legal_basis || null,
          prof.sources ? JSON.stringify(prof.sources) : null, prof.unconfirmed?.length ? prof.unconfirmed : null,
          prof.evidence && Object.keys(prof.evidence).length ? JSON.stringify(prof.evidence) : null,
          gotSome ? 'researched' : 'none',
          'Set up automatically from a complaint email. Check its complaints procedure.',
          Object.keys(found).length ? JSON.stringify(found) : null,
        ],
      )
    ).rows[0];
  }

  // The date the complaint was made, from the thread (a forward is often a later email in it).
  const raised = (/^\d{4}-\d{2}-\d{2}$/.test(p.raised_on || '') && p.raised_on <= londonDateOf(new Date()) ? p.raised_on : null)
    || analysis.sent_on || londonDateOf(new Date(em.received_at));
  // Marked To check only where something was a guess (complaintRules.js#ownEmailCheckReasons):
  // a colleague's own clear complaint email sets up nothing to look over.
  const toCheck = ownEmailCheckReasons({
    confidence: p.confidence, orgOnFile, quote: p.complaint_evidence?.quote,
    ownWords: ownText(em.body_text || em.body_preview || ''), raisedOn: raised,
    sentOn: analysis.sent_on || londonDateOf(new Date(em.received_at)),
  });
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
    {
      by: AUTO_BY,
      needsCheck: toCheck.length > 0,
      raisedNote: `Complaint created automatically from your email "${em.subject || '(no subject)'}".` +
        (toCheck.length ? ` Please check the details: ${toCheck.join('; ')}.` : ' Nothing in it was a guess (the email makes the complaint in its own words, on the day it was sent, to an organisation already on file), so it isn\'t marked To check.'),
    },
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
        -- not one being read and filed right now
        AND (processing_at IS NULL OR processing_at < now() - interval '15 minutes')
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
// Emails waiting for a person that the rules now file by themselves: routine
// correspondence, emails on a finished part, a second copy of a recorded
// response. ONLY those that change nothing are filed (never a date), each
// from the reading already made (no AI). Run once at start-up.
const ROUTINE_BY = 'Automatic (routine correspondence: nothing in it changes a date)';
export async function settleRoutineEmails() {
  const { planFromAnalysis, couldChangeDate } = await import('./emailAnalysis.js');
  // Put back for a person: an email this tidy filed away on a complaint with
  // more than one organisation, not tied to either, that could set a date
  // (an acknowledgement or response of the other organisation would have
  // been lost). Nothing was recorded from them, so nothing to undo.
  const filed = (await query(
    `SELECT e.id, e.subject, e.body_text, e.body_preview, e.analysis FROM complaint_emails e
      WHERE e.reviewed_by = $1 AND e.party_id IS NULL AND e.applied IS NULL AND e.analysis IS NOT NULL
        AND EXISTS (SELECT 1 FROM complaint_parties p WHERE p.complaint_id = e.complaint_id)`,
    [ROUTINE_BY],
  )).rows;
  for (const e of filed) {
    if (e.analysis.kind === 'our_email' || !couldChangeDate(e.analysis, `${e.subject || ''}\n${e.body_text || e.body_preview || ''}`)) continue;
    await query(
      `UPDATE complaint_emails SET reviewed_at = NULL, reviewed_as = NULL, reviewed_by = NULL WHERE id = $1 AND reviewed_by = $2`,
      [e.id, ROUTINE_BY],
    );
  }
  const ourDomain = String(config.complaintEmail.domain || '').toLowerCase();
  const rows = (await query(
    `SELECT e.id, e.subject, e.body_text, e.body_preview, e.analysis, e.party_id, e.complaint_id, e.sender_email
       FROM complaint_emails e
      WHERE e.reviewed_at IS NULL AND e.direction <> 'outbound' AND e.complaint_id IS NOT NULL AND e.analysis IS NOT NULL`,
  )).rows;
  let n = 0;
  for (const e of rows) {
    const track = e.party_id
      ? (await query('SELECT * FROM complaint_parties WHERE id = $1', [e.party_id])).rows[0]
      : (await query('SELECT * FROM complaints WHERE id = $1', [e.complaint_id])).rows[0];
    if (!track) continue;
    const others = e.party_id ? 1 : Number((await query('SELECT count(*) FROM complaint_parties WHERE complaint_id = $1', [e.complaint_id])).rows[0].count);
    const plan = planFromAnalysis(track, e.analysis, {
      text: `${e.subject || ''}\n${e.body_text || e.body_preview || ''}`,
      // Certainly this part's: recorded against it, or the only organisation.
      soleTrack: Boolean(e.party_id) || others === 0,
      // One of ours (a colleague's chaser) waiting from before this rule.
      ownEmail: isOurOwnEmail(e, e.analysis, ourDomain),
    });
    if (!plan.auto || Object.keys(plan.changes || {}).length || plan.event) continue;
    const r = await query(
      `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = 'correspondence', reviewed_by = $2
        WHERE id = $1 AND reviewed_at IS NULL`,
      [e.id, ROUTINE_BY],
    );
    n += r.rowCount;
  }
  return n;
}

// For tests: record an email with a reading already made (no AI).
export const _applyEmailForTest = (em, analysis) => applyEmail(em, analysis);

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
