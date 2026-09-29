import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam } from '../lib/http.js';
import { config, complaintInboxAddress } from '../config.js';
import { todayISO, londonDateOf } from '../lib/dates.js';
import { buildUpdateSet } from '../lib/sql.js';
import { requireAuth, requirePermission, sessionOrCronKey } from '../middleware/auth.js';
import { describeChanges, theOmbudsman, trackOpen, isStage2Request } from '../services/complaintRules.js';
import { overallState, tracksOf } from '../services/complaintParties.js';
import { openBounces } from '../services/bounces.js';
import { recheckComplaint, undoRecheck, startRecheck, recheckStatus } from '../services/complaintRecheck.js';
import { decorate, decorateMany, gatherContext, listEvents } from '../services/complaintContext.js';
import { createComplaint } from '../services/complaintCreate.js';
import { processEmail, undoEmail, fileWaitingEmails } from '../services/complaintEmailProcessor.js';
import { watchMailboxes } from '../services/mailWatch.js';
import { getSetting, setSetting, watchedMailboxes } from '../services/settings.js';
import { backfillAccountNumbers, searchAccountEmails, searchStatus, searchNow, dropDigitSlips } from '../services/accountNumbers.js';
import { startScan, scanStatus, importInBackground, linkInBackground, setAutoImport, runAutoImport, skipCandidate, onFileFor, autoPlan, importsPaused } from '../services/pastComplaints.js';
import { findExistingComplaint, groupCandidates, mergeExtracted, sameIssue, PARTY_COLS } from '../services/orgMatch.js';
import { tidySuggestions, mergeComplaints, mergeOrganisations } from '../services/tidy.js';
import { refreshReview, scheduleReview, cancelScheduledReview } from '../services/complaintReview.js';
import { ruleForComplaint, recomputeDeadlines, recomputePartyDeadlines } from '../services/complaintDeadlines.js';
import { fetchMailboxMessages, emailConfigured } from '../services/graphMail.js';
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
import {
  listAttachments,
  attachmentTexts,
  saveAttachment,
  getAttachment,
  deleteAttachment,
  attachmentUpload,
  attachmentBlocks,
  procedureMemoryUpload,
} from '../services/attachments.js';
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

async function decoratedById(id) {
  const c = (await query('SELECT * FROM complaints WHERE id = $1', [id])).rows[0];
  if (!c) throw new HttpError(404, 'Complaint not found');
  return decorate(c);
}


const ORG_TYPES = [
  'council', 'housing_association', 'water', 'energy', 'managing_agent', 'debt_collector', 'supplier', 'other',
];

// A calendar date as the app stores it. Checked here so a malformed value is a
// clean 400 rather than a Postgres error.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date');

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
  response_due: isoDate.optional().nullable(), // override
  // Set when importing an existing complaint at a known stage.
  stage: z.enum(['stage_1', 'stage_2', 'ombudsman']).optional(),
  // When the current stage's clock started (the Stage 2 request date).
  stage_started_on: isoDate.optional().nullable(),
  acknowledged_on: isoDate.optional().nullable(),
  responded_on: isoDate.optional().nullable(),
  final_response_on: isoDate.optional().nullable(),
  imported: z.boolean().optional(),
});

// --- Email fetch (cron-accessible: session OR cron key) --------------------
// Defined before the requireAuth guard below so the cron can call it with a key.
router.post(
  '/email/fetch',
  sessionOrCronKey,
  asyncHandler(async (_req, res) => {
    const started = new Date().toISOString();
    const errors = [];
    // 1. The catch-all: complaint addresses and the general inbox.
    let r = { fetched: 0, inserted: 0, matched: 0, ids: [] };
    try {
      r = await ingestEmails(await fetchMailboxMessages(), { mailbox: config.ms.mailbox || null });
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
    res.json({ ...result, inserted: r.inserted, matched: r.matched });
  }),
);

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
const sendInput = z.object({
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

router.post(
  '/:id/send-email',
  asyncHandler(async (req, res) => {
    const d = parse(sendInput, req.body);
    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Complaint not found');
    const complaint = await decorate(rows[0]);
    // Checked before anything is sent, so an email never goes out for a step
    // that then can't be recorded.
    const party = d.party_id ? (complaint.parties || []).find((p) => p.id === d.party_id) : null;
    if (d.party_id && !party) throw new HttpError(400, 'That organisation isn’t on this complaint.');
    if (d.then === 'escalate' && (party || complaint).stage !== 'stage_1') {
      throw new HttpError(400, `Only ${party ? `${party.org_name}'s part` : 'a complaint'} at Stage 1 can be escalated to Stage 2 this way.`);
    }

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

    const sent = await sendMail({ to, cc, subject: d.subject, text: d.body });
    await recordOutboundEmail({
      complaintId: complaint.id,
      fromEmail: fromAddress(),
      to,
      cc,
      subject: d.subject,
      body: d.body,
      sentBy: who(req),
      messageId: sent?.messageId || null,
      partyId: party?.id || null,
    });
    // The Stage 2 request moves the complaint on whichever button sent it:
    // "Send it and escalate" says so, and otherwise the email's own words do
    // (isStage2Request, no AI), so a plain Send can't leave it at Stage 1
    // with the review offering the same request again.
    const track = d.then === 'escalate'
      ? { party }
      : isStage2Request({ subject: d.subject, body: d.body })
        ? (d.party_id ? (party.stage === 'stage_1' ? { party } : null) : await stage2TrackFor(complaint.id, to))
        : null;
    if (track) await escalateTrack(complaint.id, track.party?.id || null, todayISO(), who(req));
    const updated = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    scheduleReview(complaint.id);
    res.json({
      sent: true, escalated: Boolean(track), escalated_org: track?.party?.org_name || null,
      complaint: await decorate(updated),
    });
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

// Build an ombudsman/ADR referral pack (facts + timeline + AI-drafted grounds).
router.get(
  '/:id/referral-pack',
  asyncHandler(async (req, res) => {
    const ctx = await gatherContext(req.params.id);
    const c = ctx.complaint;
    const grounds = await draftReferralGrounds(ctx);
    const lines = [];
    lines.push(`OMBUDSMAN / ADR REFERRAL: ${c.ref_code}`);
    lines.push('='.repeat(48));
    lines.push(`Organisation: ${c.org_name} (${c.rule.label})`);
    lines.push(`Refer to: ${c.rule.ombudsman}${c.rule.ombudsmanUrl ? ` (${c.rule.ombudsmanUrl})` : ''}`);
    if (c.property) lines.push(`Property / account: ${c.property}`);
    if (c.reference) lines.push(`Their reference: ${c.reference}`);
    lines.push(`Subject: ${c.subject}`);
    lines.push(`Raised: ${c.raised_on}   Stage: ${c.stage}   Status: ${c.label}`);
    if (c.acknowledged_on) lines.push(`Acknowledged: ${c.acknowledged_on}`);
    if (c.responded_on) lines.push(`Their response: ${c.responded_on}`);
    if (c.ombudsman_from) lines.push(`Can refer from: ${c.ombudsman_from}`);
    lines.push(`Refer by: ${c.ombudsman_deadline || 'n/a'}`);
    if (c.rule.procedureRef) lines.push(`Their procedure: ${c.rule.procedureRef}`);
    for (const p of c.parties || []) {
      lines.push('');
      lines.push(`Also complained to: ${p.org_name} (${p.rule.label})${p.relationship ? `, ${p.relationship}` : ''}`);
      if (p.reference) lines.push(`  Their reference: ${p.reference}`);
      lines.push(`  Raised: ${p.raised_on}   Stage: ${p.stage}   Status: ${p.label}`);
      if (p.acknowledged_on) lines.push(`  Acknowledged: ${p.acknowledged_on}`);
      if (p.responded_on) lines.push(`  Their response: ${p.responded_on}`);
      if (p.final_response_on) lines.push(`  Their final response: ${p.final_response_on}`);
      lines.push(`  Refer to: ${p.rule.ombudsman}; refer by: ${p.ombudsman_deadline || 'n/a'}`);
    }
    lines.push('');
    lines.push('GROUNDS FOR REFERRAL');
    lines.push('-'.repeat(48));
    lines.push(grounds);
    lines.push('');
    lines.push('CASE TIMELINE');
    lines.push('-'.repeat(48));
    for (const e of [...ctx.events].reverse()) {
      lines.push(`${e.event_date}  [${e.type}]${e.party_name ? ` (${e.party_name})` : ''}  ${e.note || ''}`.trim());
    }
    lines.push('');
    lines.push('CORRESPONDENCE LOG');
    lines.push('-'.repeat(48));
    if (ctx.emails.length) {
      for (const em of [...ctx.emails].reverse()) {
        lines.push(
          `${em.received_at ? londonDateOf(new Date(em.received_at)) : ''}  ${em.direction === 'outbound' ? 'SENT' : 'RECEIVED'}  ` +
            `${em.subject || '(no subject)'}, ${em.sender_name || em.sender_email || ''}`,
        );
      }
    } else {
      lines.push('(no emails logged)');
    }
    res.json({ ref_code: c.ref_code, ombudsman: c.rule.ombudsman, grounds, text: lines.join('\n') });
  }),
);

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
    const parsed = await parseImportedComplaint({ text, hint: d.hint, blocks });
    res.json(parsed);
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
      ...(c.needs_chasing ? [{ c, t: c }] : []),
      ...(c.parties || []).filter((p) => p.needs_chasing).map((p) => ({ c, t: p })),
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
    // Force a download (never render inline): a user could upload an HTML/SVG
    // file whose stored mimetype would otherwise execute as script on our own
    // origin. `nosniff` stops the browser second-guessing the content type.
    res.setHeader('Content-Type', a.mimetype || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${a.filename.replace(/"/g, '')}"`);
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
    const overdue = decorated.filter((c) => c.any_needs_chasing);
    const awaiting = decorated.filter((c) => !c.any_needs_chasing);

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
    res.json({ run: await recheckStatus(), open: open.n, never_rechecked: open.never, ai: config.anthropic.enabled, mailbox: emailConfigured() });
  }),
);
router.post(
  '/recheck',
  asyncHandler(async (req, res) => {
    try {
      res.status(202).json(await startRecheck({ by: who(req), force: Boolean(req.body?.force) }));
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
router.put(
  '/automation',
  asyncHandler(async (req, res) => {
    const d = parse(watchInput, req.body);
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
    const orgs = (await query('SELECT id, name FROM organisations')).rows;
    // Threads about the same issue are shown (and imported) as one complaint.
    // Rows being brought in are shown as their own group ("Importing…"), so
    // they are neither offered again nor grouped with pending ones.
    const busyGroups = groupCandidates(rows.filter((r) => r.status === 'importing'));
    const pendingRows = rows.filter((r) => r.status === 'pending');
    const autoOn = Boolean(await getSetting('past_auto_import'));
    const paused = await importsPaused();
    const enabled = config.ms.enabled && config.anthropic.enabled;
    const busyRows = rows.filter((r) => r.status === 'importing');
    res.json(await Promise.all([...busyGroups, ...groupCandidates(pendingRows)].map(async (group) => {
      const merged = mergeExtracted(group);
      const { hit, certain } = await onFileFor(group, { complaints, orgs });
      // What automatic import will do with it: the same rule runAutoImport
      // acts on (autoPlan), so the promise on the page is what happens.
      const auto = autoOn && group[0].status === 'pending'
        ? autoPlan(group, {
          hit, certain, paused, enabled,
          relatedRunning: busyRows.some((b) => group.some((c) => sameIssue(c.extracted, b.extracted))),
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
    const decorated = await decorate(rows[0]);
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
    res.json({ ...decorated, events, emails, attachments, email_search, bounces, external_cc: config.smtp.externalCc });
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
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
    const track = await loadTrack(req.params.id, d.as === 'correspondence' ? null : d.party_id);
    const complaint = track.row; // the organisation's track the step is recorded on
    const partyId = track.party?.id || null;
    const on = d.date || em.analysis?.sent_on || londonDateOf(new Date(em.received_at));
    if (on > todayISO()) throw new HttpError(400, 'That date is in the future');
    const subject = em.subject || '(no subject)';

    // Once only: a double-click, or two people at once, can't record it twice.
    const marked = await query(
      `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3, party_id = $4
        WHERE id = $1 AND reviewed_at IS NULL`,
      [em.id, d.as, who(req), partyId],
    );
    if (!marked.rowCount) throw new HttpError(409, 'This email has already been dealt with.');
    // Replacing a date already recorded is allowed, but never silently.
    const replacing =
      d.as === 'acknowledgement' && complaint.acknowledged_on && complaint.acknowledged_on !== on
        ? `acknowledged: ${complaint.acknowledged_on} → ${on}`
        : d.as === 'response' && complaint.responded_on && complaint.responded_on !== on
          ? `responded: ${complaint.responded_on} → ${on}`
          : null;
    const cid = req.params.id;
    if (replacing) {
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
         VALUES ($1,$2,$3,'note',$4,$5)`,
        [cid, partyId, todayISO(), `Details corrected: ${replacing} (from the email "${subject}")`, who(req)],
      );
    }
    if (d.as === 'acknowledgement') {
      await query(`UPDATE ${track.table} SET acknowledged_on = $2 WHERE id = $1`, [complaint.id, on]);
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
         VALUES ($1,$2,$3,'acknowledged',$4,$5)`,
        [cid, partyId, on, `Acknowledged by email: ${subject}`, who(req)],
      );
    } else if (d.as === 'response') {
      await query(
        `UPDATE ${track.table} SET responded_on = $2,
                final_response_on = CASE WHEN stage = 'stage_2' THEN $2::date ELSE final_response_on END
          WHERE id = $1`,
        [complaint.id, on],
      );
      await query(
        `INSERT INTO complaint_events (complaint_id, party_id, event_date, type, note, created_by)
         VALUES ($1,$2,$3,'response_received',$4,$5)`,
        [
          cid, partyId, on,
          `${complaint.stage === 'stage_2' ? 'Final (Stage 2)' : 'Stage 1'} response by email: ${subject}`,
          who(req),
        ],
      );
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
});

router.post(
  '/:id/events',
  asyncHandler(async (req, res) => {
    const d = parse(eventInput, req.body);
    const track = await loadTrack(req.params.id, d.party_id);
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
                final_response_on = CASE WHEN stage = 'stage_2' THEN $2::date ELSE final_response_on END
          WHERE id = $1`,
        [track.row.id, d.event_date],
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
});

router.post(
  '/:id/escalate',
  asyncHandler(async (req, res) => {
    const d = parse(escalateInput, req.body || {});
    await escalateTrack(req.params.id, d.party_id, d.date, who(req));
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

async function escalateTrack(complaintId, partyId, date, by) {
    const track = await loadTrack(complaintId, partyId);
    const complaint = track.row;

    const next =
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
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    await query(`UPDATE complaints SET ${clause} WHERE id = $1`, [req.params.id, ...values]);
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
    const ctx = await gatherContext(req.params.id, undefined, { files: 2 });
    const c = ctx.complaint;
    const name = org?.name || d.org_name;
    const r = await assistComplaint({
      ...ctx,
      feature: 'Supplier complaint draft',
      instruction:
        `Draft a FORMAL COMPLAINT email from Greenco to ${name}, the company that owns this account, which ` +
        `${c.org_name} is pursuing on their behalf. It is a NEW complaint to ${name} (not a reply to ${c.org_name}). ` +
        'It must: say plainly that it is a formal complaint under their complaints procedure; quote the ' +
        `account number(s) and ${c.org_name}'s reference; set out, with dates from the emails and documents, ` +
        'what Greenco asked for, what was promised and what has still not been done (for example the full ' +
        'or final bill never issued, fees or charges added, the account passed to collection while it was ' +
        'disputed); and ask them, by a date 10 working days from today, to (1) put the account on hold and ' +
        `recall it from ${c.org_name} while the complaint is open, (2) issue the correct full bill, (3) remove ` +
        'any fees or charges added because of their error, and (4) acknowledge this complaint and give their ' +
        'complaint reference. Firm, polite, UK business English, no long dashes. Use only facts in the ' +
        'context; put [square brackets] only where a fact is genuinely unknown. In "email" give the subject ' +
        'and the full body, greeting to sign-off (sign off as Greenco Property Group, Accounts).',
    });
    res.json({
      to: org?.complaints_email || null,
      subject: r.email?.subject || '',
      body: r.email?.body || '',
      caution: r.caution || null,
    });
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
    const raisedOn = d.send ? todayISO() : d.sent_on;
    if (raisedOn > todayISO()) throw new HttpError(400, 'That date is in the future');
    let sentEmailId = null;
    if (d.send) {
      const to = parseRecipients(d.send.to);
      const cc = parseRecipients(d.send.cc);
      if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
      if (c.email_address && !cc.includes(c.email_address)) cc.push(c.email_address);
      for (const a of withExternalCc(to, cc)) if (!cc.includes(a)) cc.push(a);
      const sent = await sendMail({ to, cc, subject: d.send.subject, text: d.send.body });
      sentEmailId = await recordOutboundEmail({
        complaintId: c.id, fromEmail: fromAddress(), to, cc,
        subject: d.send.subject, body: d.send.body, sentBy: who(req), messageId: sent?.messageId || null,
      });
    }
    const party = await createParty(c.id, {
      organisation_id: d.organisation_id || null,
      org_name: d.org_name,
      org_type: d.org_type || 'supplier',
      relationship: `Owns the account ${c.org_name} is collecting`,
      raised_on: raisedOn,
      channel: 'email',
      raisedNote: `Complaint raised with ${d.org_name} too (the account ${c.org_name} is collecting is theirs)` +
        `${d.send ? ', sent from here' : ', sent from Outlook'}.`,
    }, who(req));
    // The email (and its "sent" entry) is theirs: sending it to the supplier
    // is not a step with the organisation already on the complaint.
    if (sentEmailId) {
      await query('UPDATE complaint_emails SET party_id = $2 WHERE id = $1', [sentEmailId, party.id]);
      const head = `Email sent: ${d.send.subject}, to `;
      await query(
        `UPDATE complaint_events SET party_id = $2
          WHERE complaint_id = $1 AND type = 'chased' AND party_id IS NULL AND event_date = $3
            AND left(note, length($4)) = $4`,
        [c.id, party.id, raisedOn, head],
      );
    }
    res.status(201).json(await decoratedById(c.id));
  }),
);

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

// Taking an organisation off a complaint (added by mistake). Its timeline
// entries and emails stay on the complaint, no longer tied to it, and the
// removal is written on the timeline.
router.delete(
  '/:id/parties/:partyId',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.partyId).success) throw new HttpError(400, 'Invalid id');
    const { party } = await loadTrack(req.params.id, req.params.partyId);
    await query('DELETE FROM complaint_parties WHERE id = $1', [party.id]);
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,'note',$3,$4)`,
      [
        req.params.id, todayISO(),
        `${party.org_name} taken off this complaint` +
          `${party.reference ? ` (their reference was ${party.reference})` : ''}.`,
        who(req),
      ],
    );
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
    // In the background: searching and reading a long history can take longer
    // than the browser waits. The page watches rechecked_at for it finishing;
    // a failure is written on the timeline so it is never silent.
    const by = who(req);
    recheckComplaint(req.params.id, { by, force: true, review: 'now' }).catch(async (err) => {
      console.error(`[complaints] re-check ${req.params.id} failed:`, err.message);
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by) VALUES ($1,$2,'note',$3,$4)`,
        [req.params.id, todayISO(), `Re-check against its emails failed: ${String(err.message).slice(0, 300)}. Nothing was changed.`, by],
      ).catch(() => {});
    });
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
