import { Router } from 'express';
import fs from 'node:fs/promises';
import { saysAttached, staleNoReply } from '../services/draftChecks.js';
import { chooseAttachments } from '../services/docChoice.js';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam, attachmentDisposition, viewableType, isoDate } from '../lib/http.js';
import { config, complaintInboxAddress } from '../config.js';
import { signedEmail } from '../lib/emailSignature.js';
import { LANDLORD, authorityReplyDraft, landlordRequestDraft, authorityDocHere, copyOfEmail, replyPdfDescription } from '../services/authority.js';
import { can } from '../services/permissions.js';
import { removalTags, emailTracks } from '../services/trackContact.js';
import { evidenceChecklist } from '../services/complaintEvidence.js';
import { zipStore, safeName } from '../lib/zip.js';
import { todayISO, londonDateOf } from '../lib/dates.js';
import { plural } from '../lib/words.js';
import { buildUpdateSet } from '../lib/sql.js';
import { requireAuth, requirePermission, sessionOrCronKey } from '../middleware/auth.js';
import { describeChanges, theOmbudsman, trackOpen, isStage2Request, readable, procedureOnFile, missedStage2Requests, ukDate, referralOpen, computeOmbudsmanFrom, awaitingFirstEmail, usesComplaintWord } from '../services/complaintRules.js';
import { overallState, tracksOf } from '../services/complaintParties.js';
import { openBounces } from '../services/bounces.js';
import { undoRecheck, startRecheck, recheckStatus, startComplaintRecheck, recheckProgressOf, offEmail, keptDomainsFor } from '../services/complaintRecheck.js';
import { decorate, decorateMany, gatherContext, listEvents, tracksForReview } from '../services/complaintContext.js';
import { referenceLines, withReferences } from '../lib/references.js';
import { createComplaint } from '../services/complaintCreate.js';
import { processEmail, undoEmail, fileWaitingEmails } from '../services/complaintEmailProcessor.js';
import { watchMailboxes } from '../services/mailWatch.js';
import { getSetting, setSetting, watchedMailboxes, mailboxAllowed, allowedMailboxList } from '../services/settings.js';
import { backfillAccountNumbers, searchAccountEmails, searchStatus, searchNow, dropDigitSlips } from '../services/accountNumbers.js';
import { startScan, scanStatus, importInBackground, linkInBackground, setAutoImport, runAutoImport, skipCandidate, onFileFor, autoPlan, importsPaused, relatedSkipped } from '../services/pastComplaints.js';
import { findExistingComplaint, groupCandidates, mergeExtracted, sameIssue, matchOrgName, findOrgByName, sameAccount, sameOrgName, PARTY_COLS } from '../services/orgMatch.js';
import { tidySuggestions, mergeComplaints, mergeOrganisations } from '../services/tidy.js';
import { refreshReview, scheduleReview, cancelScheduledReview } from '../services/complaintReview.js';
import { startFormalComplaint } from '../services/complaintFormal.js';
import { ruleForComplaint, recomputeDeadlines, recomputePartyDeadlines } from '../services/complaintDeadlines.js';
import { fetchMailboxMessages, emailConfigured } from '../services/graphMail.js';
import { lookFrom, nextCheckpoint } from '../services/mailCheckpoint.js';
import {
  ingestEmails,
  listComplaintEmails,
  recordOutboundEmail,
} from '../services/emailIngest.js';
import {
  assistComplaint,
  classifyComplaintStatus,
  draftReferralGrounds,
  parseImportedComplaint,
} from '../services/complaintAssistant.js';
import { sendMail, fromAddress, withExternalCc } from '../services/mailer.js';
import { signEmail, ensureSignOff, gapIn } from '../lib/signature.js';
import {
  listAttachments,
  attachmentTexts,
  saveAttachment,
  getAttachment,
  deleteAttachment,
  attachmentUpload,
  attachmentBlocks,
  procedureMemoryUpload,
  saveAttachmentBuffer,
} from '../services/attachments.js';
import { textPdf } from '../lib/pdf.js';
import { copyText } from '../services/emailCopies.js';
import { contentFor } from '../services/invoiceExtract.js';

const router = Router();
// Every :id route on this router is a UUID primary key — reject anything else
// with a clean 400 instead of a raw Postgres "invalid input syntax" 500.
// (Attachments use a separate :attId param, validated individually below —
// this doesn't cover those.)
router.param('id', requireUuidParam);

// Who did it, for the record kept on the timeline.
const who = (req) => req.user?.name || req.user?.email || null;

// One organisation's track on a complaint: the main one (the complaint row)
// when no party is named, or a further organisation's (complaint_parties,
// migration 029). The step routes below work on either the same way.
async function loadTrack(complaintId, partyId) {
  const complaint = (await query('SELECT * FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!complaint) throw new HttpError(404, 'Complaint not found');
  if (!partyId) return { complaint, party: null, row: complaint, table: 'complaints' };
  const party = (await query(
    'SELECT * FROM complaint_parties WHERE id = $1 AND complaint_id = $2', [partyId, complaintId],
  )).rows[0];
  if (!party) throw new HttpError(404, 'That organisation isn’t on this complaint');
  return { complaint, party, row: party, table: 'complaint_parties' };
}

const recomputeTrack = (t) =>
  (t.party ? recomputePartyDeadlines(t.party.id) : recomputeDeadlines(t.complaint.id));

// The complaint is open while any organisation's track is (complaintParties.js).
async function settleOverall(complaintId) {
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) return;
  const parties = (await query('SELECT * FROM complaint_parties WHERE complaint_id = $1', [complaintId])).rows;
  const state = overallState(c, parties);
  if (state !== c.state) {
    await query(
      `UPDATE complaints SET state = $2,
              closed_on = CASE WHEN $2 = 'open' THEN closed_on ELSE COALESCE(closed_on, $3::date) END
        WHERE id = $1`,
      [complaintId, state, todayISO()],
    );
  }
}

// Other open complaints about the same account (one account, one complaint):
// shown on the complaint with a Combine button, and checked before a supplier
// is added, so the same account never runs as two complaints.
const dayOf = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ? String(v).slice(0, 10) : null);

async function sameAccountComplaints(c) {
  const others = (await query(
    `SELECT c.id, c.ref_code, c.subject, c.org_name, c.raised_on, c.reference, c.account_numbers, c.needs_check, ${PARTY_COLS}
       FROM complaints c WHERE c.state = 'open' AND c.id <> $1`,
    [c.id],
  )).rows;
  const me = (await query(`SELECT c.*, ${PARTY_COLS} FROM complaints c WHERE c.id = $1`, [c.id])).rows[0] || c;
  return others.filter((o) => sameAccount(me, o)).map((o) => ({
    id: o.id, ref_code: o.ref_code, subject: o.subject, raised_on: o.raised_on,
    org_names: [o.org_name, ...(o.party_names || [])],
  }));
}

async function decoratedById(id) {
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  if (!c) throw new HttpError(404, 'Complaint not found');
  return decorate({ ...c, recheck_progress: recheckProgressOf(c) });
}


const ORG_TYPES = [
  'council', 'housing_association', 'water', 'energy', 'managing_agent', 'debt_collector', 'supplier', 'other',
];

// A calendar date as the app stores it. Checked here so a malformed value is a
// clean 400 rather than a Postgres error.

const input = z.object({
  organisation_id: z.string().uuid().optional().nullable(),
  org_name: z.string().min(1),
  org_type: z.enum(ORG_TYPES).optional(),
  reference: z.string().optional().nullable(),
  our_reference: z.string().optional().nullable(),
  account_numbers: z.array(z.string().trim().min(1).max(40)).max(6).optional(),
  property: z.string().optional().nullable(),
  subject: z.string().min(1),
  category: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  channel: z.enum(['email', 'phone', 'portal', 'letter', 'other']).optional(),
  raised_on: isoDate,
  // Logged before it has been sent to them: the page then offers to draft
  // and send it, and it runs from the day it goes.
  not_sent_yet: z.boolean().optional(),
  // Logged as already sent, but the email it was logged from doesn't ask for
  // a complaint using the word "complaint" (or none was checked): why, so the
  // complaint is flagged as not raised (complaint_doubt) until a person
  // answers it.
  not_raised: z.string().trim().min(1).max(500).optional().nullable(),
  response_due: isoDate.optional().nullable(), // override
  // Set when importing an existing complaint at a known stage.
  stage: z.enum(['stage_1', 'stage_2', 'ombudsman']).optional(),
  // When the current stage's clock started (the Stage 2 request date).
  stage_started_on: isoDate.optional().nullable(),
  acknowledged_on: isoDate.optional().nullable(),
  responded_on: isoDate.optional().nullable(),
  final_response_on: isoDate.optional().nullable(),
  imported: z.boolean().optional(),
  // For the ombudsman: what we want them to do, and what it has cost.
  outcome_wanted: z.string().trim().max(2000).optional().nullable(),
  losses: z.string().trim().max(2000).optional().nullable(),
});

// --- Email fetch (cron-accessible: session OR cron key) --------------------
// Defined before the requireAuth guard below so the cron can call it with a key.
router.post(
  '/email/fetch',
  sessionOrCronKey('complaints'),
  asyncHandler(async (_req, res) => {
    // One check at a time: a slow one (many AI reads) must not overlap the
    // next five-minute check, which would read the same emails again.
    if (fetchRunning) return res.status(202).json({ skipped: 'A check is already running.' });
    fetchRunning = true;
    try {
      await fetchNow(res);
    } finally {
      fetchRunning = false;
    }
  }),
);
let fetchRunning = false;
async function fetchNow(res) {
  {
    const started = new Date().toISOString();
    const errors = [];
    // 1. The catch-all: complaint addresses and the general inbox.
    let r = { fetched: 0, inserted: 0, matched: 0, ids: [] };
    try {
      // From where the last look got to (the first look: the lookback window).
      const checkpoint = await getSetting('catchall_since');
      const lookStarted = new Date();
      const got = await fetchMailboxMessages(lookFrom(checkpoint, (config.ms.lookbackDays || 14) * 86400000));
      r = await ingestEmails(got.items, { mailbox: config.ms.mailbox || null });
      errors.push(...(r.errors || []).map((e) => `catch-all: ${e}`));
      const next = nextCheckpoint({ started: lookStarted, complete: got.complete && !r.stoppedAt, readTo: got.readTo, stoppedAt: r.stoppedAt });
      if (next && config.ms.enabled) await setSetting('catchall_since', next);
      if (!got.complete && !r.stoppedAt) errors.push('catch-all: more new mail than one check reads; the rest is read next time');
    } catch (err) {
      errors.push(`catch-all: ${err.message}`);
    }
    // 2. The watched mailboxes (accounts@): replies in known threads, mail
    //    from organisations we have complaints with, and new complaints of ours.
    let w = { mailboxes: [], fetched: 0, ids: [], errors: [] };
    try {
      w = await watchMailboxes();
      errors.push(...(w.errors || []));
    } catch (err) {
      errors.push(`watching: ${err.message}`);
    }
    // 3. Read, file and record each new one. One at a time: each may be a
    //    round trip to the mailbox and the AI, and none may be lost to a
    //    failure in another.
    // Emails that couldn't be read in full, or that the AI couldn't read, in
    // the last few days: tried again (a few each time) until they go through.
    const retry = (await query(
      `SELECT id FROM complaint_emails
        WHERE analysis_error IS NOT NULL AND analysed_at IS NULL AND reviewed_at IS NULL
          AND attempts < 6 AND created_at > now() - interval '3 days'
        ORDER BY created_at LIMIT 10`,
    )).rows.map((x) => x.id);
    let processed = 0;
    let filed = 0;
    for (const id of [...r.ids, ...w.ids, ...retry]) {
      try {
        const out = await processEmail(id);
        processed += 1;
        if (out?.filed) filed += 1;
      } catch (err) {
        console.error(`[complaints] email ${id} not processed:`, err.message);
      }
    }
    // Anything waiting to be filed that now clearly belongs to a complaint
    // (same thread, or same account number): filed and read against it.
    try {
      filed += await fileWaitingEmails();
    } catch (err) {
      errors.push(`filing waiting emails: ${err.message}`);
    }
    const result = {
      at: started, ok: errors.length === 0, errors: errors.slice(0, 5),
      fetched: r.fetched + w.fetched, stored: r.ids.length + w.ids.length, processed, filed,
      configured: emailConfigured(), watching: w.mailboxes,
    };
    await setSetting('email_last_check', result).catch(() => {});
    // Anything found in the past that automatic import hasn't dealt with yet
    // (one query when there is nothing waiting). In the background: the check
    // itself is answered now.
    // Account numbers first (what everything is matched on), then import.
    backfillAccountNumbers()
      .catch((err) => console.error('[complaints] account numbers:', err.message))
      .then(() => searchAccountEmails().catch((err) => console.error('[complaints] account search:', err.message)))
      .then(() => runAutoImport())
      .catch((err) => console.error('[complaints] automatic import:', err.message));
    // The morning's half-price review batch, applied once it has been answered.
    import('../services/complaintReview.js')
      .then(({ collectReviewBatch }) => collectReviewBatch())
      .then((b) => b?.applied != null && console.log(`[complaints] morning review batch: ${b.applied} applied, ${b.superseded} already newer, ${b.retried} reviewed directly instead`))
      .catch((err) => console.error('[complaints] review batch:', err.message));
    res.json({ ...result, inserted: r.inserted, matched: r.matched });
  }
}

// Everything below this line requires a logged-in session.
router.use(requireAuth, requirePermission('complaints'));

// Is the mailbox integration configured? (for the UI)
router.get(
  '/email/config',
  asyncHandler(async (_req, res) => {
    res.json({
      enabled: emailConfigured(),
      mailbox: config.ms.mailbox || null,
      inbox: complaintInboxAddress(),
      ai: config.anthropic.enabled,
    });
  }),
);

// Is the AI assistant configured? (for the UI)
router.get(
  '/ai/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: config.anthropic.enabled });
  }),
);

// AI assistant: analyse the complaint + logged emails (+ pasted context) and
// draft the next email + steps. Does not send anything.
const assistInput = z.object({
  instruction: z.string().max(4000).optional().nullable(),
  context: z.string().max(20000).optional().nullable(),
});

router.post(
  '/:id/assist',
  asyncHandler(async (req, res) => {
    const d = parse(assistInput, req.body);
    const ctx = await gatherContext(req.params.id, d.context);
    const result = await assistComplaint({ ...ctx, feature: 'Complaint assistant (asked)', instruction: d.instruction });
    res.json(result);
  }),
);

// Send a complaint email from the app (SMTP2GO). Auto-CCs the complaint's own
// address so the reply logs back, and records the sent email on the timeline.
// Documents of this complaint to attach to an email (the summons, the bill…).
const attachmentIdsInput = z.array(z.string().uuid()).max(20).optional().nullable();
const sendInput = z.object({
  attachment_ids: attachmentIdsInput,
  to: z.string().min(3),
  cc: z.string().optional().nullable(),
  subject: z.string().min(1),
  body: z.string().min(1),
  // The email IS the Stage 2 request: sending it escalates the complaint, in
  // the same press (dated today).
  then: z.enum(['escalate']).optional().nullable(),
  // The organisation it is to, with more than one on the complaint: its
  // part is the one escalated, and the email is recorded as sent to them.
  party_id: z.string().uuid().optional().nullable(),
});

// A permissive-but-real email check. Rejects addresses with CR/LF (header
// injection) and obviously malformed values before they reach the mail
// transport.
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
function parseRecipients(raw) {
  const list = (raw || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const addr of list) {
    if (!EMAIL_RE.test(addr)) throw new HttpError(400, `Invalid email address: ${addr}`);
  }
  return list;
}

// Queue an email on a complaint, refusing it (409) when `guard` finds one
// already there. The check and the insert run under a lock on the complaint,
// so two presses at once (two tabs, a retried request) can't both pass the
// check and send it twice.
async function queueOutbox(complaintId, { guard, refusal }, insertSql, params) {
  const client = await pool.connect();
  let row;
  try {
    await client.query('BEGIN');
    await client.query(`SELECT pg_advisory_xact_lock(hashtext('complaint_outbox:' || $1))`, [complaintId]);
    if ((await client.query(guard.sql, guard.params)).rows[0]) throw new HttpError(409, refusal);
    row = (await client.query(insertSql, params)).rows[0];
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  setImmediate(() => deliverOutbox(row.id).catch((err) => console.error('[outbox]', err.message)));
  return row;
}

// Sending runs in the background: the page is answered as soon as the email
// is checked and queued (complaint_outbox), and doesn't wait on the mail
// server. Once it has gone it is recorded on the complaint and, when it was
// the Stage 2 request, the complaint is escalated. A failure stays on the
// complaint with Try again / Discard.
router.post(
  '/:id/send-email',
  asyncHandler(async (req, res) => {
    const d = parse(sendInput, req.body);
    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Complaint not found');
    const complaint = await decorate(rows[0]);
    // Checked before anything is queued, so an email never goes out for a
    // step that then can't be recorded.
    const party = d.party_id ? (complaint.parties || []).find((p) => p.id === d.party_id) : null;
    if (d.party_id && !party) throw new HttpError(400, 'That organisation isn’t on this complaint.');
    if (d.then === 'escalate' && (party || complaint).stage !== 'stage_1') {
      throw new HttpError(400, `Only ${party ? `${party.org_name}'s part` : 'a complaint'} at Stage 1 can be escalated to Stage 2 this way.`);
    }
    if (!config.smtp.enabled) throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');

    const to = parseRecipients(d.to);
    const cc = parseRecipients(d.cc);
    if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
    // Always CC the complaint's own address so the thread self-logs, and
    // Greenco's own copy address (utilities@) so there is a copy in the
    // mailbox. Added here so the copy recorded on the complaint says so too.
    if (complaint.email_address && !cc.includes(complaint.email_address)) {
      cc.push(complaint.email_address);
    }
    for (const a of withExternalCc(to, cc)) if (!cc.includes(a)) cc.push(a);

    const attachmentIds = await checkAttachmentIds(complaint.id, d.attachment_ids, d.body);
    // Signed by whoever is sending (a draft's "[Name]" never goes out).
    const subject = signEmail(d.subject, req.user);
    const body = signEmail(d.body, req.user);
    refuseGaps(subject, body);
    // The same email to the same people, queued in the last ten minutes and
    // not failed, is a second press, not a second email.
    const out = await queueOutbox(complaint.id, {
      guard: {
        sql: `SELECT 1 FROM complaint_outbox WHERE complaint_id = $1 AND subject = $2 AND body = $3 AND to_addresses = $4
                AND status <> 'failed' AND created_at > now() - interval '10 minutes'`,
        params: [complaint.id, subject, body, to],
      },
      refusal: 'This email has just been sent (or is being sent) from this complaint, so it wasn’t sent again.',
    },
    `INSERT INTO complaint_outbox (complaint_id, party_id, to_party, to_addresses, cc_addresses, subject, body, then_escalate, sent_by, attachment_ids, sender_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
    [complaint.id, party?.id || null, Boolean(party), to, cc, subject, body, d.then === 'escalate', who(req), attachmentIds, req.user?.id || null]);
    res.status(202).json({ queued: true, outbox_id: out.id, escalating: d.then === 'escalate' });
  }),
);

// --- The landlord's authority (services/authority.js) -----------------------
// The organisation said Greenco isn't authorised. With the authority on file
// (here, or on another complaint about the same account), the reply sending
// it; without, the email asking the landlord for it. Both no AI.
// "support.uw.co.uk" and "uw.co.uk" are one organisation's.
const baseDomain = (d) => {
  const parts = String(d || '').toLowerCase().split('.').filter(Boolean);
  const n = parts.length >= 3 && /^(?:co|org|ac|gov|ltd|plc|me|net|sch|nhs)$/.test(parts[parts.length - 2]) ? 3 : 2;
  return parts.slice(-n).join('.');
};
async function authorityOf(id) {
  const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Complaint not found');
  const c = await decorate(rows[0]);
  if (!c.authority) throw new HttpError(409, 'Nobody has said Greenco isn’t authorised on this complaint.');
  return c;
}

router.post(
  '/:id/authority/reply',
  asyncHandler(async (req, res) => {
    const c = await authorityOf(req.params.id);
    const a = c.authority;
    let doc;
    if (a.state === 'landlord_replied') {
      // Their reply IS the authority (the draft asked for "a reply saying
      // so"): a PDF of their email, kept as a document, goes with it.
      const em = (await query('SELECT * FROM complaint_emails WHERE id = $1 AND complaint_id = $2', [a.reply_email_id, c.id])).rows[0];
      if (!em) throw new HttpError(409, 'The landlord’s reply couldn’t be found.');
      // All of it, our request they answered included (their "yes" means
      // nothing without it); only a confidentiality notice is taken out.
      const full = em.body_text || em.body_preview || '';
      const body = copyOfEmail(full) || full;
      const day = ukDate(londonDateOf(new Date(em.received_at)));
      doc = await saveAttachmentBuffer(c.id, {
        filename: `Landlord authority - email of ${day.slice(4)}.pdf`,
        mimetype: 'application/pdf',
        buffer: textPdf({ title: `The landlord's email of ${day}`, text: copyText([em], [body]) }),
      }, em.id, { description: replyPdfDescription(day) });
    } else if (a.state === 'on_file') {
      doc = await authorityDocHere(c.id, a.doc);
    } else {
      throw new HttpError(409, 'There is no authority on file to send: ask the landlord for it.');
    }
    if (!doc) throw new HttpError(409, 'The authority document couldn’t be found. Upload it to this complaint.');
    const track = a.party_id ? c.parties.find((p) => p.id === a.party_id) : c;
    const asked = (await query('SELECT subject, sender_email FROM complaint_emails WHERE id = $1', [a.asked_email_id])).rows[0];
    const draft = authorityReplyDraft(c, track, a);
    // In their thread: "Re:" the email that asked.
    const base = asked?.subject ? `Re: ${String(asked.subject).replace(/^\s*(re|fw|fwd)\s*:\s*/i, '')}` : draft.subject;
    // Our reference too, as every email from a complaint carries, so their
    // reply files itself even if they drop the copied-in address.
    const subject = base.toUpperCase().includes(c.ref_code.toUpperCase()) ? base : `${base} [${c.ref_code}]`;
    res.json({ ...draft, subject, attachment_ids: [doc.id], party_id: a.party_id || null });
  }),
);

router.post(
  '/:id/authority/landlord-draft',
  asyncHandler(async (req, res) => {
    const c = await authorityOf(req.params.id);
    const track = c.authority.party_id ? c.parties.find((p) => p.id === c.authority.party_id) : c;
    const name = String(req.body?.landlord_name || c.landlord_name || '').trim() || null;
    res.json({ ...landlordRequestDraft(c, track, c.authority, name), to: c.landlord_email || '', landlord_name: name || '' });
  }),
);

const landlordInput = z.object({
  landlord_name: z.string().trim().min(1, 'The landlord’s name is needed.').max(200),
  to: z.string().min(3),
  cc: z.string().optional().nullable(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(20000),
});
router.post(
  '/:id/authority/landlord',
  asyncHandler(async (req, res) => {
    const d = parse(landlordInput, req.body);
    if (!config.smtp.enabled) throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
    const c = await authorityOf(req.params.id);
    const to = parseRecipients(d.to);
    if (to.length !== 1) throw new HttpError(400, 'Give the landlord’s one email address.');
    // The landlord's address files everything to and from it as landlord
    // correspondence: never one of ours, or the organisation's (their
    // emails would stop being read as theirs).
    const addr = to[0].toLowerCase();
    const dom = addr.split('@')[1] || '';
    const ours = String(config.complaintEmail.domain || '').toLowerCase();
    const orgAddrs = [c, ...(c.parties || [])].map((t) => String(t.org_email || '').toLowerCase()).filter(Boolean);
    const theirs = (await query(
      `SELECT DISTINCT lower(sender_email) AS a FROM complaint_emails
        WHERE complaint_id = $1 AND direction <> 'outbound' AND removed_org IS NULL AND sender_email IS NOT NULL
          AND analysis->>'from_organisation' = 'true'`, [c.id],
    )).rows.map((x) => x.a).filter((x) => !x.endsWith(`@${ours}`));
    const PUBLIC = /^(gmail|googlemail|hotmail|outlook|live|msn|yahoo|ymail|icloud|me|mac|aol|btinternet|sky|virginmedia|talktalk|protonmail|proton|gmx|mail)\./;
    if ((ours && dom === ours) || orgAddrs.includes(addr) || theirs.includes(addr) ||
      (!PUBLIC.test(dom) && [...orgAddrs, ...theirs].some((x) => baseDomain(x.split('@')[1]) === baseDomain(dom)))) {
      throw new HttpError(400, `${addr} is ${ours && dom === ours ? 'a Greenco address' : 'the organisation’s address'}, not the landlord’s.`);
    }
    const cc = parseRecipients(d.cc);
    const subject = signEmail(d.subject, req.user);
    const body = signEmail(d.body.replace(/\[\s*landlord(?:['’]s)?\s+name\s*\]/gi, () => d.landlord_name), req.user);
    refuseGaps(subject, body);
    // Their reply comes back to the complaint's own address, and is known
    // as the landlord's by this address.
    if (c.email_address && !cc.includes(c.email_address)) cc.push(c.email_address);
    await query('UPDATE complaints SET landlord_name = $2, landlord_email = $3 WHERE id = $1', [c.id, d.landlord_name, to[0].toLowerCase()]);
    const out = await queueOutbox(c.id, {
      guard: {
        sql: `SELECT 1 FROM complaint_outbox WHERE complaint_id = $1 AND to_landlord AND status IN ('pending', 'sending')`,
        params: [c.id],
      },
      refusal: 'An email to the landlord is already being sent from this complaint.',
    },
    `INSERT INTO complaint_outbox (complaint_id, to_addresses, cc_addresses, subject, body, sent_by, to_landlord, sender_id)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
    [c.id, to, cc, subject, body, who(req), req.user?.id || null]);
    res.status(202).json({ queued: true, outbox_id: out.id });
  }),
);

// "Already sorted" (they confirmed by phone, the landlord called them…):
// the request is settled, with a note on the timeline. A later email from
// them saying it again opens it again.
router.post(
  '/:id/authority/done',
  asyncHandler(async (req, res) => {
    const c = await authorityOf(req.params.id);
    const how = String(req.body?.note || '').trim().slice(0, 500);
    await query('UPDATE complaints SET authority_done_on = $2 WHERE id = $1', [c.id, todayISO()]);
    await query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
      [c.id, c.authority.party_id || null, todayISO(),
        `Authority on the account sorted${how ? `: ${how}` : '.'}`, who(req)],
    );
    scheduleReview(c.id);
    res.json(await decoratedById(c.id));
  }),
);

// Documents of the complaint chosen to go with an email. Checked when it is
// queued (they are this complaint's, and fit in one email), so a person hears
// at once rather than from a failed send; read from disk when it goes.
const EMAIL_ATTACH_BYTES = 14 * 1024 * 1024; // ~19 MB once encoded for email
async function checkAttachmentIds(complaintId, ids, body = '') {
  const want = [...new Set(ids || [])];
  // An email that says something is attached never goes without it.
  if (!want.length && saysAttached(body)) {
    throw new HttpError(400, 'The message says something is attached, but no documents are chosen: tick them under “Attach documents” (or upload them to the complaint first), or take that line out.');
  }
  if (!want.length) return [];
  const rows = (await query(
    'SELECT id, filename, size_bytes FROM complaint_attachments WHERE complaint_id = $1 AND id = ANY($2::uuid[])',
    [complaintId, want],
  )).rows;
  if (rows.length !== want.length) throw new HttpError(400, 'One of the documents chosen isn’t on this complaint any more: reload and choose again.');
  const total = rows.reduce((n, r) => n + (Number(r.size_bytes) || 0), 0);
  if (total > EMAIL_ATTACH_BYTES) {
    throw new HttpError(400, `The documents chosen come to ${(total / 1048576).toFixed(1)} MB, more than one email can carry (14 MB): leave some out and send them in a second email.`);
  }
  return want;
}
// The files themselves, in the order chosen. A file that can't be read stops
// the send (it would otherwise go without it, saying it was attached).
async function chosenAttachments(complaintId, ids) {
  const rows = (await query(
    'SELECT id, filename, mimetype, storage_path FROM complaint_attachments WHERE complaint_id = $1 AND id = ANY($2::uuid[])',
    [complaintId, ids],
  )).rows;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = [];
  for (const id of ids) {
    const r = byId.get(id);
    if (!r) throw new Error('a document chosen to go with it has been deleted from the complaint since');
    try {
      out.push({ filename: r.filename, content: await fs.readFile(r.storage_path), ...(r.mimetype ? { contentType: r.mimetype } : {}) });
    } catch {
      throw new Error(`the document "${r.filename}" couldn’t be read from storage`);
    }
  }
  return out;
}
// "Attached: …" before the sign-off, where a reader expects it; built from the
// body as written, so a Try again after a failure never adds it twice.
function withAttachedLine(body, names, extra = '') {
  const clean = body.replace(/\n*Attached: [^\n]*(\n|$)/, '\n');
  const listed = `Attached: ${names.join('; ')}.${extra}`;
  const at = clean.search(/\n(Kind regards|Yours sincerely|Yours faithfully|Many thanks|Regards),?\s*\n/i);
  return at >= 0 ? `${clean.slice(0, at).trimEnd()}\n\n${listed}\n${clean.slice(at)}` : `${clean.trimEnd()}\n\n${listed}`;
}

// Sending an email of ours again (it went without its documents, say):
// the same people, subject and message, with a line at the top saying why it
// has come again, and the complaint's documents ticked when the message says
// something is attached. Nothing is sent here; it opens in the Send window.
// A "no reply" to something sent only days ago is pointed out (caution).
// A POST: choosing the documents is a paid AI call, so it needs edit access.
router.post(
  '/:id/emails/:emailId/resend',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) throw new HttpError(400, 'Invalid email id');
    const em = (await query(
      `SELECT id, subject, body_text, body_preview, to_addresses, party_id, direction, received_at
         FROM complaint_emails WHERE id = $1 AND complaint_id = $2`, [req.params.emailId, req.params.id],
    )).rows[0];
    if (!em) throw new HttpError(404, 'Email not found');
    if (em.direction !== 'outbound') throw new HttpError(400, 'Only an email sent from here can be sent again.');
    // Their addresses only: ours (the complaint's own address, utilities@)
    // are copied in again by the send itself.
    const ours = String(config.complaintEmail.domain || '').toLowerCase();
    const to = (em.to_addresses || []).filter((a) => {
      const x = String(a).toLowerCase();
      return x && !x.endsWith(`@${ours}`);
    });
    const sentOn = em.received_at ? londonDateOf(new Date(em.received_at)) : null;
    const which = sentOn === todayISO()
      ? 'our email from earlier today'
      : sentOn
        ? `our email of ${new Date(`${sentOn}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })}`
        : 'our earlier email';
    const original = String(em.body_text || em.body_preview || '').replace(/\n*Attached: [^\n]*(\n|$)/, '\n');
    // The AI chooses which documents go, from what each one is.
    let choice = { ids: [], why: null };
    try {
      choice = await chooseAttachments(req.params.id, { subject: em.subject || '', body: original });
    } catch (err) {
      console.error('[documents] choosing:', err.message);
    }
    const attachmentIds = choice.ids;
    const why = attachmentIds.length
      ? `We are sending ${which} again below, as the documents did not come through with it.`
      : `We are sending ${which} again below.`;
    const greet = original.match(/^\s*((?:Dear|Hello|Hi|Good (?:morning|afternoon))[^\n]*,?)\s*\n/i);
    const body = greet
      ? `${greet[1]}\n\n${why}\n\n${original.slice(greet[0].length).trimStart()}`
      : `${why}\n\n${original.trimStart()}`;
    const stale = staleNoReply(original, todayISO());
    res.json({
      to: to.join(', '),
      subject: em.subject || '',
      body,
      party_id: em.party_id || null,
      attachment_ids: attachmentIds,
      attach_why: choice.why,
      caution: stale
        ? `This says they haven't replied to something sent on ${ukDate(stale.date)}, only days ago: take that out before sending ("${stale.sentence}").`
        : null,
    });
  }),
);

// The Send window opened with a message that says something is attached and
// nothing chosen (a draft written before its documents were kept, or one
// typed by hand): the AI picks them from each document's label, one small
// text-only call, so the person never has to hunt for them. A POST: it is a
// paid call, so it needs edit access. Nothing is sent or saved.
const chooseInput = z.object({ subject: z.string().max(1000).optional().default(''), body: z.string().min(1).max(50000) });
router.post(
  '/:id/choose-attachments',
  asyncHandler(async (req, res) => {
    const { subject, body } = parse(chooseInput, req.body);
    if (!config.anthropic.enabled) return res.json({ ids: [], why: null });
    res.json(await chooseAttachments(req.params.id, { subject, body }));
  }),
);

function refuseGaps(...texts) {
  const gap = gapIn(...texts);
  if (gap) throw new HttpError(400, `The email still has a gap to fill in: ${gap}. Fill it in or take it out, then send it.`);
}

// An email signed in full for the person who sent it: their details as they
// are now (one lookup). No sender (queued before signatures, or the
// signature switched off): the email goes as written.
export async function signedForSender(body, senderId) {
  if (!config.signature.enabled || !senderId) return { text: body, html: undefined, attachments: [] };
  const user = (await query(
    'SELECT name, email, job_title, post_nominals, direct_line, office_phone, mobile FROM users WHERE id = $1 AND active', [senderId],
  )).rows[0];
  // Deactivated (or deleted) since pressing Send: their numbers and address
  // are no longer Greenco's to give out, so it goes as written.
  if (!user) return { text: body, html: undefined, attachments: [] };
  return signedEmail(body, user || null, { links: config.signature.links });
}

// Send one queued email, then record it and take the step it was. Claimed
// by one statement (pending → sending), so it is never sent twice.
export async function deliverOutbox(outboxId) {
  const o = (await query(
    `UPDATE complaint_outbox SET status = 'sending', claimed_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [outboxId],
  )).rows[0];
  if (!o) return;
  let sent;
  try {
    // A referral carries the evidence; the files that didn't fit are named in
    // the email itself, and the body kept is exactly the one that went.
    let attachments;
    if (o.attach_evidence) {
      const r = await referralAttachments(o.complaint_id, o.party_id || null);
      // Built from the body as written: a Try again after a failure must not
      // add the list a second time.
      o.body = o.body.replace(/\n*Attached: [^\n]*(\n|$)/, '\n');
      attachments = r.attachments;
      o.body = withAttachedLine(o.body, attachments.map((x) => x.filename),
        r.left.length ? ` Too large to email together, and available on request: ${r.left.join('; ')}.` : '');
      await query('UPDATE complaint_outbox SET body = $2 WHERE id = $1', [o.id, o.body]);
    } else if ((o.attachment_ids || []).length) {
      // The documents a person chose to send with it.
      attachments = await chosenAttachments(o.complaint_id, o.attachment_ids);
      o.body = withAttachedLine(o.body, attachments.map((x) => x.filename));
      await query('UPDATE complaint_outbox SET body = $2 WHERE id = $1', [o.id, o.body]);
    }
    // The last check before it goes: a gap never reaches them (an email
    // queued before the check at Send, or retried).
    const gap = gapIn(o.subject, o.body);
    if (gap) throw new Error(`Not sent: the email still has a gap to fill in, ${gap}. Discard it and send it again with the gap filled.`);
    // Signed in full by the person who pressed Send (lib/emailSignature.js):
    // the short sign-off in the body is replaced by their signature.
    const signed = await signedForSender(o.body, o.sender_id);
    sent = await sendMail({
      to: o.to_addresses, cc: o.cc_addresses, subject: o.subject, text: signed.text, html: signed.html,
      attachments: [...(attachments || []), ...signed.attachments],
    });
  } catch (err) {
    // The mail server refused it outright, so it certainly didn't go (a
    // Try again after a restart that may have sent it included): no "It
    // went" beside it.
    await persistStatus(o.id,
      `UPDATE complaint_outbox SET status = 'failed', uncertain = false, error = $2, finished_at = now() WHERE id = $1`,
      [o.id, String(err.message || err).slice(0, 500)]);
    return;
  }
  await afterSent(o, sent?.messageId || null);
}

// A status write that must not be lost: a row left at "sending" shows as
// sending until the next restart, which then offers Try again on an email
// that may have gone. Tried a few times before giving up.
async function persistStatus(id, sql, params) {
  for (let i = 0; i < 4; i += 1) {
    try {
      await query(sql, params);
      return true;
    } catch (err) {
      console.error(`[outbox] could not update ${id}:`, err.message);
      await new Promise((r) => setTimeout(r, 500 * 2 ** i));
    }
  }
  return false;
}

// The half after the mail server has taken it: marked sent, recorded on the
// complaint, and the step it was taken. Also run by "It went" for an email
// that went although it shows as failed, so it is never sent twice; then
// `sentAt` is when it was handed to the mail server, and everything is dated
// from that, not from the day someone confirmed it.
async function afterSent(o, messageId, { sentAt = null } = {}) {
  // It has gone: from here on nothing may put it back to "not sent".
  await persistStatus(o.id,
    `UPDATE complaint_outbox SET status = 'sent', error = NULL, uncertain = false, finished_at = now() WHERE id = $1`, [o.id]);
  // Every step it takes is dated the day it actually went, not the day Send
  // was first pressed: after a failure and Try again those differ, and the
  // deadlines run from when they had it.
  const sentOn = sentAt ? londonDateOf(new Date(sentAt)) : todayISO();
  const note = (text, partyId = null) => query(
    `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
    [o.complaint_id, partyId, sentOn, text, o.sent_by],
  );
  try {
    const emailId = await recordOutboundEmail({
      complaintId: o.complaint_id,
      fromEmail: fromAddress(),
      to: o.to_addresses,
      cc: o.cc_addresses,
      subject: o.subject,
      body: o.body,
      sentBy: o.sent_by,
      messageId,
      partyId: o.party_id,
      sentAt,
      tag: o.to_landlord ? LANDLORD : null,
    });
    if (o.to_landlord) {
      // To the landlord (their authority): recorded as landlord
      // correspondence (tagged above), never as Greenco writing to the
      // organisation, and it takes no step.
      scheduleReview(o.complaint_id);
      return;
    }
    const cur = (await query('SELECT * FROM complaints WHERE id = $1', [o.complaint_id])).rows[0];
    if (o.then_supplier) {
      // Already joined some other way while this waited (added by hand, say):
      // never a second copy of them.
      const s = o.then_supplier;
      if (!(await joinSupplierOnce(o.complaint_id, s, { sentOn, emailId, subject: o.subject, by: o.sent_by }))) {
        await note(`The complaint to ${s.org_name} was sent, but they were already on this complaint by then, so nothing was added.`);
      }
      scheduleReview(o.complaint_id);
      return;
    }
    if (o.then_refer) {
      // The email IS the referral: that part is with the ombudsman from the
      // day it went (Undo on the email, as for any step it records). To an
      // organisation since taken off, or a part that has moved on: noted,
      // nothing changed.
      const track = o.to_party && !o.party_id ? null
        : o.party_id ? (await query('SELECT stage FROM complaint_parties WHERE id = $1', [o.party_id])).rows[0] : cur;
      if (track && ['stage_1', 'stage_2'].includes(track.stage)) {
        await escalateFromEmail(o.complaint_id, o.party_id || null, sentOn, o.sent_by, emailId, { to: 'ombudsman' });
      } else {
        await note(`The referral to the ombudsman was sent, but ${track ? 'that part had already moved on' : 'that organisation had been taken off the complaint'}, so nothing was changed.`, o.party_id);
      }
      scheduleReview(o.complaint_id);
      return;
    }
    // To an organisation since taken off the complaint: nothing to escalate
    // or start, and never the main organisation's part in its place.
    if (o.to_party && !o.party_id) {
      if (o.then_formal) {
        await note('The formal complaint was sent, but that organisation had been taken off the complaint, so its dates were not changed.');
      } else if (o.then_escalate || isStage2Request({ subject: o.subject, body: o.body })) {
        await note('The Stage 2 request was sent, but that organisation had been taken off the complaint, so nothing was escalated.');
      }
      scheduleReview(o.complaint_id);
      return;
    }
    if (o.then_formal) {
      // Only while the question is still open: if it was settled while this
      // waited (recorded as sent from Outlook, or "It is a complaint: keep
      // it"), starting again would wipe the dates recorded since.
      if (!(await startFormalComplaint(o.complaint_id, sentOn, o.sent_by, { subject: o.subject, fromHere: true }))) {
        await note('The formal complaint email was sent, but the complaint had already been settled as a formal complaint by then, so its dates were not changed.');
        scheduleReview(o.complaint_id);
      }
      return;
    }
    // The Stage 2 request moves the complaint on whichever button sent it:
    // "Send it and escalate" says so, and otherwise the email's own words do
    // (isStage2Request, no AI), so a plain Send can't leave it at Stage 1
    // with the review offering the same request again.
    const party = o.party_id
      ? (await query('SELECT * FROM complaint_parties WHERE id = $1', [o.party_id])).rows[0] || null
      : null;
    const atStage1 = (party || cur)?.stage === 'stage_1';
    const track = o.then_escalate
      ? (atStage1 ? { party } : null)
      : isStage2Request({ subject: o.subject, body: o.body })
        ? (o.party_id ? (atStage1 ? { party } : null) : await stage2TrackFor(o.complaint_id, o.to_addresses))
        : null;
    if (track) await escalateFromEmail(o.complaint_id, track.party?.id || null, sentOn, o.sent_by, emailId);
    else if (o.then_escalate && !atStage1) {
      await note('The Stage 2 request was sent, but it was already past Stage 1 by then, so nothing was escalated.', o.party_id);
    }
    scheduleReview(o.complaint_id);
  } catch (err) {
    // Sent, but recording it failed: said on the complaint, never re-sent.
    console.error('[outbox] sent but not recorded:', err.message);
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [o.complaint_id, todayISO(), `The email "${o.subject}" was sent, but recording it here failed (${String(err.message).slice(0, 200)}). Record the step by hand if it was one.`, 'Automatic (sending)'],
    ).catch(() => {});
  }
}

// A failed email: try again, or discard it.
router.post(
  '/:id/outbox/:outboxId/retry',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.outboxId).success) throw new HttpError(400, 'Invalid id');
    // A referral to the ombudsman is sent again only if that part is still
    // waiting to be referred: recorded as referred another way meanwhile, or
    // its organisation taken off, and the evidence must not go a second time.
    const row = (await query('SELECT then_refer, party_id, to_party FROM complaint_outbox WHERE id = $1 AND complaint_id = $2', [req.params.outboxId, req.params.id])).rows[0];
    if (row?.then_refer) {
      if (row.to_party && !row.party_id) throw new HttpError(409, 'That organisation has been taken off the complaint: discard this referral.');
      const { t } = await referralTrack(req.params.id, row.party_id || null);
      const refusal = referralRefusal(t);
      if (refusal) throw new HttpError(409, `${refusal} Discard this one rather than sending it again.`);
    }
    const r = await query(
      `UPDATE complaint_outbox SET status = 'pending', error = NULL WHERE id = $1 AND complaint_id = $2 AND status = 'failed' RETURNING id`,
      [req.params.outboxId, req.params.id],
    );
    if (!r.rows[0]) throw new HttpError(409, 'That email isn’t waiting to be tried again.');
    setImmediate(() => deliverOutbox(req.params.outboxId).catch((err) => console.error('[outbox]', err.message)));
    res.status(202).json({ queued: true });
  }),
);
// It went after all (the copy is in utilities@): record it and take its step
// without sending it again.
router.post(
  '/:id/outbox/:outboxId/went',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.outboxId).success) throw new HttpError(400, 'Invalid id');
    const o = (await query(
      `UPDATE complaint_outbox SET status = 'sending' WHERE id = $1 AND complaint_id = $2 AND status = 'failed' AND uncertain RETURNING *`,
      [req.params.outboxId, req.params.id],
    )).rows[0];
    // Only an email a restart cut short may have gone: one the mail server
    // refused certainly didn't.
    if (!o) throw new HttpError(409, 'That email isn’t waiting to be dealt with, or it certainly didn’t go (use Try again).');
    // Dated when it was handed to the mail server (rows from before that was
    // kept: when the restart found it).
    await afterSent(o, null, { sentAt: o.claimed_at || o.finished_at || null });
    res.status(204).end();
  }),
);
router.delete(
  '/:id/outbox/:outboxId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.outboxId).success) throw new HttpError(400, 'Invalid id');
    const r = await query(
      `DELETE FROM complaint_outbox WHERE id = $1 AND complaint_id = $2 AND status = 'failed' RETURNING id`,
      [req.params.outboxId, req.params.id],
    );
    if (!r.rows[0]) throw new HttpError(409, 'Only an email that failed to send can be discarded.');
    res.status(204).end();
  }),
);

// Detect whether a final response / deadlock has landed and the complaint is
// ready for the ombudsman. Persists the ombudsman_ready flag.
router.post(
  '/:id/check-status',
  asyncHandler(async (req, res) => {
    const ctx = await gatherContext(req.params.id);
    const result = await classifyComplaintStatus(ctx);
    if (result.ombudsman_ready) {
      await query('UPDATE complaints SET ombudsman_ready = true WHERE id = $1', [req.params.id]);
    }
    res.json(result);
  }),
);

// What an ombudsman will want, and what is still missing (complaintEvidence.js),
// for the complaint as the page (and the referral pack) sees it.
async function evidenceFor(c, { events, emails, attachments }) {
  const parties = c.parties || [];
  const orgIds = [c, ...parties].map((t) => t.organisation_id).filter(Boolean);
  const orgs = orgIds.length
    ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
    : [];
  const own = emails.filter((e) => !e.removed_org);
  const rows = own.map((e) => ({
    id: e.id, direction: e.direction, sender_email: e.sender_email, to_addresses: e.to_addresses, party_id: e.party_id,
    received_on: e.received_at ? londonDateOf(new Date(e.received_at)) : null, kind: e.analysis?.kind || null, sent_on: e.analysis?.sent_on || null,
  }));
  const whose = emailTracks({ complaint: c, parties, orgs, emails: rows, events: [], ourDomain: config.complaintEmail.domain });
  return evidenceChecklist({
    complaint: c,
    parties,
    emails: own.map((e) => ({
      id: e.id, subject: e.subject, party_id: e.party_id, author_org: e.analysis?.author_org || null, kind: e.analysis?.kind || null,
      ...(whose.get(e.id) || { keys: [], ours: false, on: null }),
    })),
    // Documents that came with an email of an organisation taken off the
    // complaint are that organisation's history, like the email itself.
    // The landlord's documents (their authority) are evidence, not history.
    docs: attachments.filter((a) => !a.source_email_id || !emails.some((e) => e.id === a.source_email_id && e.removed_org && e.removed_org !== LANDLORD)),
    events: events.filter((e) => !e.removed_org),
    forwardTo: c.email_address,
    today: todayISO(),
  });
}

// The referral pack's text: the facts, what we want, the evidence (on file
// and missing), the grounds (drafted by the AI, or left for the pack), the
// timeline and the correspondence log. Shared by the pack and the evidence
// download so the two can't disagree.
// An email only between Greenco addresses (a colleague forwarding it, a
// note between us): ours to read, never sent to an outside body.
function internalOnly(em) {
  const ours = String(config.complaintEmail.domain || '').toLowerCase();
  if (!ours) return false;
  const addrs = [em.sender_email, ...(em.to_addresses || [])].filter(Boolean).map((a) => String(a).toLowerCase());
  if (!addrs.length || !addrs.every((a) => a.endsWith(`@${ours}`))) return false;
  // A colleague FORWARDING in their email, or our own email sent from
  // Outlook, also travels only between our addresses, and is the evidence:
  // read as written by the organisation, or naming an outside address in
  // what it carries, it is not internal.
  if (em.analysis?.author_org || (em.analysis?.kind && em.analysis.kind !== 'our_email')) return false;
  const text = `${em.body_text || em.body_preview || ''}`.toLowerCase();
  const outside = (text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || []).some((a) => !a.endsWith(`@${ours}`));
  return !outside;
}

// `outward`: the version that goes TO the ombudsman (an emailed referral):
// the facts, what we want, the documents enclosed, the grounds, the timeline
// of steps and the correspondence log, without our own working (the
// readiness lines, the evidence checklist with its "how to fix", internal
// notes on the timeline).
async function packText(ctx, grounds, { outward = false, track = null } = {}) {
  // Referring a further organisation: ITS part leads (its name, reference and
  // dates), and the main organisation's part follows as the other one.
  const whole = ctx.complaint;
  const c = track && track.complaint_id
    ? { ...whole, ...track, rule: track.rule, label: track.label, subject: whole.subject, property: whole.property,
      account_numbers: whole.account_numbers, outcome_wanted: whole.outcome_wanted, losses: whole.losses,
      ref_code: whole.ref_code, id: whole.id,
      parties: [{ ...whole, relationship: null }, ...(whole.parties || []).filter((p) => p.id !== track.id)] }
    : whole;
  const stageWords = (st) => ({ stage_1: 'Stage 1', stage_2: 'Stage 2', ombudsman: 'with the ombudsman', resolved: 'resolved', closed: 'closed' })[st] || st;
  const lines = [];
  lines.push(outward ? `COMPLAINT SUMMARY: ${c.ref_code} (Greenco's reference)` : `OMBUDSMAN / ADR REFERRAL: ${c.ref_code}`);
  lines.push('='.repeat(48));
  // Never sent too early: a pack prepared before it can go says so first.
  const notReady = outward ? [] : [c, ...(c.parties || [])].filter((t) => trackOpen(t) && t.referral && !t.referral.open);
  for (const t of notReady) {
    lines.push(`NOT READY TO SEND${c.parties?.length ? ` (${t.org_name})` : ''}: ${t.referral.why}.`);
  }
  if (notReady.length) lines.push('');
  lines.push(`Organisation: ${c.org_name} (${c.rule.label})`);
  if (!outward) lines.push(`Refer to: ${c.rule.ombudsman}${c.rule.ombudsmanUrl ? ` (${c.rule.ombudsmanUrl})` : ''}`);
  if (c.property) lines.push(`Property: ${c.property}`);
  if (c.account_numbers?.length) lines.push(`Account number${c.account_numbers.length === 1 ? '' : 's'}: ${c.account_numbers.join(', ')}`);
  if (c.reference) lines.push(`Their reference: ${c.reference}`);
  lines.push(`Subject: ${c.subject}`);
  lines.push(`Raised: ${readable(c.raised_on)}   Stage: ${stageWords(c.stage)}   Status: ${c.label}`);
  if (c.acknowledged_on) lines.push(`Acknowledged: ${readable(c.acknowledged_on)}`);
  if (c.responded_on) lines.push(`Their response: ${readable(c.responded_on)}`);
  if (c.final_response_on) lines.push(`Their final response: ${readable(c.final_response_on)}`);
  if (!outward) {
    if (c.ombudsman_from) lines.push(`Can refer from: ${readable(c.ombudsman_from)}`);
    lines.push(`Refer by: ${readable(c.ombudsman_deadline) || 'n/a'}`);
  }
  if (c.rule.procedureRef) lines.push(`Their procedure: ${c.rule.procedureRef}`);
  for (const p of c.parties || []) {
    lines.push('');
    lines.push(`Also complained to: ${p.org_name} (${p.rule.label})${p.relationship ? `, ${p.relationship}` : ''}`);
    if (p.reference) lines.push(`  Their reference: ${p.reference}`);
    lines.push(`  Raised: ${readable(p.raised_on)}   Stage: ${stageWords(p.stage)}   Status: ${p.label}`);
    if (p.acknowledged_on) lines.push(`  Acknowledged: ${readable(p.acknowledged_on)}`);
    if (p.responded_on) lines.push(`  Their response: ${readable(p.responded_on)}`);
    if (p.final_response_on) lines.push(`  Their final response: ${readable(p.final_response_on)}`);
    if (!outward) lines.push(`  Refer to: ${p.rule.ombudsman}; refer by: ${readable(p.ombudsman_deadline) || 'n/a'}`);
  }
  lines.push('');
  lines.push('WHAT WE WANT');
  lines.push('-'.repeat(48));
  lines.push(c.outcome_wanted || (outward ? '(set out in our covering email)' : '(not stated yet: add "The outcome we want" on the complaint)'));
  if (c.losses) lines.push(`Money lost or extra costs: ${c.losses}`);
  // What the ombudsman will ask for: on file, and still missing.
  const attachments = await listAttachments(c.id);
  const ev = await evidenceFor(c, { events: ctx.events, emails: ctx.emails, attachments });
  const mark = { ok: '[x]', missing: '[ ] MISSING:', optional: '[ ] (optional)', na: '[-]' };
  const itemLine = (i) => `${mark[i.state]} ${i.label}${i.detail ? `: ${i.detail}` : ''}${i.fix && i.state !== 'ok' ? `. ${i.fix}` : ''}`;
  if (!outward) {
    lines.push('');
    lines.push(`EVIDENCE${ev.missing ? ` (${ev.missing} still missing)` : ''}`);
    lines.push('-'.repeat(48));
    for (const i of ev.shared) lines.push(itemLine(i));
    for (const t of ev.tracks) {
      if (ev.tracks.length > 1) lines.push(`${t.org_name}:`);
      for (const i of t.items) lines.push(`${ev.tracks.length > 1 ? '  ' : ''}${itemLine(i)}`);
    }
  }
  // Outward, the documents are the ones attached to the covering email, and
  // that email lists them: this list would name ones not sent.
  if (attachments.length && !outward) {
    lines.push('');
    lines.push('Documents on file:');
    for (const a of [...attachments].reverse()) lines.push(`  ${readable(londonDateOf(new Date(a.uploaded_at)))}  ${a.filename}`);
  }
  lines.push('');
  lines.push('GROUNDS FOR REFERRAL');
  lines.push('-'.repeat(48));
  if (outward && !grounds) lines.push('Set out in our covering email.');
  else lines.push(grounds === null
    ? 'Not drafted here: press “Build referral pack” on the complaint for the AI to draft the grounds from everything on file.'
    : grounds || '(The AI returned no grounds this time: build the pack again, or write them from the timeline below.)');
  lines.push('');
  lines.push('CASE TIMELINE');
  lines.push('-'.repeat(48));
  // Outward: the steps of the complaint only, never our own notes (which
  // include working notes and what the system did).
  for (const e of [...ctx.events].reverse()) {
    if (outward && (e.type === 'note' || e.removed_org || /^Automatic|^Import/.test(e.created_by || ''))) continue;
    lines.push(`${readable(e.event_date)}  [${e.type}]${e.party_name ? ` (${e.party_name})` : ''}  ${e.note || ''}`.trim());
  }
  lines.push('');
  lines.push('CORRESPONDENCE LOG');
  lines.push('-'.repeat(48));
  const logged = outward ? ctx.emails.filter((em) => !em.removed_org && !internalOnly(em)) : ctx.emails;
  if (logged.length) {
    for (const em of [...logged].reverse()) {
      lines.push(
        `${em.received_at ? readable(londonDateOf(new Date(em.received_at))) : ''}  ${em.direction === 'outbound' || em.analysis?.kind === 'our_email' ? 'SENT' : 'RECEIVED'}  ` +
          `${em.subject || '(no subject)'}, ${em.sender_name || em.sender_email || ''}` +
          `${em.removed_org === LANDLORD ? ' (with the landlord)' : em.removed_org ? ` (${em.removed_org}, since taken off this complaint)` : ''}`,
      );
    }
  } else {
    lines.push('(no emails logged)');
  }
  return lines.join('\n');
}

// Build an ombudsman/ADR referral pack (facts + timeline + AI-drafted grounds).
// A POST, so it needs edit access: it is a paid AI call, and a GET would let
// view-only access spend credits.
router.post(
  '/:id/referral-pack',
  asyncHandler(async (req, res) => {
    const ctx = await gatherContext(req.params.id);
    const c = ctx.complaint;
    const grounds = await draftReferralGrounds(ctx);
    const text = await packText(ctx, grounds);
    res.json({ ref_code: c.ref_code, ombudsman: c.rule.ombudsman, grounds, text });
  }),
);

// Everything to upload to the ombudsman in one download: the summary (the
// referral pack without the AI's grounds, so no AI is used), every email as a
// text file (oldest first, numbered, with who, when and to whom) and every
// document as it was received. An organisation taken off the complaint: its
// emails and what came with them are left out (its history, not this case).
// The evidence as files: the summary (the referral pack's text, with the
// grounds when they were drafted), every email as a text file (oldest first,
// numbered, with who, when and to whom) and every document as received. An
// organisation taken off the complaint: its emails and what came with them
// are left out (its history, not this case). Shared by the .zip download and
// the referral sent by email, so the two carry exactly the same evidence.
async function evidenceFiles(ctx, { grounds = null, outward = false, track = null } = {}) {
  const c = ctx.complaint;
  const when = (d) => new Date(d).toLocaleString('en-GB', { timeZone: 'Europe/London', dateStyle: 'medium', timeStyle: 'short' }).replace('Sept', 'Sep');
  const files = [{ name: '00 Summary for the ombudsman.txt', data: await packText(ctx, grounds, { outward, track }) }];
  // Each email dated the day it was SENT (a forward's own date is only when
  // it was forwarded), oldest first; ours by the same test as everywhere
  // (sent from here, read as ours, or from our address with no reading).
  const ourDomain = String(config.complaintEmail.domain || '').toLowerCase();
  const isOurs = (e) => e.direction === 'outbound' || e.analysis?.kind === 'our_email' ||
    (ourDomain && String(e.sender_email || '').toLowerCase().endsWith(`@${ourDomain}`) && !e.analysis?.kind);
  const sentDay = (e) => (/^\d{4}-\d{2}-\d{2}$/.test(e.analysis?.sent_on || '') ? e.analysis.sent_on
    : e.received_at ? londonDateOf(new Date(e.received_at)) : '');
  // An organisation taken off the complaint: its emails (and what came with
  // them) are its history, left out of what goes to the ombudsman.
  // Outward, an email only between our own people is ours, and what came
  // with it (an internal spreadsheet) stays with it.
  // What the landlord sent (their authority for Greenco) is evidence the
  // ombudsman asks for, so it goes, though their emails aren't the
  // organisation's correspondence.
  const offIds = new Set(ctx.emails.filter((e) => (e.removed_org && e.removed_org !== LANDLORD) || (outward && internalOnly(e))).map((e) => e.id));
  const emails = ctx.emails.filter((e) => !e.removed_org && !(outward && internalOnly(e)))
    .sort((a, b) => sentDay(a).localeCompare(sentDay(b)) || new Date(a.received_at) - new Date(b.received_at));
  emails.forEach((e, i) => {
    const day = sentDay(e);
    const forwarded = day && e.received_at && day !== londonDateOf(new Date(e.received_at));
    files.push({
      name: `Emails/${String(i + 1).padStart(3, '0')} ${day} ${isOurs(e) ? 'SENT' : 'RECEIVED'} ${safeName(e.subject, 60)}.txt`,
      date: e.received_at ? new Date(e.received_at) : undefined,
      data: [
        `From: ${e.sender_name ? `${e.sender_name} <${e.sender_email || ''}>` : e.sender_email || ''}`,
        `To: ${(e.to_addresses || []).join(', ')}`,
        `Date: ${forwarded ? `${readable(day)} (as sent; forwarded here ${when(e.received_at)})` : e.received_at ? when(e.received_at) : ''}`,
        `Subject: ${e.subject || '(no subject)'}`,
        '',
        e.body_text || e.body_preview || '(no text kept)',
      ].join('\r\n'),
    });
  });
  const docs = (await query(
    `SELECT filename, storage_path, uploaded_at, sha256, source_email_id FROM complaint_attachments WHERE complaint_id = $1 ORDER BY uploaded_at`,
    [c.id],
  )).rows.filter((d) => !d.source_email_id || !offIds.has(d.source_email_id));
  const seen = new Set();
  const unreadable = [];
  for (const d of docs) {
    if (d.sha256 && seen.has(d.sha256)) continue; // the same file saved twice
    if (d.sha256) seen.add(d.sha256);
    try {
      files.push({
        name: `Documents/${londonDateOf(new Date(d.uploaded_at))} ${safeName(d.filename, 100, { keepExt: true })}`,
        date: new Date(d.uploaded_at),
        data: await fs.readFile(d.storage_path),
      });
    } catch {
      unreadable.push(d.filename);
    }
  }
  if (unreadable.length && !outward) {
    files.push({ name: 'Documents/Could not be included.txt', data: `These files are on the complaint but couldn't be read from storage:\r\n${unreadable.join('\r\n')}` });
  }
  return files;
}

router.get(
  '/:id/evidence.zip',
  asyncHandler(async (req, res) => {
    const ctx = await gatherContext(req.params.id, undefined, { files: 0 });
    const c = ctx.complaint;
    const files = await evidenceFiles(ctx);
    const zip = zipStore(files);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(`${safeName(`${c.ref_code} evidence for the ombudsman`)}.zip`));
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(zip);
  }),
);

// ---------------------------------------------------------------------------
// Referring to the ombudsman BY EMAIL, from the complaint. Most schemes take a
// new complaint by email as well as on their website (ombudsmen.refer_email,
// checked on their own site); where one does, the referral is drafted here
// (no AI: the facts on file, and the grounds when the referral pack has
// drafted them), sent in the background with the evidence attached, and once
// it has gone that organisation's part is "with the ombudsman", dated the
// day it went. Never before a referral is open (referralOpen).
// ---------------------------------------------------------------------------
async function referralTrack(complaintId, partyId) {
  const c = await decoratedById(complaintId);
  const t = partyId ? (c.parties || []).find((p) => p.id === partyId) : c;
  if (!t) throw new HttpError(400, 'That organisation isn’t on this complaint.');
  return { c, t };
}

function referralRefusal(t) {
  if (!trackOpen(t) || !['stage_1', 'stage_2'].includes(t.stage)) return 'This part of the complaint isn’t waiting to be referred.';
  if (!t.referral?.open) return `Not yet: ${t.referral?.why || 'a referral isn’t open'}.`;
  if (!t.rule?.scheme?.refer_email) return `${theOmbudsman(t.rule?.ombudsman)} has no address on file for new complaints by email (Complaints → Ombudsmen): refer on their website.`;
  return null;
}

// The covering email, from the facts on file. `grounds` is the referral
// pack's drafted grounds when it has been built (the page passes them).
export function referralEmailDraft(c, t, grounds = null) {
  const sc = t.rule.scheme;
  const accounts = (c.account_numbers || []).join(', ');
  const refs = [t.reference && `their reference ${t.reference}`, accounts && `account ${accounts}`].filter(Boolean).join(', ');
  const lines = [];
  lines.push(`Dear ${sc.name} team,`);
  lines.push('');
  lines.push(`We would like to refer our complaint against ${t.org_name} to you for an independent review${c.property ? `. It concerns ${c.property}` : ''}${refs ? ` (${refs})` : ''}.`);
  lines.push('');
  const steps = [`We made our complaint to ${t.org_name} on ${ukDate(t.raised_on)}.`];
  if (t.acknowledged_on) steps.push(`They acknowledged it on ${ukDate(t.acknowledged_on)}.`);
  if (t.stage === 'stage_2' && t.stage_started_on) steps.push(`We asked for it to be escalated to Stage 2 on ${ukDate(t.stage_started_on)}.`);
  if (t.final_response_on) steps.push(`Their final response is dated ${ukDate(t.final_response_on)}, and it did not resolve matters.`);
  else if (t.responded_on && t.stage === 'stage_2') steps.push(`Their Stage 2 response is dated ${ukDate(t.responded_on)}, and it did not resolve matters.`);
  else if (t.responded_on) steps.push(`Their Stage 1 response is dated ${ukDate(t.responded_on)}, and it did not resolve matters.`);
  else if (t.response_due && t.response_due < todayISO()) steps.push(`Their response was due by ${ukDate(t.response_due)} and we have not received it.`);
  // Only the scheme's own wait, never a figure assumed for it.
  if (!t.final_response_on && t.rule.ombudsmanAfterWeeks && t.ombudsman_from && t.ombudsman_from <= todayISO()) {
    steps.push(`It is now more than ${t.rule.ombudsmanAfterWeeks} weeks since we complained, and it remains unresolved.`);
  }
  lines.push(steps.join(' '));
  lines.push('');
  lines.push(grounds && String(grounds).trim()
    ? String(grounds).trim()
    : '[Please say briefly what went wrong and why their response has not put it right]');
  lines.push('');
  lines.push(c.outcome_wanted ? `To put things right, we are asking for: ${c.outcome_wanted}` : '[What we are asking for, to put things right]');
  if (c.losses) lines.push(`The extra cost to us so far: ${c.losses}`);
  lines.push('');
  lines.push('We attach a summary with the timeline, the correspondence with them, and the documents we hold.');
  lines.push(`If you need anything further from us, or a form completed${sc.representative ? ' (including authority to act for the account holder)' : ''}, please let us know, and please quote ${c.ref_code} in any reply so it reaches us.`);
  lines.push('');
  lines.push('Kind regards,');
  lines.push('');
  lines.push('[Name]');
  lines.push('[Job title]');
  lines.push('Greenco');
  const subject = `Complaint referral: ${t.org_name}${accounts ? `, account ${accounts}` : ''}${c.property ? ` (${c.property})` : ''} [${c.ref_code}]`;
  // With more than one organisation, each one's reference, by name
  // (lib/references.js): the ombudsman may need to reach either.
  const body = (c.parties || []).length ? withReferences(lines.join('\n'), referenceLines(tracksForReview(c), null)) : lines.join('\n');
  return { to: sc.refer_email, subject: subject.slice(0, 250), body, note: sc.refer_email_note || null };
}

// A POST, so the pack's grounds (thousands of characters) travel in the body
// rather than a URL a proxy would refuse. Saves nothing.
router.post(
  '/:id/referral/draft',
  asyncHandler(async (req, res) => {
    const d = parse(z.object({ party_id: z.string().uuid().optional().nullable(), grounds: z.string().max(20000).optional().nullable() }), req.body || {});
    const { c, t } = await referralTrack(req.params.id, d.party_id || null);
    const refusal = referralRefusal(t);
    if (refusal) throw new HttpError(409, refusal);
    res.json(referralEmailDraft(c, t, d.grounds || null));
  }),
);


const referralSendInput = z.object({
  party_id: z.string().uuid().optional().nullable(),
  to: z.string().min(3),
  cc: z.string().optional().nullable(),
  subject: z.string().trim().min(1).max(300),
  body: z.string().trim().min(1).max(60000),
});
router.post(
  '/:id/referral/send',
  asyncHandler(async (req, res) => {
    const d = parse(referralSendInput, req.body);
    if (!config.smtp.enabled) throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
    const { c, t } = await referralTrack(req.params.id, d.party_id || null);
    const refusal = referralRefusal(t);
    if (refusal) throw new HttpError(409, refusal);
    // A draft's gaps must be filled in before it goes to an ombudsman.
    // Checked once signed ([Name] / [Job title] are the sender's to fill).
    refuseGaps(signEmail(d.subject, req.user), signEmail(d.body, req.user));
    const to = parseRecipients(d.to);
    const cc = parseRecipients(d.cc);
    if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
    if (c.email_address && !cc.includes(c.email_address)) cc.push(c.email_address);
    for (const a of withExternalCc(to, cc)) if (!cc.includes(a)) cc.push(a);
    const partyId = t.complaint_id ? t.id : null;
    const out = await queueOutbox(c.id, {
      guard: { sql: `SELECT 1 FROM complaint_outbox WHERE complaint_id = $1 AND then_refer AND party_id IS NOT DISTINCT FROM $2 AND status <> 'sent'`, params: [c.id, partyId] },
      refusal: 'A referral to the ombudsman is already being sent, or failed and is waiting on this complaint: deal with that one first (Try again, It went, or Discard).',
    },
    `INSERT INTO complaint_outbox (complaint_id, party_id, to_party, to_addresses, cc_addresses, subject, body, sent_by, then_refer, attach_evidence, sender_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,true,$9) RETURNING id`,
    [c.id, partyId, Boolean(partyId), to, cc, signEmail(d.subject, req.user), signEmail(d.body, req.user), who(req), req.user?.id || null]);
    res.status(202).json({ queued: true, outbox_id: out.id });
  }),
);

// What goes with an emailed referral: the summary, all the correspondence as
// ONE text file (fifty attachments is a case nobody can read), and each
// document as received, up to what an email can carry. What doesn't fit is
// named in the email, to send once they have given the case a reference.
const REFERRAL_ATTACH_BYTES = 14 * 1024 * 1024; // ~19 MB once encoded for email
async function referralAttachments(complaintId, partyId = null) {
  const ctx = await gatherContext(complaintId, undefined, { files: 0 });
  const track = partyId ? (ctx.complaint.parties || []).find((p) => p.id === partyId) || null : null;
  const files = await evidenceFiles(ctx, { outward: true, track });
  const summary = files.find((f) => f.name.startsWith('00 '));
  const emails = files.filter((f) => f.name.startsWith('Emails/'));
  // Newest first when not everything fits: the form their procedure asks
  // for is filled in and added just before sending, and must go.
  const docs = files.filter((f) => f.name.startsWith('Documents/')).sort((a, b) => (b.date || 0) - (a.date || 0));
  const out = [];
  if (summary) out.push({ filename: `${ctx.complaint.ref_code} summary and timeline.txt`, content: Buffer.from(summary.data, 'utf8') });
  if (emails.length) {
    const all = emails.map((f) => `${'='.repeat(60)}\r\n${f.data}`).join('\r\n\r\n');
    out.push({ filename: `${ctx.complaint.ref_code} correspondence (${plural(emails.length, 'email')}).txt`, content: Buffer.from(all, 'utf8') });
  }
  let used = out.reduce((n, a) => n + a.content.length, 0);
  const left = [];
  for (const f of docs) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    if (used + data.length > REFERRAL_ATTACH_BYTES) { left.push(f.name.replace(/^Documents\/\S+ /, '')); continue; }
    used += data.length;
    out.push({ filename: f.name.replace(/^Documents\//, ''), content: data });
  }
  return { attachments: out, left };
}

// AI import: extract a structured complaint from pasted material so an existing
// complaint can be brought in and continued. Returns fields for review; the user
// confirms and POSTs to `/` to create it.
const importInput = z.object({
  text: z.string().max(60000).optional().nullable(),
  hint: z.string().max(500).optional().nullable(),
  // An email waiting in the general inbox that is itself a new complaint.
  email_id: z.string().uuid().optional().nullable(),
});

// Fill the "Log complaint" form from the complaint itself: pasted text, an
// uploaded email/letter (PDF, Word, photo), or an email waiting to be filed.
// Nothing is saved; the form is shown to be checked first.
router.post(
  '/import/parse',
  procedureMemoryUpload.single('file'),
  asyncHandler(async (req, res) => {
    const d = parse(importInput, req.body || {});
    let text = d.text?.trim() || null;
    const blocks = [];
    if (req.file) {
      blocks.push({ type: 'text', text: `Attached (third-party document): ${req.file.originalname}` });
      blocks.push(contentFor(req.file));
    }
    if (d.email_id) {
      const em = (
        await query('SELECT subject, sender_name, sender_email, received_at, body_text, body_preview FROM complaint_emails WHERE id = $1', [d.email_id])
      ).rows[0];
      if (!em) throw new HttpError(404, 'Email not found');
      text = `Subject: ${em.subject || ''}\nFrom: ${em.sender_name || ''} <${em.sender_email || ''}>\n` +
        `Received: ${em.received_at ? londonDateOf(new Date(em.received_at)) : ''}\n\n${em.body_text || em.body_preview || ''}`;
    }
    if (!text && !blocks.length) throw new HttpError(400, 'Paste the complaint, or attach the email or letter.');
    const parsed = await parseImportedComplaint({ text, hint: d.hint, blocks, forLog: true });
    // The saved organisation it is about, by the same rule imports use, so the
    // form doesn't offer to set up a second one for a name written differently.
    const org = parsed?.org_name ? await findOrgByName(parsed.org_name) : null;
    res.json({ ...parsed, matched_organisation_id: org?.id || null });
  }),
);

// Batch: draft a chaser for every overdue open complaint (review before sending).
router.post(
  '/chase/overdue',
  asyncHandler(async (_req, res) => {
    const open = (
      await query(`SELECT * FROM complaints WHERE state = 'open' ORDER BY response_due ASC NULLS LAST`)
    ).rows;
    const decorated = await decorateMany(open);
    // One chaser per organisation that needs chasing: with more than one on a
    // complaint, each is chased under its own procedure and reference.
    const due = decorated.flatMap((c) => [
      // Not one Greenco has just written to (its next step is to wait).
      ...(c.chase_now ? [{ c, t: c }] : []),
      ...(c.parties || []).filter((p) => p.chase_now).map((p) => ({ c, t: p })),
    ]).slice(0, 12);

    const drafts = [];
    for (const { c, t } of due) {
      const party = t !== c;
      const aim = party
        ? ` Address it to ${t.org_name}${t.reference ? `, quoting their reference ${t.reference}` : ''}, ` +
          `about THEIR part of the complaint (their procedure and dates), not ${c.org_name}'s.`
        : '';
      try {
        const ctx = await gatherContext(c.id);
        const r = await assistComplaint({
          ...ctx,
          feature: 'Chaser drafts',
          instruction:
            (t.status === 'ack_overdue'
              ? 'Draft a polite but firm chaser: the complaint has not been acknowledged within ' +
                'the time their own procedure sets. Ask them to acknowledge it, name who is ' +
                'handling it, and confirm when the outcome will be sent.'
              : 'Draft a firm chaser email pressing for the overdue response and noting that the ' +
                'missed deadline is itself a complaint-handling failure.') + aim,
        });
        drafts.push({
          id: c.id, ref_code: c.ref_code, org_name: t.org_name, subject: c.subject,
          org_email: t.org_email, email_address: c.email_address, draft: r,
        });
      } catch (err) {
        drafts.push({ id: c.id, ref_code: c.ref_code, org_name: t.org_name, subject: c.subject, error: err.message });
      }
    }
    res.json({ count: drafts.length, drafts });
  }),
);

// --- Attachments -----------------------------------------------------------
// Validate the complaint id (as a UUID) AND its existence *before* multer runs,
// so upload files are never streamed to disk for a bad/nonexistent id. This also
// closes a path-traversal hole: multer builds the on-disk directory from
// req.params.id, so an un-validated id like "..%2f.." could escape the upload
// root.
const requireComplaintId = asyncHandler(async (req, _res, next) => {
  if (!z.string().uuid().safeParse(req.params.id).success) {
    throw new HttpError(400, 'Invalid complaint id');
  }
  const { rows } = await query('SELECT id FROM complaints WHERE id = $1', [req.params.id]);
  if (!rows[0]) throw new HttpError(404, 'Complaint not found');
  next();
});

router.post(
  '/:id/attachments',
  requireComplaintId,
  attachmentUpload.array('files', 10),
  asyncHandler(async (req, res) => {
    const saved = [];
    for (const f of req.files || []) saved.push(await saveAttachment(req.params.id, f));
    scheduleReview(req.params.id);
    res.status(201).json(saved);
  }),
);

router.get(
  '/attachments/:attId/download',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.attId).success) {
      throw new HttpError(400, 'Invalid attachment id');
    }
    const a = await getAttachment(req.params.attId);
    if (!a) throw new HttpError(404, 'Attachment not found');
    // A download, never shown inline: a user could upload an HTML/SVG file
    // whose stored mimetype would otherwise execute as script on our own
    // origin. `nosniff` stops the browser second-guessing the content type.
    // The one exception is ?view=1 on a PDF or a photo (to look at it before
    // it goes with an email), sent as a type from a fixed list
    // (lib/http.js#viewableType), so nothing that can run script is shown.
    const view = req.query.view === '1' ? viewableType(a.mimetype) : null;
    res.setHeader('Content-Type', view || a.mimetype || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', attachmentDisposition(a.filename, 'attachment', { inline: Boolean(view) }));
    a.stream().pipe(res);
  }),
);

router.delete(
  '/attachments/:attId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.attId).success) {
      throw new HttpError(400, 'Invalid attachment id');
    }
    const ok = await deleteAttachment(req.params.attId);
    if (!ok) throw new HttpError(404, 'Attachment not found');
    res.status(204).end();
  }),
);

// --- Complaints dashboard (overdue / ignored + due soon + ombudsman windows) -
router.get(
  '/dashboard',
  asyncHandler(async (_req, res) => {
    const open = (
      await query(`SELECT * FROM complaints WHERE state = 'open' ORDER BY response_due ASC NULLS LAST`)
    ).rows;
    const decorated = await decorateMany(open);

    // Any organisation on it needing chasing puts the complaint in the list.
    const overdue = decorated.filter((c) => c.any_chase_now);
    const awaiting = decorated.filter((c) => !c.any_chase_now);

    const counts = (
      await query(`
        SELECT
          (SELECT count(*) FROM complaints) AS total,
          (SELECT count(*) FROM complaints WHERE state = 'open') AS open,
          (SELECT count(*) FROM complaints WHERE state = 'resolved') AS resolved
      `)
    ).rows[0];

    res.json({
      counts: {
        total: Number(counts.total),
        open: Number(counts.open),
        resolved: Number(counts.resolved),
        overdue: overdue.length,
      },
      overdue,
      awaiting,
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.state) {
      params.push(req.query.state);
      where = 'WHERE state = $1';
    }
    // With how many emails are waiting for a person on each, so the list can
    // say which complaints need someone without opening them.
    const { rows } = await query(
      `SELECT c.*,
              (SELECT count(*)::int FROM complaint_emails e
                WHERE e.complaint_id = c.id AND e.direction <> 'outbound' AND e.reviewed_at IS NULL) AS new_emails
         FROM complaints c ${where.replace('state', 'c.state')} ORDER BY (c.state <> 'open'), c.raised_on DESC`,
      params,
    );
    res.json(await decorateMany(rows));
  }),
);

// --- Email automation: status, which mailboxes to watch, past complaints ----
router.get(
  '/automation',
  asyncHandler(async (_req, res) => {
    const pending = (
      await query(`SELECT count(*)::int AS n FROM complaint_import_candidates WHERE status = 'pending'`)
    ).rows[0].n;
    const unfiled = (await query('SELECT count(*)::int AS n FROM complaint_emails WHERE complaint_id IS NULL')).rows[0].n;
    res.json({
      mailbox_connected: emailConfigured(),
      catch_all: config.ms.mailbox || null,
      ai: config.anthropic.enabled,
      inbox: complaintInboxAddress(),
      watching: await watchedMailboxes(),
      last_check: await getSetting('email_last_check'),
      past_scan: await scanStatus(),
      past_auto_import: Boolean(await getSetting('past_auto_import')),
      to_check: (await query(`SELECT count(*)::int AS n FROM complaints WHERE needs_check`)).rows[0].n,
      past_pending: pending,
      unfiled,
      bounced: (await query('SELECT count(*)::int AS n FROM email_bounces WHERE resolved_at IS NULL')).rows[0].n,
    });
  }),
);

// --- Re-check every open complaint against its emails (migration 031) --------
// Search by every account number and reference, read each complaint's emails
// together, and move it to where they show it has got to. Only ever started by
// a person; runs in the background with its progress here.
router.get(
  '/recheck',
  asyncHandler(async (_req, res) => {
    const open = (await query(`SELECT count(*)::int AS n,
        count(*) FILTER (WHERE rechecked_at IS NULL)::int AS never FROM complaints WHERE state = 'open'`)).rows[0];
    const run = await recheckStatus();
    // Which ones, and why: added since the last run, or their re-check failed
    // (a failure leaves no date, so without saying which, the count can't be
    // acted on).
    const never = (await query(
      `SELECT id, ref_code, org_name, subject, created_at, recheck_progress FROM complaints
        WHERE state = 'open' AND rechecked_at IS NULL ORDER BY created_at DESC LIMIT 20`,
    )).rows.map((c) => {
      const failed = (run?.results || []).filter((r) => r.id === c.id && r.result === 'failed').pop();
      const own = c.recheck_progress?.status === 'failed' ? c.recheck_progress : null;
      const why = failed ? `Its re-check failed: ${failed.text}`
        : own ? `Its re-check failed${own.error ? `: ${own.error}` : ''}`
          : run?.started_at && new Date(c.created_at) > new Date(run.started_at) ? 'Added since the last re-check'
            : 'Not re-checked yet';
      return { id: c.id, ref_code: c.ref_code, org_name: c.org_name, subject: c.subject, why };
    });
    res.json({ run, open: open.n, never_rechecked: open.never, never, ai: config.anthropic.enabled, mailbox: emailConfigured() });
  }),
);
router.post(
  '/recheck',
  asyncHandler(async (req, res) => {
    try {
      res.status(202).json(await startRecheck({ by: who(req), force: Boolean(req.body?.force), onlyNever: Boolean(req.body?.only_never) }));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
  }),
);

// --- Emails that bounced (migration 030) ------------------------------------
// Every bounce not yet looked into, for the Complaints page.
router.get(
  '/bounces',
  asyncHandler(async (_req, res) => {
    res.json(await openBounces());
  }),
);

// A person has looked into a bounce (corrected the address, found another
// way to reach them): it stops being flagged, and what they found is kept on
// the record and on the complaint's timeline.
const bounceResolveInput = z.object({ note: z.string().trim().min(1, 'Say what you found or did').max(1000) });
router.post(
  '/bounces/:bounceId/resolve',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.bounceId).success) throw new HttpError(400, 'Invalid id');
    const d = parse(bounceResolveInput, req.body);
    const { rows } = await query(
      `UPDATE email_bounces SET resolved_at = now(), resolved_by = $2, resolution = $3
        WHERE id = $1 AND resolved_at IS NULL RETURNING *`,
      [req.params.bounceId, who(req), d.note],
    );
    if (!rows[0]) throw new HttpError(404, 'That bounce has already been dealt with');
    if (rows[0].complaint_id) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [rows[0].complaint_id, todayISO(), `Bounced email to ${rows[0].address} looked into: ${d.note}`, who(req)],
      );
    }
    res.json(rows[0]);
  }),
);

const EMAIL = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/;
const watchInput = z.object({
  mailboxes: z.array(z.string().trim().toLowerCase().regex(EMAIL, 'Not an email address')).max(10),
});
function refuseMailboxes(list) {
  const bad = list.filter((m) => !mailboxAllowed(m));
  if (!bad.length) return;
  const rule = allowedMailboxList().length
    ? 'isn’t one the server allows (MS_ALLOWED_MAILBOXES)'
    : `isn’t an @${config.complaintEmail.domain} mailbox`;
  throw new HttpError(400, `${bad.join(', ')} ${rule}.`);
}
router.put(
  '/automation',
  asyncHandler(async (req, res) => {
    const d = parse(watchInput, req.body);
    // Watching a mailbox copies its complaint mail onto complaints everyone
    // with the section can read, so choosing one is an administrator's call.
    if (!can(req.user, 'admin', 'edit')) {
      throw new HttpError(403, 'Only an administrator can change which mailboxes are watched.');
    }
    refuseMailboxes(d.mailboxes);
    await setSetting('watch_mailboxes', { mailboxes: [...new Set(d.mailboxes)] }, who(req));
    res.json({ watching: await watchedMailboxes() });
  }),
);

const scanInput = z.object({
  mailboxes: z.array(z.string().trim().toLowerCase().regex(EMAIL, 'Not an email address')).min(1).max(10),
  // A year is as far back as is worth going: an ombudsman won't take a
  // complaint older than that.
  months: z.number().int().min(1).max(12),
});
router.post(
  '/past/scan',
  asyncHandler(async (req, res) => {
    const d = parse(scanInput, req.body);
    refuseMailboxes(d.mailboxes);
    // Anyone may search their own mailbox and the ones already watched; any
    // other is an administrator's choice (its mail lands on complaints).
    if (!can(req.user, 'admin', 'edit')) {
      const own = new Set([String(req.user?.email || '').toLowerCase(), ...(await watchedMailboxes()),
        String(config.ms.mailbox || '').toLowerCase()].filter(Boolean));
      const other = d.mailboxes.filter((m) => !own.has(m));
      if (other.length) {
        throw new HttpError(403, `You can search your own mailbox and the watched ones. An administrator can search ${other.join(', ')}.`);
      }
    }
    try {
      await startScan({ ...d, by: who(req) });
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    res.status(202).json(await scanStatus());
  }),
);

router.get(
  '/past/candidates',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, mailbox, subject, first_at, last_at, message_count, extracted, status, error,
              import_attempts, last_attempt_at, accounts_read_at
         FROM complaint_import_candidates WHERE status IN ('pending', 'importing') ORDER BY first_at DESC`,
    );
    // Say when one is already in the system, so it is linked, not duplicated.
    const complaints = (await query(
      `SELECT c.id, c.ref_code, c.subject, c.org_name, c.organisation_id, c.property, c.raised_on, c.reference, c.our_reference, c.account_numbers, ${PARTY_COLS} FROM complaints c`,
    )).rows;
    const orgs = (await query('SELECT id, name, research_status, verified_at FROM organisations')).rows;
    // Threads about the same issue are shown (and imported) as one complaint.
    // Rows being brought in are shown as their own group ("Importing…"), so
    // they are neither offered again nor grouped with pending ones.
    const busyGroups = groupCandidates(rows.filter((r) => r.status === 'importing'));
    const pendingRows = rows.filter((r) => r.status === 'pending');
    const autoOn = Boolean(await getSetting('past_auto_import'));
    const paused = await importsPaused();
    const enabled = config.ms.enabled && config.anthropic.enabled;
    const busyRows = rows.filter((r) => r.status === 'importing');
    const skippedRows = (await query(`SELECT extracted FROM complaint_import_candidates WHERE status = 'skipped'`)).rows;
    res.json(await Promise.all([...busyGroups, ...groupCandidates(pendingRows)].map(async (group) => {
      const merged = mergeExtracted(group);
      const { hit, certain } = await onFileFor(group, { complaints, orgs });
      // What automatic import will do with it: the same rule runAutoImport
      // acts on (autoPlan), so the promise on the page is what happens.
      const auto = autoOn && group[0].status === 'pending'
        ? autoPlan(group, {
          hit, certain, paused, enabled,
          relatedRunning: busyRows.some((b) => group.some((c) => sameIssue(c.extracted, b.extracted))),
          skipped: await relatedSkipped(group, skippedRows),
        })
        : null;
      return {
        ...group[0],
        extracted: merged,
        message_count: group.reduce((n, c) => n + (c.message_count || 0), 0),
        status: group[0].status,
        error: group.map((c) => c.error).find(Boolean) || null,
        members: group.map((c) => ({ id: c.id, subject: c.subject, first_at: c.first_at, message_count: c.message_count })),
        existing: hit ? { id: hit.id, ref_code: hit.ref_code, subject: hit.subject } : null,
        // The organisation it would be imported against (matched as the
        // import matches it), and whether its own procedure is known: if not,
        // the imported complaint's dates will be the standard ones until it
        // is researched, and the list warns before it is brought in.
        org: (() => {
          if (!merged?.org_name) return null;
          const o = matchOrgName(orgs, merged.org_name);
          return { id: o?.id || null, name: o?.name || merged.org_name, on_file: Boolean(o), researched: procedureOnFile(o) };
        })(),
        auto,
      };
    })));
  }),
);

router.post(
  '/past/candidates/:candId/import',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.candId).success) throw new HttpError(400, 'Invalid id');
    // Claimed here (so a second click is refused), then brought in in the
    // background: reading every email can take minutes, longer than the
    // browser waits. The list shows "Importing…" until it is done.
    try {
      res.status(202).json({ importing: true, ...(await importInBackground(req.params.candId, who(req))) });
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
  }),
);

// --- Tidy up: likely duplicates, merged on a click --------------------------
router.get(
  '/tidy',
  asyncHandler(async (_req, res) => {
    res.json(await tidySuggestions());
  }),
);

const mergeInput = z.object({ keep_id: z.string().uuid(), merge_id: z.string().uuid() });
router.post(
  '/tidy/complaints',
  asyncHandler(async (req, res) => {
    const d = parse(mergeInput, req.body);
    try {
      res.json(await mergeComplaints(d.keep_id, d.merge_id, who(req)));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
  }),
);
router.post(
  '/tidy/organisations',
  asyncHandler(async (req, res) => {
    const d = parse(mergeInput, req.body);
    try {
      res.json(await mergeOrganisations(d.keep_id, d.merge_id, who(req)));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
  }),
);

// Automatic import of past complaints the AI is sure of, on or off.
const autoInput = z.object({ on: z.boolean() });
router.put(
  '/past/auto',
  asyncHandler(async (req, res) => {
    const d = parse(autoInput, req.body);
    // Switching on imports the ones already waiting, which can take a while:
    // it runs in the background and the list catches up as they go.
    setAutoImport(d.on, who(req)).catch((err) => console.error('[complaints] auto-import failed:', err.message));
    res.json({ on: d.on });
  }),
);

// Bring a found thread's emails onto a complaint already in the system,
// instead of importing it again.
const linkInput = z.object({ complaint_id: z.string().uuid() });
router.post(
  '/past/candidates/:candId/link',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.candId).success) throw new HttpError(400, 'Invalid id');
    const d = parse(linkInput, req.body);
    try {
      await linkInBackground(req.params.candId, d.complaint_id, who(req));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    res.status(202).json({ linking: true, complaint_id: d.complaint_id });
  }),
);

router.post(
  '/past/candidates/:candId/skip',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.candId).success) throw new HttpError(400, 'Invalid id');
    try {
      await skipCandidate(req.params.candId, who(req)); // with the threads grouped with it
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    res.status(204).end();
  }),
);

// Emails sent to the general complaints inbox that the AI couldn't place with
// confidence. Each carries the AI's reading of it, and its best guess if any.
router.get(
  '/emails/unfiled',
  asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, subject, sender_name, sender_email, received_at, body_preview, analysis,
              analysis_error
         FROM complaint_emails WHERE complaint_id IS NULL
        ORDER BY received_at DESC LIMIT 100`,
    );
    res.json(rows);
  }),
);

const fileInput = z.object({ complaint_id: z.string().uuid() });

// File an unfiled email against a complaint; it is then read and recorded
// exactly as if it had been sent to that complaint's own address.
router.post(
  '/emails/:emailId/file',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) {
      throw new HttpError(400, 'Invalid email id');
    }
    const d = parse(fileInput, req.body);
    const c = (await query('SELECT id FROM complaints WHERE id = $1', [d.complaint_id])).rows[0];
    if (!c) throw new HttpError(404, 'Complaint not found');
    const { rowCount } = await query(
      `UPDATE complaint_emails SET complaint_id = $2, match_method = 'filed'
        WHERE id = $1 AND complaint_id IS NULL`,
      [req.params.emailId, d.complaint_id],
    );
    if (!rowCount) throw new HttpError(404, 'That email is not waiting to be filed');
    await processEmail(req.params.emailId);
    res.json({ filed: true, complaint_id: d.complaint_id });
  }),
);

// An email in the general inbox that isn't about any complaint: remove it.
router.delete(
  '/emails/:emailId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) {
      throw new HttpError(400, 'Invalid email id');
    }
    const { rowCount } = await query(
      'DELETE FROM complaint_emails WHERE id = $1 AND complaint_id IS NULL',
      [req.params.emailId],
    );
    if (!rowCount) throw new HttpError(404, 'That email is not waiting to be filed');
    res.status(204).end();
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Complaint not found');
    const decorated = await decorate({ ...rows[0], recheck_progress: recheckProgressOf(rows[0]) });
    decorated.stage2_missed = (await stage2MissedFor([rows[0].id])).get(rows[0].id) || [];
    decorated.same_account = await sameAccountComplaints(rows[0]);
    // A review written on an earlier day that the calendar has overtaken (its
    // "wait until" date has come) is written again now, while someone is
    // looking at it, instead of the next morning: the page says it is being
    // updated, and it is. Once a day at most (a review written today never
    // qualifies), and never while one is already asked for.
    {
      const r = rows[0];
      const reviewedOn = r.ai_reviewed_at ? londonDateOf(new Date(r.ai_reviewed_at)) : null;
      const wanted = r.review_wanted_at && (!r.ai_reviewed_at || new Date(r.review_wanted_at) > new Date(r.ai_reviewed_at));
      // Only for someone who may change the complaint: it is a paid call.
      if (config.anthropic.enabled && can(req.user, 'complaints', 'edit') && r.state === 'open' && r.ai_review && !decorated.ai_review_current &&
        !wanted && reviewedOn && reviewedOn < todayISO()) scheduleReview(r.id, 3000);
    }
    const events = await listEvents(req.params.id);
    const emails = await listComplaintEmails(req.params.id);
    const attachments = await listAttachments(req.params.id);
    const email_search = await searchStatus(rows[0]);
    // Bounces not yet looked into: of emails about this complaint, or to any
    // of its organisations' complaints addresses.
    const bounces = await openBounces({
      complaintId: rows[0].id,
      addresses: [decorated, ...decorated.parties].map((t) => t.org_email).filter(Boolean),
    });
    // Copied in on every email sent from here (utilities@), so the page can say so.
    // Emails still going out, or that failed, shown on the complaint.
    const outbox = (await query(
      `SELECT id, subject, to_addresses, status, error, uncertain, then_escalate, then_formal, then_refer, then_supplier->>'org_name' AS supplier_name, created_at FROM complaint_outbox
        WHERE complaint_id = $1 AND status <> 'sent' ORDER BY created_at`, [rows[0].id],
    )).rows;
    const evidence = await evidenceFor(decorated, { events, emails, attachments });
    const awaiting_first_email = awaitingFirstEmail(decorated);
    res.json({ ...decorated, awaiting_first_email, events, emails, attachments, email_search, bounces, outbox, evidence, external_cc: config.smtp.externalCc });
  }),
);


// A date typed on a complaint that can't be right: in the future, or a step
// (acknowledged, answered, Stage 2 asked for) before the complaint was made.
// Each moves deadlines, so it is refused with the reason, never kept.
const STEP_LABEL = {
  acknowledged_on: 'acknowledged', responded_on: 'their response', final_response_on: 'their final response',
  stage_started_on: 'the current stage started',
};
export function stepDatesProblem(c, today = todayISO()) {
  if (c.raised_on && c.raised_on > today) return `The date it was made (${readable(c.raised_on)}) is in the future.`;
  for (const [k, label] of Object.entries(STEP_LABEL)) {
    const v = c[k];
    if (!v) continue;
    if (v > today) return `The date ${label} (${readable(v)}) is in the future.`;
    if (c.raised_on && v < c.raised_on) return `The date ${label} (${readable(v)}) is before the complaint was made (${readable(c.raised_on)}).`;
  }
  return null;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    const bad = stepDatesProblem(d);
    if (bad) throw new HttpError(400, bad);
    const created = await createComplaint(d, { by: who(req) });
    scheduleReview(created.id);
    res.status(201).json(await decorate(created));
  }),
);

// Say what an email that arrived actually was. Logging an email changes
// nothing by itself — a person decides whether it is their acknowledgement or
// their response, and the complaint's dates follow from that, dated the day it
// arrived (UK time).
const reviewInput = z.object({
  as: z.enum(['acknowledgement', 'response', 'correspondence']),
  // A response at Stage 1 that is their FINAL response (an FCA final
  // response, a deadlock letter): the ombudsman's clock runs from it.
  final: z.boolean().optional(),
  // The date on THEIR email. Defaults to what the AI read from it, then to the
  // day it arrived — for a forward, the arrival date is the day it was forwarded.
  date: isoDate.optional().nullable(),
  // Which organisation it is from, when the complaint has more than one
  // (null: the main organisation).
  party_id: z.string().uuid().optional().nullable(),
});

router.post(
  '/:id/emails/:emailId/review',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) {
      throw new HttpError(400, 'Invalid email id');
    }
    const d = parse(reviewInput, req.body);
    const em = (
      await query('SELECT * FROM complaint_emails WHERE id = $1 AND complaint_id = $2', [
        req.params.emailId, req.params.id,
      ])
    ).rows[0];
    if (!em) throw new HttpError(404, 'Email not found on this complaint');
    // An email of an organisation taken off the complaint never sets another's
    // dates (a person who knows better records the step with its own button).
    if (em.removed_org && d.as !== 'correspondence') {
      throw new HttpError(409, (em.removed_org === LANDLORD
        ? 'This email is with the landlord, not the organisation, so it can’t set the complaint’s dates. '
        : `This email is from ${em.removed_org}, which was taken off this complaint, so it can’t set anyone else’s dates. `) +
        'Mark it as correspondence. If a date really needs recording, use the step buttons (Record acknowledgement…, Record their response…).');
    }
    const track = await loadTrack(req.params.id, d.as === 'correspondence' ? null : d.party_id);
    const complaint = track.row; // the organisation's track the step is recorded on
    const partyId = track.party?.id || null;
    const on = d.date || em.analysis?.sent_on || londonDateOf(new Date(em.received_at));
    if (on > todayISO()) throw new HttpError(400, 'That date is in the future');
    const subject = em.subject || '(no subject)';

    const cid = req.params.id;
    // What it changes, kept on the email (`applied`, as an automatic record
    // is) so Undo puts back exactly what was there. One transaction: the
    // email is never left marked with its dates unrecorded.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Once only: a double-click, or two people at once, can't record it twice.
      const marked = await client.query(
        `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3, party_id = $4
          WHERE id = $1 AND reviewed_at IS NULL`,
        [em.id, d.as, who(req), partyId],
      );
      if (!marked.rowCount) throw new HttpError(409, 'This email has already been dealt with.');
      // The organisation's dates as they are NOW (locked), so what Undo puts
      // back is what was really there, whatever was recorded a moment ago.
      const row = (await client.query(`SELECT * FROM ${track.table} WHERE id = $1 FOR UPDATE`, [complaint.id])).rows[0];
      const changes = d.as === 'acknowledgement'
        ? { acknowledged_on: on }
        : d.as === 'response'
          ? { responded_on: on, ...(row.stage === 'stage_2' || d.final || em.analysis?.kind === 'final_response' ? { final_response_on: on } : {}) }
          : {};
      const before = Object.fromEntries(Object.keys(changes).map((k) => [k, row[k] ?? null]));
      // Replacing a date already recorded is allowed, but never silently.
      const replacing =
        d.as === 'acknowledgement' && row.acknowledged_on && row.acknowledged_on !== on
          ? `acknowledged: ${readable(row.acknowledged_on)} → ${readable(on)}`
          : d.as === 'response' && row.responded_on && row.responded_on !== on
            ? `responded: ${readable(row.responded_on)} → ${readable(on)}`
            : null;
      if (replacing) {
        await client.query(
          `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
           VALUES ($1,$2,$3,'note',$4,$5)`,
          [cid, partyId, todayISO(), `Details corrected: ${replacing} (from the email "${subject}")`, who(req)],
        );
      }
      let eventId = null;
      const cols = Object.keys(changes);
      if (cols.length) {
        await client.query(
          `UPDATE ${track.table} SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [complaint.id, ...cols.map((k) => changes[k])],
        );
        const note = d.as === 'acknowledgement'
          ? `Acknowledged by email: ${subject}`
          : `${row.stage === 'stage_2' ? 'Final (Stage 2)' : 'Stage 1'} response by email: ${subject}`;
        eventId = (await client.query(
          `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
           VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
          [cid, partyId, on, d.as === 'acknowledgement' ? 'acknowledged' : 'response_received', note, who(req)],
        )).rows[0].id;
        await client.query('UPDATE complaint_emails SET applied = $2 WHERE id = $1', [
          em.id,
          JSON.stringify({ before, after: changes, event_id: eventId, kind: em.analysis?.kind || null, party_id: partyId, by: who(req) }),
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await recomputeTrack(track);
    scheduleReview(cid);
    res.json(await decoratedById(cid));
  }),
);

// Undo what was recorded automatically from an email.
router.post(
  '/:id/emails/:emailId/undo',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) {
      throw new HttpError(400, 'Invalid email id');
    }
    const em = (
      await query('SELECT * FROM complaint_emails WHERE id = $1 AND complaint_id = $2', [
        req.params.emailId, req.params.id,
      ])
    ).rows[0];
    if (!em) throw new HttpError(404, 'Email not found on this complaint');
    if (!em.applied) throw new HttpError(400, 'Nothing was recorded automatically from this email');
    await undoEmail(em, who(req));
    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    res.json(await decorate(rows[0]));
  }),
);

// A person answers the doubt a re-check raised (complaint_doubt): it IS a
// complaint; keep the recorded date; or use the date the emails show (which
// re-dates the complaint, as Edit details would). Written on the timeline.
const doubtInput = z.object({ answer: z.enum(['is_complaint', 'keep_date', 'use_date']) });
router.post(
  '/:id/doubt',
  asyncHandler(async (req, res) => {
    const d = parse(doubtInput, req.body || {});
    const c = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Complaint not found');
    const doubt = c.complaint_doubt;
    if (!doubt || doubt.answered) throw new HttpError(409, 'There is no open question about this complaint.');
    const fits = (d.answer === 'is_complaint' && doubt.kind === 'not_complaint') ||
      (d.answer !== 'is_complaint' && doubt.kind === 'raised_date');
    if (!fits) throw new HttpError(400, 'That answer is for a different question.');
    let note;
    if (d.answer === 'use_date') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(doubt.date || '') || doubt.date > todayISO()) throw new HttpError(400, 'The date from the emails isn’t usable; correct it with Edit details.');
      // Claimed on the value the page saw, so two presses can't apply it twice.
      const r = await query(
        `UPDATE complaints
            SET raised_on = $2,
                stage_started_on = CASE WHEN stage = 'stage_1' THEN $2 ELSE stage_started_on END,
                complaint_doubt = NULL
          WHERE id = $1 AND complaint_doubt IS NOT NULL AND raised_on = $3 RETURNING id`,
        [c.id, doubt.date, c.raised_on],
      );
      if (!r.rows[0]) throw new HttpError(409, 'It has changed since; reload the page.');
      await recomputeDeadlines(c.id);
      note = `Details corrected: date raised: ${ukDate(c.raised_on)} → ${ukDate(doubt.date)} (the date the emails show the complaint was made${doubt.quote ? `: "${doubt.quote}"` : ''})`;
    } else {
      await query(`UPDATE complaints SET complaint_doubt = complaint_doubt || '{"answered": true}'::jsonb WHERE id = $1`, [c.id]);
      note = d.answer === 'is_complaint'
        ? 'Confirmed as a complaint (the re-check had found no email clearly making one).'
        : `Kept the recorded date raised, ${ukDate(c.raised_on)} (the emails suggested ${ukDate(doubt.date)}).`;
    }
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
      [c.id, todayISO(), note, who(req)],
    );
    scheduleReview(c.id);
    res.json(await decoratedById(c.id));
  }),
);

// "Looks right": a person has checked a complaint the system created itself.
router.post(
  '/:id/checked',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Invalid id');
    const { rows } = await query(
      `UPDATE complaints SET needs_check = false, checked_at = now(), checked_by = $2
        WHERE id = $1 AND needs_check RETURNING id`,
      [req.params.id, who(req)],
    );
    if (rows[0]) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [req.params.id, todayISO(), 'Details checked and confirmed.', who(req)],
      );
    }
    const c = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Complaint not found');
    // The next one waiting, so a batch of imports is checked one after another.
    const left = (await query(
      `SELECT id FROM complaints WHERE needs_check AND id <> $1 ORDER BY raised_on DESC, created_at`,
      [req.params.id],
    )).rows;
    res.json({ ...(await decorate(c)), next_to_check: left[0]?.id || null, left_to_check: left.length });
  }),
);

// Refresh the AI review now, rather than waiting for the next change.
router.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    if (!config.anthropic.enabled) throw new HttpError(503, 'The AI assistant is not configured.');
    // Written now, so one already queued would only repeat it (and be paid twice).
    cancelScheduledReview(req.params.id);
    await refreshReview(req.params.id);
    cancelScheduledReview(req.params.id);
    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    res.json(await decorate(rows[0]));
  }),
);

// Add a timeline event (chase, acknowledged, response received, note, …).
const eventInput = z.object({
  event_date: isoDate,
  type: z.enum([
    'raised', 'acknowledged', 'chased', 'response_received', 'escalated',
    'resolved', 'deadline_missed', 'note',
  ]),
  note: z.string().optional().nullable(),
  // A step taken with a further organisation on the complaint (null: the
  // main organisation, or the complaint as a whole for a note).
  party_id: z.string().uuid().optional().nullable(),
  // A response at Stage 1 that is their FINAL response (an FCA final
  // response from a debt collector, an energy deadlock letter): there is no
  // Stage 2, and the ombudsman's clock runs from it.
  final: z.boolean().optional(),
});

router.post(
  '/:id/events',
  asyncHandler(async (req, res) => {
    const d = parse(eventInput, req.body);
    const track = await loadTrack(req.params.id, d.party_id);
    if (d.event_date > todayISO()) throw new HttpError(400, `${readable(d.event_date)} is in the future: record a step on the day it happened.`);
    const madeOn = track.row.raised_on;
    if (['acknowledged', 'response_received', 'escalated', 'resolved'].includes(d.type) && madeOn && d.event_date < madeOn) {
      throw new HttpError(400, `${readable(d.event_date)} is before the complaint was made (${readable(madeOn)}).`);
    }
    const partyId = track.party?.id || null;

    await query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [req.params.id, partyId, d.event_date, d.type, d.note || null, who(req)],
    );

    // Side effects: certain event types update that organisation's track.
    if (d.type === 'acknowledged') {
      await query(`UPDATE ${track.table} SET acknowledged_on = $2 WHERE id = $1`, [
        track.row.id, d.event_date,
      ]);
    } else if (d.type === 'response_received') {
      // A Stage 2 response is their final one — the date many schemes count
      // the referral window from.
      await query(
        `UPDATE ${track.table} SET responded_on = $2,
                final_response_on = CASE WHEN stage = 'stage_2' OR $3 THEN $2::date ELSE final_response_on END
          WHERE id = $1`,
        [track.row.id, d.event_date, Boolean(d.final)],
      );
    } else if (d.type === 'resolved') {
      // That organisation's part is over. The complaint as a whole stays open
      // while another organisation's part of it is still running.
      if (track.party) {
        await query(
          `UPDATE complaint_parties SET state = 'resolved', stage = 'resolved', closed_on = $2, outcome = $3
            WHERE id = $1`,
          [track.party.id, d.event_date, d.note || null],
        );
      } else {
        await query(`UPDATE complaints SET stage = 'resolved', closed_on = $2 WHERE id = $1`, [
          req.params.id, d.event_date,
        ]);
      }
      await settleOverall(req.params.id);
      // A "Looks resolved" prompt about this organisation's part is answered.
      await query(
        `UPDATE complaints SET resolution_suggested = NULL
          WHERE id = $1 AND (COALESCE(resolution_suggested->>'party_id', '') = COALESCE($2::text, '') OR state <> 'open')`,
        [req.params.id, partyId],
      );
    }

    // An acknowledgement can move the Stage 1 date (where their clock runs
    // from it) and a final response starts the referral window.
    await recomputeTrack(track);
    scheduleReview(req.params.id);
    res.status(201).json(await decoratedById(req.params.id));
  }),
);

// Escalate to the next stage. The new stage's clock starts on the date given
// (the day the Stage 2 request went in), and its deadline is worked out again.
const escalateInput = z.object({
  date: isoDate.optional().nullable(),
  party_id: z.string().uuid().optional().nullable(),
  // Straight to the ombudsman from either stage (energy after 8 weeks, for
  // one): recorded as referred, not moved up one stage.
  to: z.enum(['ombudsman']).optional().nullable(),
});

router.post(
  '/:id/escalate',
  asyncHandler(async (req, res) => {
    const d = parse(escalateInput, req.body || {});
    await escalateTrack(req.params.id, d.party_id, d.date, who(req), { to: d.to || null });
    res.json(await decoratedById(req.params.id));
  }),
);

// Move one organisation's track on to its next stage (Stage 2, then the
// ombudsman), its clock starting on `date`. Shared by the Escalate button
// and "Send it and escalate to Stage 2".
// The organisation a Stage 2 request we sent is for, when that is certain:
// with one organisation, the complaint itself (if it is at Stage 1); with
// more, the one whose domain it was sent to. Null otherwise: then it is only
// sent, and a person records the step.
async function stage2TrackFor(complaintId, to) {
  const complaint = (await query('SELECT * FROM complaints WHERE id = $1', [complaintId])).rows[0];
  const parties = (await query('SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at', [complaintId])).rows;
  if (!parties.length) return complaint.stage === 'stage_1' ? { party: null } : null;
  const orgIds = [complaint, ...parties].map((t) => t.organisation_id).filter(Boolean);
  const orgs = orgIds.length
    ? (await query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
    : [];
  const domains = new Set(to.map((a) => String(a).toLowerCase().split('@')[1]).filter(Boolean));
  const hits = tracksOf(complaint, parties, orgs).filter((t) => t.domain && domains.has(t.domain));
  return hits.length === 1 && hits[0].row.stage === 'stage_1' ? { party: hits[0].party } : null;
}

// A person confirms the Stage 2 request the page found (stage2_missed):
// escalated from the day it was sent and recorded on that email, so Undo on
// the email takes it back (stage can't be set in Edit details).
router.post(
  '/:id/stage2-missed/:emailId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.emailId).success) throw new HttpError(400, 'Invalid id');
    const m = ((await stage2MissedFor([req.params.id])).get(req.params.id) || []).find((x) => x.email_id === req.params.emailId);
    if (!m) throw new HttpError(409, 'That email isn’t waiting to be recorded as the Stage 2 request any more; reload the page.');
    await escalateFromEmail(req.params.id, m.party_id, m.sent_on, who(req), m.email_id);
    await query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
      [req.params.id, m.party_id, m.sent_on, `Moved to Stage 2 from ${ukDate(m.sent_on)}: the email "${m.subject}" was the Stage 2 request. If that's wrong, press Undo on that email.`, who(req)],
    );
    res.json(await decoratedById(req.params.id));
  }),
);

// Stage 2 requests we sent that the complaint hasn't caught up with
// (complaintRules.js#missedStage2Requests), for one complaint or several.
async function stage2MissedFor(ids) {
  if (!ids.length) return new Map();
  const complaints = (await query(`SELECT id, org_name, stage, state, raised_on, removed_orgs FROM complaints WHERE id = ANY($1::uuid[])`, [ids])).rows;
  const parties = (await query(`SELECT id, complaint_id, org_name, stage, state, raised_on FROM complaint_parties WHERE complaint_id = ANY($1::uuid[])`, [ids])).rows;
  const emails = (await query(
    `SELECT id, complaint_id, subject, COALESCE(body_text, body_preview) AS body, party_id, direction = 'outbound' AS from_here,
            sender_email, to_addresses,
            analysis->>'our_step' AS our_step,
            CASE WHEN analysis->>'sent_on' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN analysis->>'sent_on'
                 ELSE to_char((received_at AT TIME ZONE 'Europe/London')::date, 'YYYY-MM-DD') END AS sent_on
       FROM complaint_emails
      WHERE complaint_id = ANY($1::uuid[]) AND (direction = 'outbound' OR analysis->>'kind' = 'our_email')
        -- An organisation taken off the complaint: its Stage 2 request never moves another's part.
        AND removed_org IS NULL`,
    [ids],
  )).rows;
  const events = (await query(
    `SELECT complaint_id, type, party_id, to_char(event_date, 'YYYY-MM-DD') AS event_date, note FROM complaint_events
      WHERE complaint_id = ANY($1::uuid[]) AND removed_org IS NULL
        AND (type = 'escalated' OR note LIKE 'Details corrected:%' OR note LIKE 'Automatic record from the email%' OR note ~ '^What .+ recorded from the email')`,
    [ids],
  )).rows;
  const out = new Map();
  const kept = await keptDomainsFor(ids);
  for (const c of complaints) {
    const tracks = [
      { party_id: null, org_name: c.org_name, stage: c.stage, state: c.state, raised_on: c.raised_on },
      ...parties.filter((p) => p.complaint_id === c.id).map((p) => ({ party_id: p.id, org_name: p.org_name, stage: p.stage, state: p.state, raised_on: p.raised_on })),
    ];
    const own = emails.filter((e) => e.complaint_id === c.id && !offEmail(e, c.removed_orgs || [], config.complaintEmail.domain, kept.get(c.id) || []));
    out.set(c.id, missedStage2Requests(tracks, own, events.filter((e) => e.complaint_id === c.id)));
  }
  return out;
}

// At start-up: a Stage 2 request sent FROM HERE that didn't move its
// organisation on (sent before its words were recognised) does now, dated the
// day it was sent — what Send does today. Only certain ones; anything else is
// offered on the complaint page for a person to confirm.
export async function escalateMissedStage2Requests() {
  const ids = (await query(
    `SELECT DISTINCT c.id FROM complaints c
       LEFT JOIN complaint_parties p ON p.complaint_id = c.id
      WHERE c.state = 'open' AND (c.stage = 'stage_1' OR p.stage = 'stage_1')`,
  )).rows.map((r) => r.id);
  let n = 0;
  for (const [id, list] of await stage2MissedFor(ids)) {
    for (const m of list.filter((x) => x.certain && x.from_here)) {
      try {
        await escalateFromEmail(id, m.party_id, m.sent_on, 'Automatic (Stage 2 request sent from here)', m.email_id);
        await query(
          `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
          [id, m.party_id, m.sent_on,
            `Moved to Stage 2 from ${ukDate(m.sent_on)}: the email sent from here that day, "${m.subject}", asked for Stage 2, but it wasn't recognised as the request at the time. If that's wrong, press Undo on that email.`,
            'Automatic (Stage 2 request sent from here)'],
        );
        scheduleReview(id);
        n += 1;
      } catch (err) {
        console.error(`[complaints] Stage 2 catch-up for ${id}:`, err.message);
      }
    }
  }
  return n;
}

// Escalate because of an email of ours (the Stage 2 request sent from here,
// or found afterwards), recorded on that email like any automatic record, so
// the page shows it there with **Undo** (complaintEmailProcessor#undoEmail):
// the stage and dates as they were, and the escalated entry removed. Stage
// can't be set in Edit details, so without this a wrong escalation could not
// be taken back. Without an email row (it couldn't be stored) it is simply
// escalated.
const TRACK_COLS = ['stage', 'stage_started_on', 'responded_on', 'final_response_on', 'response_due_manual'];
async function escalateFromEmail(complaintId, partyId, date, by, emailId, { to = null } = {}) {
  const table = partyId ? 'complaint_parties' : 'complaints';
  const rowOf = async () => (await query(`SELECT ${TRACK_COLS.join(', ')} FROM ${table} WHERE id = $1`, [partyId || complaintId])).rows[0];
  const before = await rowOf();
  await escalateTrack(complaintId, partyId, date, by, { to });
  if (!emailId || !before) return;
  const after = await rowOf();
  const ev = (await query(
    `SELECT id FROM complaint_events WHERE complaint_id = $1 AND type = 'escalated' AND party_id IS NOT DISTINCT FROM $2
      ORDER BY created_at DESC LIMIT 1`,
    [complaintId, partyId || null],
  )).rows[0];
  const iso = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v ?? null);
  const pick = (r) => Object.fromEntries(TRACK_COLS.map((k) => [k, iso(r[k])]));
  await query(
    `UPDATE complaint_emails SET applied = $2, party_id = COALESCE(party_id, $3) WHERE id = $1 AND applied IS NULL`,
    [emailId, JSON.stringify({ before: pick(before), after: pick(after), event_id: ev?.id || null, party_id: partyId || null }), partyId || null],
  );
}

async function escalateTrack(complaintId, partyId, date, by, { to = null } = {}) {
    const track = await loadTrack(complaintId, partyId);
    const complaint = track.row;

    const next =
      to === 'ombudsman' && ['stage_1', 'stage_2'].includes(complaint.stage) ? 'ombudsman' :
      complaint.stage === 'stage_1' ? 'stage_2' :
      complaint.stage === 'stage_2' ? 'ombudsman' : null;
    if (!next) throw new HttpError(400, 'Complaint cannot be escalated further');

    const escalatedOn = date || todayISO();
    if (escalatedOn > todayISO()) throw new HttpError(400, 'That date is in the future');
    const { rule } = await ruleForComplaint(complaint);

    // Assignments read the row as it was, so a Stage 2 response recorded as
    // responded_on is kept as the final response before it is cleared.
    await query(
      `UPDATE ${track.table}
          SET final_response_on = COALESCE(final_response_on,
                CASE WHEN stage = 'stage_2' THEN responded_on END),
              stage = $2, stage_started_on = $3, responded_on = NULL,
              response_due_manual = false
        WHERE id = $1`,
      [complaint.id, next, escalatedOn],
    );
    await query(
      `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
       VALUES ($1,$2,$3,'escalated',$4,$5)`,
      [
        complaintId, track.party?.id || null, escalatedOn,
        next === 'ombudsman'
          ? `Referred to ${theOmbudsman(rule.ombudsman)}`
          : 'Escalated to Stage 2',
        by,
      ],
    );

    // Referred before the scheme could take it (by the dates on file): kept,
    // since it happened, but said plainly so nobody assumes it was in time.
    if (next === 'ombudsman') {
      // The dates alone (a person is recording what they did, so the
      // "not checked" rule doesn't apply), on the day it was referred.
      // Dates only: whether the scheme's record has been checked yet says
      // nothing about whether this referral was in time.
      const { scheme, ...bare } = rule;
      const datesRule = scheme ? { ...rule, scheme: { ...scheme, verified: true } } : bare;
      const r = referralOpen({ ...complaint, needs_check: false, complaint_doubt: null,
        ombudsman_from: computeOmbudsmanFrom(complaint, datesRule), rule: datesRule }, escalatedOn);
      if (!r.open) {
        await query(
          `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by) VALUES ($1,$2,$3,'note',$4,$5)`,
          [complaintId, track.party?.id || null, escalatedOn,
            `Note: by the dates on file, on ${ukDate(escalatedOn)} ${r.why}, so they may turn this referral away. Check the dates if that's wrong.`,
            by],
        );
      }
    }
    await recomputeTrack(track);
    scheduleReview(complaintId);
}

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input.partial(), req.body);
    const existing = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]))
      .rows[0];
    if (!existing) throw new HttpError(404, 'Complaint not found');
    {
      const merged = { ...existing };
      for (const k of ['raised_on', ...Object.keys(STEP_LABEL)]) if (d[k] !== undefined) merged[k] = d[k];
      // Only what this edit changes is held to the rule: a date already on
      // file (an import's) is never a reason to refuse an unrelated fix.
      const touched = ['raised_on', ...Object.keys(STEP_LABEL)].some((k) => d[k] !== undefined);
      const bad = touched ? stepDatesProblem(merged) : null;
      if (bad) throw new HttpError(400, bad);
    }

    // Linking an organisation brings its type with it: the type decides the
    // default for anything its procedure doesn't state.
    let orgType = d.org_type;
    if (d.organisation_id) {
      const dup = (await query(
        'SELECT org_name FROM complaint_parties WHERE complaint_id = $1 AND organisation_id = $2', [req.params.id, d.organisation_id],
      )).rows[0];
      if (dup) throw new HttpError(400, `${dup.org_name} is already on this complaint as a further organisation. Take it off there first.`);
    }
    if (d.organisation_id) {
      const org = (await query('SELECT type FROM organisations WHERE id = $1', [d.organisation_id]))
        .rows[0];
      if (!org) throw new HttpError(400, 'That organisation no longer exists');
      orgType = org.type;
    }

    // A due date typed in is kept through recalculation; clearing it hands the
    // date back to the procedure. Entering the Stage 2 request date on an
    // import that had none lets the procedure date it from then on.
    let manual;
    if (d.response_due !== undefined) manual = d.response_due !== null;
    else if (d.stage_started_on && existing.response_due_manual && !existing.response_due) {
      manual = false;
    }

    // At Stage 1 the clock starts the day the complaint was made, so correcting
    // that date moves the start with it.
    const stageStarted =
      existing.stage === 'stage_1' && d.raised_on ? d.raised_on : d.stage_started_on;

    // Update only the sent fields; an explicit null clears a nullable column
    // instead of being ignored. org_name/subject/raised_on are NOT NULL.
    const { clause, values } = buildUpdateSet({
      organisation_id: d.organisation_id,
      org_name: d.org_name,
      org_type: orgType,
      reference: d.reference,
      our_reference: d.our_reference,
      account_numbers: d.account_numbers && dropDigitSlips(d.account_numbers).kept,
      property: d.property,
      subject: d.subject,
      category: d.category,
      description: d.description,
      channel: d.channel,
      raised_on: d.raised_on,
      stage_started_on: stageStarted,
      acknowledged_on: d.acknowledged_on,
      responded_on: d.responded_on,
      final_response_on: d.final_response_on,
      response_due: d.response_due,
      response_due_manual: manual,
      outcome_wanted: d.outcome_wanted === undefined ? undefined : d.outcome_wanted || null,
      losses: d.losses === undefined ? undefined : d.losses || null,
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    await query(`UPDATE complaints SET ${clause} WHERE id = $1`, [req.params.id, ...values]);
    // The date it was made was corrected by hand: a question about it is answered.
    if (d.raised_on && d.raised_on !== existing.raised_on && existing.complaint_doubt?.kind === 'raised_date') {
      await query('UPDATE complaints SET complaint_doubt = NULL WHERE id = $1', [req.params.id]);
    }
    const updated = await recomputeDeadlines(req.params.id);

    // Nothing changes silently: every corrected field goes on the timeline
    // with what it was and what it is now, and who changed it.
    const changes = describeChanges(existing, updated);
    if (changes.length) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1, $2, 'note', $3, $4)`,
        [req.params.id, todayISO(), `Details corrected: ${changes.join('; ')}`, who(req)],
      );
    }
    scheduleReview(req.params.id);
    res.json(await decorate(updated));
  }),
);

// --- Further organisations on one complaint (migration 029) ---------------
// A debt collector and the supplier it collects for (LCS and British Gas) are
// one issue with two complaints procedures. Each further organisation has its
// own reference, stage and deadlines, recorded with the same steps as the
// main one (party_id on /events, /escalate and email review).
const partyInput = z.object({
  organisation_id: z.string().uuid().optional().nullable(),
  org_name: z.string().trim().min(1).max(200),
  org_type: z.enum(ORG_TYPES).optional(),
  relationship: z.string().trim().max(200).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  raised_on: isoDate,
  channel: z.enum(['email', 'phone', 'portal', 'letter', 'other']).optional().nullable(),
  stage: z.enum(['stage_1', 'stage_2', 'ombudsman']).optional(),
  stage_started_on: isoDate.optional().nullable(),
  acknowledged_on: isoDate.optional().nullable(),
  responded_on: isoDate.optional().nullable(),
  final_response_on: isoDate.optional().nullable(),
  response_due: isoDate.optional().nullable(),
});

// Dates that can't be right are refused rather than stored.
function checkPartyDates(d) {
  const today = todayISO();
  for (const k of ['raised_on', 'stage_started_on', 'acknowledged_on', 'responded_on', 'final_response_on']) {
    if (d[k] && d[k] > today) throw new HttpError(400, `The ${k.replace(/_/g, ' ')} date is in the future`);
  }
  for (const k of ['acknowledged_on', 'responded_on', 'final_response_on', 'stage_started_on']) {
    if (d[k] && d.raised_on && d[k] < d.raised_on) {
      throw new HttpError(400, `The ${k.replace(/_/g, ' ')} date is before the complaint was made to them`);
    }
  }
}

// The organisation a party links to brings its name's type with it, as the
// main organisation's does.
async function orgTypeFor(orgId) {
  if (!orgId) return null;
  const org = (await query('SELECT type FROM organisations WHERE id = $1', [orgId])).rows[0];
  if (!org) throw new HttpError(400, 'That organisation no longer exists');
  return org.type;
}

// Add a further organisation to a complaint: its own track, dated from when
// the complaint was made to them. Shared by "+ Another organisation" and
// "Raise it with the supplier too".
async function createParty(complaintId, d, by) {
  checkPartyDates(d);
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [complaintId])).rows[0];
  if (!c) throw new HttpError(404, 'Complaint not found');
  if (d.organisation_id && d.organisation_id === c.organisation_id) {
    throw new HttpError(400, `${c.org_name} is already the main organisation on this complaint.`);
  }
  const type = (await orgTypeFor(d.organisation_id)) || d.org_type || 'other';
  const stage = d.stage || 'stage_1';
  // A complaint that had ended is open again with a new organisation's part
  // running. Its main track is marked as ended first, so it doesn't read as
  // back at the stage it finished on.
  if (c.state !== 'open' && trackOpen({ ...c, state: 'open' })) {
    await query('UPDATE complaints SET stage = state WHERE id = $1', [c.id]);
  }
  let party;
  try {
    party = (await query(
      `INSERT INTO complaint_parties
         (complaint_id, organisation_id, org_name, org_type, relationship, reference, raised_on, channel,
          stage, stage_started_on, acknowledged_on, responded_on, final_response_on,
          response_due, response_due_manual, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [
        c.id, d.organisation_id || null, d.org_name, type, d.relationship || null, d.reference || null,
        d.raised_on, d.channel || null, stage,
        d.stage_started_on || (stage === 'stage_1' ? d.raised_on : null),
        d.acknowledged_on || null, d.responded_on || null,
        d.final_response_on || (stage === 'stage_2' ? d.responded_on || null : null),
        d.response_due || null, Boolean(d.response_due), by,
      ],
    )).rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `${d.org_name} is already on this complaint.`);
    throw err;
  }
  await recomputePartyDeadlines(party.id);
  await query(
    `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
     VALUES ($1,$2,$3,'raised',$4,$5)`,
    [
      c.id, party.id, d.raised_on,
      d.raisedNote ||
        `Complaint also made to ${d.org_name}${d.relationship ? ` (${d.relationship})` : ''}` +
          `${d.reference ? `, their reference ${d.reference}` : ''}.`,
      by,
    ],
  );
  await settleOverall(c.id);
  scheduleReview(c.id);
  return party;
}

router.post(
  '/:id/parties',
  asyncHandler(async (req, res) => {
    const d = parse(partyInput, req.body);
    await createParty(req.params.id, d, who(req));
    res.status(201).json(await decoratedById(req.params.id));
  }),
);

// --- Raise it with the supplier too ----------------------------------------
// A complaint against a debt collector (LCS) is about a bill that belongs to
// the supplier (British Gas): the supplier has to issue the right bill and can
// recall the account from collection, so the complaint is raised with them as
// well and joined to this one. The AI drafts that complaint from everything
// on file; a person checks it, then either sends it from here (which adds the
// supplier to the complaint, dated today) or sends it from Outlook and adds
// them with the date it went.
// "Not needed": Greenco doesn't raise it with this organisation (it never
// deals with them). Remembered on the complaint, so the review never
// suggests them again (complaintReview.js#declinedSupplier). No AI.
router.post(
  '/:id/supplier/decline',
  asyncHandler(async (req, res) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(200) }), req.body);
    const { rows } = await query(
      `UPDATE complaints SET supplier_declined = array_append(supplier_declined, $2)
        WHERE id = $1 AND NOT ($2 = ANY(supplier_declined)) RETURNING id`,
      [req.params.id, name],
    );
    if (rows.length) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [req.params.id, todayISO(), `Not raising it with ${name}: marked not needed.`, req.user?.name || req.user?.email || null],
      );
    }
    const c = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Complaint not found');
    res.json(await decorate(c));
  }),
);

const supplierDraftInput = z.object({
  organisation_id: z.string().uuid().optional().nullable(),
  org_name: z.string().trim().min(1).max(200),
});
router.post(
  '/:id/supplier/draft',
  asyncHandler(async (req, res) => {
    if (!config.anthropic.enabled) throw new HttpError(503, 'The AI isn’t configured, so the complaint can’t be drafted.');
    const d = parse(supplierDraftInput, req.body);
    const org = d.organisation_id
      ? (await query('SELECT name, complaints_email FROM organisations WHERE id = $1', [d.organisation_id])).rows[0]
      : null;
    // They already have a complaint about this account: combine, don't draft
    // a second one (and spend nothing on it).
    const supplierName = org?.name || d.org_name;
    const theirs = (await sameAccountComplaints({ id: req.params.id })).find((o) => o.org_names.some((n) => sameOrgName(n, supplierName)));
    if (theirs) {
      throw new HttpError(409, `There is already a complaint with ${supplierName} about this account (${theirs.ref_code}, made ${readable(theirs.raised_on)}). Combine the two complaints (the button at the top of this page) rather than raising a new one.`);
    }
    const ctx = await gatherContext(req.params.id, undefined, { files: 2 });
    const c = ctx.complaint;
    const name = org?.name || d.org_name;
    const r = await assistComplaint({
      ...ctx,
      feature: 'Supplier complaint draft',
      newComplaintTo: name,
      instruction:
        `Draft a FORMAL COMPLAINT email from Greenco to ${name}, the company that owns this account, which ` +
        `${c.org_name} is pursuing on their behalf. It is a NEW complaint to ${name} (not a reply to ${c.org_name}). ` +
        'Keep it short and natural (see how the emails read). It must: say in the first sentence that this is ' +
        `a formal complaint; give the account number(s) and ${c.org_name}'s reference on one line; say briefly, ` +
        'with the key dates, what went wrong (for example the final bill never issued, fees added, the ' +
        'account passed to collection while disputed); and ask them, by a date 10 working days from today, to ' +
        `put the account on hold and recall it from ${c.org_name} while the complaint is open, put the bill ` +
        'right and remove any charges added because of their error, and acknowledge the complaint with their ' +
        'reference. Use only facts in the context; put [square brackets] only where a fact is genuinely ' +
        'unknown. In "email" give the subject ' +
        'and the full body, greeting to sign-off (signed off with the [Name] and [Job title] placeholders, as always).',
    });
    res.json({
      to: org?.complaints_email || null,
      subject: r.email?.subject || '',
      // Always the standard sign-off, so the sender's own name goes on it;
      // the references of the organisations already on it, by name.
      body: withReferences(ensureSignOff(r.email?.body || ''), referenceLines(tracksForReview(c), null)),
      caution: r.caution || null,
      // The documents the draft goes with, chosen by the AI from those on file.
      attachment_ids: r.email?.attachment_ids || [],
    });
  }),
);

// ---------------------------------------------------------------------------
// Raising it as a FORMAL complaint, when the emails show none was ever made
// (complaint_doubt 'not_complaint': a dispute or a query that never became a
// complaint). The AI drafts the formal complaint under their procedure (one
// call); sent from here (in the background) or from Outlook, the complaint is
// then started from that day: Stage 1, every deadline and the ombudsman clock
// running from the formal complaint, never from the earlier emails.
// ---------------------------------------------------------------------------
router.post(
  '/:id/formal/draft',
  asyncHandler(async (req, res) => {
    if (!config.anthropic.enabled) throw new HttpError(503, 'The AI isn’t configured, so the complaint can’t be drafted.');
    const row = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (!row) throw new HttpError(404, 'Complaint not found');
    // The first email of a complaint logged before it was sent: nothing on it
    // but what was typed in and the documents uploaded, so the documents are
    // read in full (one call, pressed by a person).
    const first = awaitingFirstEmail(row);
    const ctx = await gatherContext(req.params.id, undefined, first ? {} : { files: 2 });
    const c = ctx.complaint;
    const days = c.rule?.defaulted?.includes('stage1Days') ? null : c.rule?.stage1Days;
    const r = await assistComplaint({
      ...ctx,
      feature: first ? 'First complaint email draft' : 'Formal complaint draft',
      newComplaintTo: c.org_name,
      instruction:
        (first
          ? `This complaint has been logged here but NOT yet sent to ${c.org_name}. The details, the outcome we want and ` +
            'the documents describe it; an earlier email of ours in the documents that asked them to put it right is ' +
            'background (say briefly what we asked and when), not the complaint itself. Draft the email '
          : `The emails show a dispute with ${c.org_name} that was never made into a FORMAL complaint. Draft the email `) +
        `that makes it one: a formal complaint to ${c.org_name} under their complaints procedure` +
        `${c.rule?.procedureRef ? ` (${c.rule.procedureRef})` : ''}. Keep it short and natural (see how the emails ` +
        'read). It must: say in the first sentence that this is a formal complaint to be logged under their ' +
        'complaints procedure; give the account number(s), the property and any reference of theirs on one line; ' +
        'say briefly, with the key dates, what the problem is and what we have already asked for; say clearly ' +
        'what we want done to put it right; and ask them to acknowledge the complaint, give their reference and respond ' +
        (days ? `within ${days} working days, as their procedure sets out. ` : 'within the time their complaints procedure sets out. ') +
        'Do NOT say it has already been raised as a complaint, and do not ask for Stage 2 or mention the ombudsman. ' +
        'Use only facts in the context; put [square ' +
        'brackets] only where a fact is genuinely unknown. In "email" give the subject and the full body, greeting to ' +
        'sign-off (signed off with the [Name] and [Job title] placeholders, as always).',
    });
    res.json({
      to: c.org_email || null,
      subject: r.email?.subject || '',
      body: withReferences(ensureSignOff(r.email?.body || ''), referenceLines(tracksForReview(c), 'main')),
      caution: r.caution || null,
      // The documents the draft goes with, chosen by the AI from those on file.
      attachment_ids: r.email?.attachment_ids || [],
    });
  }),
);

const formalRaiseInput = z.object({
  send: z.object({
    to: z.string().min(3),
    cc: z.string().optional().nullable(),
    subject: z.string().min(1),
    body: z.string().min(1),
    attachment_ids: attachmentIdsInput,
  }).optional().nullable(),
  sent_on: isoDate.optional().nullable(),
});
router.post(
  '/:id/formal/raise',
  asyncHandler(async (req, res) => {
    const d = parse(formalRaiseInput, req.body);
    if (!d.send && !d.sent_on) throw new HttpError(400, 'Send the complaint from here, or give the date it was sent.');
    const c = await decoratedById(req.params.id);
    if (c.state !== 'open') throw new HttpError(409, 'This complaint is closed.');
    // Only while the question is open: starting it again later would wipe
    // the dates recorded since it was made.
    const doubtOpen = c.complaint_doubt?.kind === 'not_complaint' && !c.complaint_doubt.answered;
    if (!doubtOpen && !awaitingFirstEmail(c)) {
      throw new HttpError(409, 'This complaint is already recorded as a formal complaint.');
    }
    // One formal complaint at a time: a waiting one (sending, or failed with
    // Try again) is dealt with first, whichever way this one went.
    const formalGuard = {
      guard: { sql: `SELECT 1 FROM complaint_outbox WHERE complaint_id = $1 AND then_formal AND status <> 'sent'`, params: [c.id] },
      refusal: 'The formal complaint is already being sent, or failed and is waiting on this complaint: deal with that one first (Try again, It went, or Discard).',
    };
    if ((await query(formalGuard.guard.sql, formalGuard.guard.params)).rows[0]) throw new HttpError(409, formalGuard.refusal);
    if (d.send) {
      // The complaint starts from this email, so it has to ask for one in so
      // many words: without the word it is a request, and their clock wouldn't
      // start (usesComplaintWord, Greenco's rule).
      if (!usesComplaintWord(`${d.send.subject}\n${d.send.body}`)) {
        throw new HttpError(400, 'The email doesn’t use the word “complaint”, so it doesn’t make one: say that this is a formal complaint (for example “I am writing to make a formal complaint…”) before sending.');
      }
      if (!config.smtp.enabled) throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
      const to = parseRecipients(d.send.to);
      const cc = parseRecipients(d.send.cc);
      if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
      if (c.email_address && !cc.includes(c.email_address)) cc.push(c.email_address);
      for (const a of withExternalCc(to, cc)) if (!cc.includes(a)) cc.push(a);
      const attachmentIds = await checkAttachmentIds(c.id, d.send.attachment_ids, d.send.body);
      refuseGaps(signEmail(d.send.subject, req.user), signEmail(d.send.body, req.user));
      const out = await queueOutbox(c.id, formalGuard,
        `INSERT INTO complaint_outbox (complaint_id, to_addresses, cc_addresses, subject, body, sent_by, then_formal, attachment_ids, sender_id)
         VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id`,
        [c.id, to, cc, signEmail(d.send.subject, req.user), signEmail(d.send.body, req.user), who(req), attachmentIds, req.user?.id || null]);
      return res.status(202).json({ queued: true, outbox_id: out.id });
    }
    if (d.sent_on > todayISO()) throw new HttpError(400, 'That date is in the future');
    if (!(await startFormalComplaint(c.id, d.sent_on, who(req), { fromHere: false }))) {
      throw new HttpError(409, 'This complaint is already recorded as a formal complaint.');
    }
    res.status(201).json(await decoratedById(c.id));
  }),
);

const supplierRaiseInput = z.object({
  organisation_id: z.string().uuid().optional().nullable(),
  org_name: z.string().trim().min(1).max(200),
  org_type: z.enum(ORG_TYPES).optional(),
  // Send it from here now…
  send: z.object({
    to: z.string().min(3),
    cc: z.string().optional().nullable(),
    subject: z.string().min(1),
    body: z.string().min(1),
    attachment_ids: attachmentIdsInput,
  }).optional().nullable(),
  // …or it was sent from Outlook on this date.
  sent_on: isoDate.optional().nullable(),
});
router.post(
  '/:id/supplier/raise',
  asyncHandler(async (req, res) => {
    const d = parse(supplierRaiseInput, req.body);
    if (!d.send && !d.sent_on) throw new HttpError(400, 'Send the complaint from here, or give the date it was sent.');
    const c = await decoratedById(req.params.id);
    if (!d.send && d.sent_on > todayISO()) throw new HttpError(400, 'That date is in the future');
    const supplier = { organisation_id: d.organisation_id || null, org_name: d.org_name, org_type: d.org_type || 'supplier' };
    // Refused now, not after the email has gone: they can't join twice.
    if (supplierOnComplaint(c, c.parties || [], supplier)) throw new HttpError(409, `${d.org_name} is already on this complaint.`);
    // They already have a complaint about this account: combine the two
    // rather than start a second complaint with them.
    const theirs = (await sameAccountComplaints(c)).find((o) => o.org_names.some((n) => sameOrgName(n, d.org_name)));
    if (theirs) {
      throw new HttpError(409, `There is already a complaint with ${d.org_name} about this account (${theirs.ref_code}, made ${readable(theirs.raised_on)}). Combine the two complaints (the button at the top of this page) rather than raising a new one.`);
    }
    // One complaint to a supplier at a time: a waiting one (sending, or
    // failed with Try again) is dealt with first, whichever way this one went.
    const supplierGuard = {
      guard: { sql: `SELECT 1 FROM complaint_outbox WHERE complaint_id = $1 AND then_supplier IS NOT NULL AND status <> 'sent'`, params: [c.id] },
      refusal: 'A complaint to a supplier is already being sent, or failed and is waiting on this complaint: deal with that one first (Try again, It went, or Discard).',
    };
    if ((await query(supplierGuard.guard.sql, supplierGuard.guard.params)).rows[0]) throw new HttpError(409, supplierGuard.refusal);
    if (d.send) {
      if (!config.smtp.enabled) throw new HttpError(503, 'Email sending isn’t configured — set SMTP_USER / SMTP_PASS.');
      const to = parseRecipients(d.send.to);
      const cc = parseRecipients(d.send.cc);
      if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
      if (c.email_address && !cc.includes(c.email_address)) cc.push(c.email_address);
      for (const a of withExternalCc(to, cc)) if (!cc.includes(a)) cc.push(a);
      // In the background like every send from a complaint: the supplier
      // joins once it has gone (dated that day), and nothing is added if it
      // fails — it waits on the complaint with Try again / Discard.
      const attachmentIds = await checkAttachmentIds(c.id, d.send.attachment_ids, d.send.body);
      refuseGaps(signEmail(d.send.subject, req.user), signEmail(d.send.body, req.user));
      const out = await queueOutbox(c.id, supplierGuard,
        `INSERT INTO complaint_outbox (complaint_id, to_addresses, cc_addresses, subject, body, sent_by, then_supplier, attachment_ids, sender_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [c.id, to, cc, signEmail(d.send.subject, req.user), signEmail(d.send.body, req.user), who(req), supplier, attachmentIds, req.user?.id || null]);
      return res.status(202).json({ queued: true, outbox_id: out.id });
    }
    if (!(await joinSupplierOnce(c.id, supplier, { sentOn: d.sent_on, by: who(req) }))) {
      throw new HttpError(409, `${d.org_name} is already on this complaint.`);
    }
    res.status(201).json(await decoratedById(c.id));
  }),
);

// Whether a supplier is already on the complaint: the main organisation or
// a further one, by saved organisation or by name.
function supplierOnComplaint(c, parties, s) {
  const name = String(s.org_name).trim().toLowerCase();
  return Boolean((s.organisation_id && c.organisation_id === s.organisation_id) ||
    parties.some((p) => (s.organisation_id && p.organisation_id === s.organisation_id) ||
      p.org_name.trim().toLowerCase() === name));
}

// joinSupplier unless they are already on it, checked and joined under a
// lock on the complaint so two at once (two presses, or a send finishing as
// someone records it from Outlook) can't add them twice. False if they were.
async function joinSupplierOnce(complaintId, supplier, opts) {
  const lock = await pool.connect();
  try {
    await lock.query(`SELECT pg_advisory_lock(hashtext('complaint_supplier:' || $1))`, [complaintId]);
    const c = (await query('SELECT organisation_id FROM complaints WHERE id = $1', [complaintId])).rows[0];
    if (!c) return false;
    const parties = (await query('SELECT organisation_id, org_name FROM complaint_parties WHERE complaint_id = $1', [complaintId])).rows;
    if (supplierOnComplaint(c, parties, supplier)) return false;
    await joinSupplier(complaintId, supplier, opts);
    return true;
  } finally {
    await lock.query(`SELECT pg_advisory_unlock(hashtext('complaint_supplier:' || $1))`, [complaintId]).catch(() => {});
    lock.release();
  }
}

// The supplier joins the complaint as a further organisation, dated the day
// the complaint to them went. With an email sent from here, that email (and
// its "sent" entry) is theirs: it is not a step with the organisation already
// on the complaint.
async function joinSupplier(complaintId, supplier, { sentOn, emailId = null, subject = null, by }) {
  const c = (await query('SELECT org_name FROM complaints WHERE id = $1', [complaintId])).rows[0];
  const party = await createParty(complaintId, {
    ...supplier,
    relationship: `Owns the account ${c.org_name} is collecting`,
    raised_on: sentOn,
    channel: 'email',
    raisedNote: `Complaint raised with ${supplier.org_name} too (the account ${c.org_name} is collecting is theirs)` +
      `${emailId ? ', sent from here' : ', sent from Outlook'}.`,
  }, by);
  if (emailId) {
    await query('UPDATE complaint_emails SET party_id = $2 WHERE id = $1', [emailId, party.id]);
    const head = `Email sent: ${subject}, to `;
    await query(
      `UPDATE complaint_events SET party_id = $2
        WHERE complaint_id = $1 AND type = 'chased' AND party_id IS NULL AND event_date = $3
          AND left(note, length($4)) = $4`,
      [complaintId, party.id, sentOn, head],
    );
  }
  return party;
}

router.put(
  '/:id/parties/:partyId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.partyId).success) throw new HttpError(400, 'Invalid id');
    // The stage moves with the step buttons, not by correction.
    const d = parse(partyInput.omit({ stage: true }).partial(), req.body);
    const { party } = await loadTrack(req.params.id, req.params.partyId);
    checkPartyDates({ ...party, ...d });
    const c = (await query('SELECT organisation_id, org_name FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (d.organisation_id && d.organisation_id === c.organisation_id) {
      throw new HttpError(400, `${c.org_name} is already the main organisation on this complaint.`);
    }
    const orgType = d.organisation_id ? await orgTypeFor(d.organisation_id) : d.org_type;
    let manual;
    if (d.response_due !== undefined) manual = d.response_due !== null;
    const stageStarted = party.stage === 'stage_1' && d.raised_on ? d.raised_on : d.stage_started_on;
    const { clause, values } = buildUpdateSet({
      organisation_id: d.organisation_id,
      org_name: d.org_name,
      org_type: orgType,
      relationship: d.relationship,
      reference: d.reference,
      raised_on: d.raised_on,
      channel: d.channel,
      stage_started_on: stageStarted,
      acknowledged_on: d.acknowledged_on,
      responded_on: d.responded_on,
      final_response_on: d.final_response_on,
      response_due: d.response_due,
      response_due_manual: manual,
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    try {
      await query(`UPDATE complaint_parties SET ${clause} WHERE id = $1`, [party.id, ...values]);
    } catch (err) {
      if (err.code === '23505') throw new HttpError(409, 'That organisation is already on this complaint.');
      throw err;
    }
    const updated = await recomputePartyDeadlines(party.id);
    const changes = describeChanges(party, updated);
    if ((party.relationship || null) !== (updated.relationship || null)) {
      changes.push(`how they're involved: ${party.relationship || '(blank)'} → ${updated.relationship || '(blank)'}`);
    }
    if (changes.length) {
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
         VALUES ($1,$2,$3,'note',$4,$5)`,
        [req.params.id, party.id, todayISO(), `${updated.org_name}: details corrected: ${changes.join('; ')}`, who(req)],
      );
    }
    scheduleReview(req.params.id);
    res.json(await decoratedById(req.params.id));
  }),
);

// An organisation taken off a complaint: its emails and chasers are tagged as
// its history (exactly those counted as its correspondence now, so the rest
// keep the "last wrote / last heard" they had), its automatic records can't
// be undone onto anyone else's part, and it is remembered with the addresses
// it writes from so a later email from it is never recorded on another part.
async function recordRemoval(db, c, parties, removed) {
  const key = removed.id === c.id ? 'main' : removed.id;
  const orgIds = [c, ...parties].map((t) => t.organisation_id).filter(Boolean);
  const orgs = orgIds.length
    ? (await db.query('SELECT id, name, complaints_email FROM organisations WHERE id = ANY($1::uuid[])', [orgIds])).rows
    : [];
  const emails = (await db.query(
    `SELECT id, direction, sender_email, to_addresses, party_id,
            (received_at AT TIME ZONE 'Europe/London')::date::text AS received_on,
            analysis->>'kind' AS kind, analysis->>'sent_on' AS sent_on, analysis->>'author_org' AS author_org
       FROM complaint_emails WHERE complaint_id = $1 AND removed_org IS NULL`,
    [c.id],
  )).rows;
  const events = (await db.query(
    `SELECT id, party_id, event_date::text AS event_date, note FROM complaint_events
      WHERE complaint_id = $1 AND type = 'chased' AND removed_org IS NULL`,
    [c.id],
  )).rows;
  const tags = removalTags({ complaint: c, parties, orgs, emails, events, ourDomain: config.complaintEmail.domain }, key);
  await db.query('UPDATE complaint_emails SET removed_org = $2 WHERE id = ANY($1::uuid[])', [tags.emailIds, removed.org_name]);
  await db.query('UPDATE complaint_events SET removed_org = $2 WHERE id = ANY($1::uuid[])', [tags.eventIds, removed.org_name]);
  // Its steps (raised, acknowledged, response, escalated, resolved) are its
  // history too: never read as the remaining organisation's (a timeline
  // entry of theirs would otherwise pass for the new main organisation's).
  await db.query(
    `UPDATE complaint_events SET removed_org = $3
      WHERE complaint_id = $1 AND removed_org IS NULL
        AND type IN ('raised', 'acknowledged', 'response_received', 'escalated', 'resolved')
        AND party_id IS NOT DISTINCT FROM $2::uuid`,
    [c.id, key === 'main' ? null : key, removed.org_name],
  );
  await db.query(
    `UPDATE complaint_emails SET applied = applied || jsonb_build_object('removed_org', $2::text)
      WHERE complaint_id = $1 AND applied IS NOT NULL
        AND COALESCE(applied->>'party_id', '') = $3`,
    [c.id, removed.org_name, key === 'main' ? '' : key],
  );
  const entry = {
    name: removed.org_name, organisation_id: removed.organisation_id || null, reference: removed.reference || null,
    domains: tags.domains, removed_on: todayISO(),
  };
  await db.query(`UPDATE complaints SET removed_orgs = removed_orgs || $2::jsonb WHERE id = $1`, [c.id, JSON.stringify([entry])]);
}

// Taking an organisation off a complaint (added by mistake). Its timeline
// entries and emails stay on the complaint, no longer tied to it, and the
// removal is written on the timeline.
router.delete(
  '/:id/parties/:partyId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.partyId).success) throw new HttpError(400, 'Invalid id');
    const { party } = await loadTrack(req.params.id, req.params.partyId);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      const parties = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at', [c.id])).rows;
      await recordRemoval(client, c, parties, party);
      await client.query('DELETE FROM complaint_parties WHERE id = $1', [party.id]);
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1,$2,'note',$3,$4)`,
        [
          req.params.id, todayISO(),
          `${party.org_name} taken off this complaint` +
            `${party.reference ? ` (their reference was ${party.reference})` : ''}. ` +
            'Their emails and entries stay here as history, and any later email from them is kept as history only.',
          who(req),
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await settleOverall(req.params.id);
    scheduleReview(req.params.id);
    res.json(await decoratedById(req.params.id));
  }),
);

// Taking the MAIN organisation off a complaint with more than one: the next
// organisation (the one chosen, else the first added) takes its place, with
// its own dates, stage and reference; its timeline entries and emails become
// the complaint's own. The removed organisation's entries and emails stay on
// the complaint as history, and the change is written on the timeline. One
// transaction.
const TRACK_MOVE = ['organisation_id', 'org_name', 'org_type', 'reference', 'raised_on', 'channel', 'stage',
  'stage_started_on', 'acknowledged_on', 'responded_on', 'final_response_on', 'response_due',
  'response_due_manual', 'ombudsman_deadline', 'outcome', 'closed_on'];
router.post(
  '/:id/main/remove',
  asyncHandler(async (req, res) => {
    const d = parse(z.object({ promote_party_id: z.string().uuid().optional().nullable() }), req.body || {});
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const c = (await client.query('SELECT * FROM complaints WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!c) throw new HttpError(404, 'Complaint not found');
      const parties = (await client.query('SELECT * FROM complaint_parties WHERE complaint_id = $1 ORDER BY created_at FOR UPDATE', [c.id])).rows;
      if (!parties.length) throw new HttpError(400, 'It is the only organisation on this complaint: delete the complaint instead, or edit the organisation.');
      const next = d.promote_party_id ? parties.find((p) => p.id === d.promote_party_id) : parties[0];
      if (!next) throw new HttpError(400, 'That organisation isn’t on this complaint.');
      // Tagged while every part is still in place (before the next one moves up).
      await recordRemoval(client, c, parties, c);
      // The promoted organisation's entries become the complaint's own.
      await client.query('UPDATE complaint_events SET party_id = NULL WHERE party_id = $1', [next.id]);
      await client.query('UPDATE complaint_emails SET party_id = NULL WHERE party_id = $1', [next.id]);
      await client.query(
        `UPDATE complaint_emails SET applied = applied - 'party_id'
          WHERE complaint_id = $1 AND applied->>'party_id' = $2`,
        [c.id, next.id],
      );
      // Emails still waiting to go: those to the organisation taken off are
      // marked as to an organisation no longer on it (so they never move the
      // new main organisation's part), and the promoted one's become the
      // complaint's own. A complaint to a supplier is to neither.
      await client.query(
        `UPDATE complaint_outbox SET to_party = true
          WHERE complaint_id = $1 AND party_id IS NULL AND then_supplier IS NULL AND status <> 'sent'`,
        [c.id],
      );
      await client.query('UPDATE complaint_outbox SET party_id = NULL, to_party = false WHERE party_id = $1', [next.id]);
      await client.query('DELETE FROM complaint_parties WHERE id = $1', [next.id]);
      const set = TRACK_MOVE.map((k, i) => `${k} = $${i + 2}`).join(', ');
      await client.query(`UPDATE complaints SET ${set} WHERE id = $1`, [c.id, ...TRACK_MOVE.map((k) => next[k] ?? null)]);
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [c.id, todayISO(),
          `${c.org_name} taken off this complaint${c.reference ? ` (their reference was ${c.reference})` : ''}; it had been made to them on ` +
          `${ukDate(dayOf(c.raised_on))}, at ${String(c.stage).replace('_', ' ')}. ${next.org_name} is now the main organisation, with its own ` +
          'dates. Earlier entries and emails with them stay here as history, and any later email from them is kept as history only.',
          who(req)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    await recomputeDeadlines(req.params.id);
    await settleOverall(req.params.id);
    scheduleReview(req.params.id);
    res.json(await decoratedById(req.params.id));
  }),
);

// Re-check one complaint now (always read, even with nothing new), and undo
// what the last re-check changed.
router.post(
  '/:id/recheck',
  asyncHandler(async (req, res) => {
    if (!config.anthropic.enabled) throw new HttpError(503, 'The AI isn’t configured, so the emails can’t be read.');
    await decoratedById(req.params.id); // 404 now if it doesn't exist
    // In the background, with its progress on the complaint for the page to
    // follow (recheck_progress); a failure is written on the timeline too.
    try {
      await startComplaintRecheck(req.params.id, who(req));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    res.status(202).json({ started: true });
  }),
);
router.post(
  '/:id/recheck/undo',
  asyncHandler(async (req, res) => {
    try {
      await undoRecheck(req.params.id, who(req));
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    res.json(await decoratedById(req.params.id));
  }),
);

// "Looks resolved" answered no: the prompt goes, and why goes on the timeline.
const notResolvedInput = z.object({ note: z.string().trim().max(1000).optional().nullable() });
router.post(
  '/:id/resolution-suggestion/dismiss',
  asyncHandler(async (req, res) => {
    const d = parse(notResolvedInput, req.body || {});
    const { rows } = await query(
      `UPDATE complaints SET resolution_suggested = NULL WHERE id = $1 AND resolution_suggested IS NOT NULL
        RETURNING id`,
      [req.params.id],
    );
    if (rows[0]) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [req.params.id, todayISO(), `Not resolved yet${d.note ? `: ${d.note}` : '.'}`, who(req)],
      );
      scheduleReview(req.params.id);
    }
    res.json(await decoratedById(req.params.id));
  }),
);

// --- Every email quoting its numbers ---------------------------------------
// Search the mailboxes now for this complaint's account numbers and every
// reference on it (theirs, each further organisation's, ours). `all` searches
// the ones already searched again. No AI is used: emails found are kept in
// full and the one review afterwards reads them.
router.post(
  '/:id/search-emails',
  asyncHandler(async (req, res) => {
    const all = Boolean(req.body?.all);
    const c = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    if (!c) throw new HttpError(404, 'Complaint not found');
    // Refused now if it can't start (no mailbox connection, one already
    // running); otherwise it runs in the background — searching several
    // mailboxes can take longer than the browser waits — and the page shows
    // it finishing on the timeline.
    let started;
    try {
      started = searchNow(req.params.id, { all, by: who(req) });
    } catch (err) {
      throw new HttpError(err.status || 500, err.message);
    }
    started.catch((err) => console.error(`[complaints] search for ${c.ref_code} failed:`, err.message));
    res.status(202).json({ started: true, email_search: { ...(await searchStatus(c)), running: true } });
  }),
);

// Delete a complaint and everything on it. Its emails go with it (they used
// to be left behind in "Emails to file") and are remembered — each email, and
// the threads it was on — so the watcher doesn't bring them, or a later reply
// in the same thread, back in (migration 034). Its documents' files are
// removed from disk too. One transaction; the files after it commits.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const client = await pool.connect();
    let files = [];
    try {
      await client.query('BEGIN');
      const c = (await client.query('SELECT id, ref_code FROM complaints WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!c) throw new HttpError(404, 'Complaint not found');
      await client.query(
        `INSERT INTO complaint_email_discards (message_id, mailbox)
         SELECT DISTINCT ON (message_id) message_id, source_mailbox FROM complaint_emails
          WHERE complaint_id = $1 AND message_id IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [c.id],
      );
      await client.query(
        `INSERT INTO complaint_ignored_threads (conversation_id, reason)
         SELECT DISTINCT conversation_id, $2 FROM complaint_emails
          WHERE complaint_id = $1 AND conversation_id IS NOT NULL
         ON CONFLICT DO NOTHING`,
        [c.id, `on ${c.ref_code}, which was deleted`],
      );
      await client.query('DELETE FROM complaint_emails WHERE complaint_id = $1', [c.id]);
      files = (await client.query('SELECT storage_path FROM complaint_attachments WHERE complaint_id = $1', [c.id]))
        .rows.map((r) => r.storage_path);
      await client.query('DELETE FROM complaints WHERE id = $1', [c.id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    const { promises: fsp } = await import('node:fs');
    for (const f of files) await fsp.unlink(f).catch(() => {});
    res.status(204).end();
  }),
);

export default router;
