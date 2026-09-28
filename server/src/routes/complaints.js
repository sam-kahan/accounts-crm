import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam } from '../lib/http.js';
import { config, complaintInboxAddress } from '../config.js';
import { todayISO, londonDateOf } from '../lib/dates.js';
import { buildUpdateSet } from '../lib/sql.js';
import { requireAuth, requirePermission, sessionOrCronKey } from '../middleware/auth.js';
import { describeChanges, theOmbudsman } from '../services/complaintRules.js';
import { decorate, decorateMany, gatherContext } from '../services/complaintContext.js';
import { createComplaint } from '../services/complaintCreate.js';
import { processEmail, undoEmail } from '../services/complaintEmailProcessor.js';
import { watchMailboxes } from '../services/mailWatch.js';
import { getSetting, setSetting, watchedMailboxes } from '../services/settings.js';
import { startScan, scanStatus, importInBackground, linkInBackground, setAutoImport, runAutoImport, skipCandidate } from '../services/pastComplaints.js';
import { findExistingComplaint, groupCandidates, mergeExtracted } from '../services/orgMatch.js';
import { tidySuggestions, mergeComplaints, mergeOrganisations } from '../services/tidy.js';
import { refreshReview, scheduleReview } from '../services/complaintReview.js';
import { ruleForComplaint, recomputeDeadlines } from '../services/complaintDeadlines.js';
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
import { sendMail, fromAddress } from '../services/mailer.js';
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


const ORG_TYPES = [
  'council', 'housing_association', 'water', 'energy', 'managing_agent', 'supplier', 'other',
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
    const result = {
      at: started, ok: errors.length === 0, errors: errors.slice(0, 5),
      fetched: r.fetched + w.fetched, stored: r.ids.length + w.ids.length, processed, filed,
      configured: emailConfigured(), watching: w.mailboxes,
    };
    await setSetting('email_last_check', result).catch(() => {});
    // Anything found in the past that automatic import hasn't dealt with yet
    // (one query when there is nothing waiting). In the background: the check
    // itself is answered now.
    runAutoImport().catch((err) => console.error('[complaints] automatic import:', err.message));
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
    const result = await assistComplaint({ ...ctx, instruction: d.instruction });
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

    const to = parseRecipients(d.to);
    const cc = parseRecipients(d.cc);
    if (!to.length) throw new HttpError(400, 'At least one valid recipient is required');
    // Always CC the complaint's own address so the thread self-logs.
    if (complaint.email_address && !cc.includes(complaint.email_address)) {
      cc.push(complaint.email_address);
    }

    await sendMail({ to, cc, subject: d.subject, text: d.body });
    await recordOutboundEmail({
      complaintId: complaint.id,
      fromEmail: fromAddress(),
      to,
      cc,
      subject: d.subject,
      body: d.body,
      sentBy: who(req),
    });
    const updated = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
    scheduleReview(complaint.id);
    res.json({ sent: true, complaint: await decorate(updated) });
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
    lines.push('');
    lines.push('GROUNDS FOR REFERRAL');
    lines.push('-'.repeat(48));
    lines.push(grounds);
    lines.push('');
    lines.push('CASE TIMELINE');
    lines.push('-'.repeat(48));
    for (const e of [...ctx.events].reverse()) {
      lines.push(`${e.event_date}  [${e.type}]  ${e.note || ''}`.trim());
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
    const overdue = decorated.filter((c) => c.needs_chasing).slice(0, 12);

    const drafts = [];
    for (const c of overdue) {
      try {
        const ctx = await gatherContext(c.id);
        const r = await assistComplaint({
          ...ctx,
          instruction:
            c.status === 'ack_overdue'
              ? 'Draft a polite but firm chaser: the complaint has not been acknowledged within ' +
                'the time their own procedure sets. Ask them to acknowledge it, name who is ' +
                'handling it, and confirm when the outcome will be sent.'
              : 'Draft a firm chaser email pressing for the overdue response and noting that the ' +
                'missed deadline is itself a complaint-handling failure.',
        });
        drafts.push({
          id: c.id, ref_code: c.ref_code, org_name: c.org_name, subject: c.subject,
          org_email: c.org_email, email_address: c.email_address, draft: r,
        });
      } catch (err) {
        drafts.push({ id: c.id, ref_code: c.ref_code, org_name: c.org_name, subject: c.subject, error: err.message });
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

    const overdue = decorated.filter((c) => c.needs_chasing);
    const awaiting = decorated.filter((c) => !c.needs_chasing);

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
    const { rows } = await query(
      `SELECT * FROM complaints ${where} ORDER BY (state <> 'open'), raised_on DESC`,
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
    });
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
      `SELECT id, mailbox, subject, first_at, last_at, message_count, extracted, status, error
         FROM complaint_import_candidates WHERE status IN ('pending', 'importing') ORDER BY first_at DESC`,
    );
    // Say when one is already in the system, so it is linked, not duplicated.
    const complaints = (await query(
      'SELECT id, ref_code, subject, org_name, organisation_id, property, raised_on FROM complaints',
    )).rows;
    const orgs = (await query('SELECT id, name FROM organisations')).rows;
    // Threads about the same issue are shown (and imported) as one complaint.
    // Rows being brought in are shown as their own group ("Importing…"), so
    // they are neither offered again nor grouped with pending ones.
    const busyGroups = groupCandidates(rows.filter((r) => r.status === 'importing'));
    const pendingRows = rows.filter((r) => r.status === 'pending');
    res.json([...busyGroups, ...groupCandidates(pendingRows)].map((group) => {
      const merged = mergeExtracted(group);
      const hit = group.map((c) => findExistingComplaint(complaints, orgs, c.extracted)).find(Boolean)
        || findExistingComplaint(complaints, orgs, merged);
      return {
        ...group[0],
        extracted: merged,
        message_count: group.reduce((n, c) => n + (c.message_count || 0), 0),
        status: group[0].status,
        error: group.map((c) => c.error).find(Boolean) || null,
        members: group.map((c) => ({ id: c.id, subject: c.subject, first_at: c.first_at, message_count: c.message_count })),
        existing: hit ? { id: hit.id, ref_code: hit.ref_code, subject: hit.subject } : null,
      };
    }));
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
    const events = (
      await query(
        'SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_date DESC, created_at DESC',
        [req.params.id],
      )
    ).rows;
    const emails = await listComplaintEmails(req.params.id);
    const attachments = await listAttachments(req.params.id);
    res.json({ ...decorated, events, emails, attachments });
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
    const complaint = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]))
      .rows[0];
    const on = d.date || em.analysis?.sent_on || londonDateOf(new Date(em.received_at));
    if (on > todayISO()) throw new HttpError(400, 'That date is in the future');
    const subject = em.subject || '(no subject)';

    // Once only: a double-click, or two people at once, can't record it twice.
    const marked = await query(
      `UPDATE complaint_emails SET reviewed_at = now(), reviewed_as = $2, reviewed_by = $3
        WHERE id = $1 AND reviewed_at IS NULL`,
      [em.id, d.as, who(req)],
    );
    if (!marked.rowCount) throw new HttpError(409, 'This email has already been dealt with.');
    // Replacing a date already recorded is allowed, but never silently.
    const replacing =
      d.as === 'acknowledgement' && complaint.acknowledged_on && complaint.acknowledged_on !== on
        ? `acknowledged: ${complaint.acknowledged_on} → ${on}`
        : d.as === 'response' && complaint.responded_on && complaint.responded_on !== on
          ? `responded: ${complaint.responded_on} → ${on}`
          : null;
    if (replacing) {
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1,$2,'note',$3,$4)`,
        [complaint.id, todayISO(), `Details corrected: ${replacing} (from the email "${subject}")`, who(req)],
      );
    }
    if (d.as === 'acknowledgement') {
      await query('UPDATE complaints SET acknowledged_on = $2 WHERE id = $1', [complaint.id, on]);
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1,$2,'acknowledged',$3,$4)`,
        [complaint.id, on, `Acknowledged by email: ${subject}`, who(req)],
      );
    } else if (d.as === 'response') {
      await query(
        `UPDATE complaints SET responded_on = $2,
                final_response_on = CASE WHEN stage = 'stage_2' THEN $2::date ELSE final_response_on END
          WHERE id = $1`,
        [complaint.id, on],
      );
      await query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
         VALUES ($1,$2,'response_received',$3,$4)`,
        [
          complaint.id, on,
          `${complaint.stage === 'stage_2' ? 'Final (Stage 2)' : 'Stage 1'} response by email: ${subject}`,
          who(req),
        ],
      );
    }
    const updated = await recomputeDeadlines(complaint.id);
    scheduleReview(complaint.id);
    res.json(await decorate(updated));
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
    res.json(await decorate(c));
  }),
);

// Refresh the AI review now, rather than waiting for the next change.
router.post(
  '/:id/review',
  asyncHandler(async (req, res) => {
    if (!config.anthropic.enabled) throw new HttpError(503, 'The AI assistant is not configured.');
    await refreshReview(req.params.id);
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
});

router.post(
  '/:id/events',
  asyncHandler(async (req, res) => {
    const d = parse(eventInput, req.body);
    const existing = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    const complaint = existing.rows[0];
    if (!complaint) throw new HttpError(404, 'Complaint not found');

    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [req.params.id, d.event_date, d.type, d.note || null, who(req)],
    );

    // Side effects: certain event types update the complaint's own fields.
    if (d.type === 'acknowledged') {
      await query('UPDATE complaints SET acknowledged_on = $2 WHERE id = $1', [
        req.params.id, d.event_date,
      ]);
    } else if (d.type === 'response_received') {
      // A Stage 2 response is their final one — the date many schemes count
      // the referral window from.
      await query(
        `UPDATE complaints SET responded_on = $2,
                final_response_on = CASE WHEN stage = 'stage_2' THEN $2::date ELSE final_response_on END
          WHERE id = $1`,
        [req.params.id, d.event_date],
      );
    } else if (d.type === 'resolved') {
      await query(
        `UPDATE complaints SET state = 'resolved', stage = 'resolved', closed_on = $2 WHERE id = $1`,
        [req.params.id, d.event_date],
      );
    }

    // An acknowledgement can move the Stage 1 date (where their clock runs
    // from it) and a final response starts the referral window.
    const updated = await recomputeDeadlines(req.params.id);
    scheduleReview(req.params.id);
    res.status(201).json(await decorate(updated));
  }),
);

// Escalate to the next stage. The new stage's clock starts on the date given
// (the day the Stage 2 request went in), and its deadline is worked out again.
const escalateInput = z.object({ date: isoDate.optional().nullable() });

router.post(
  '/:id/escalate',
  asyncHandler(async (req, res) => {
    const d = parse(escalateInput, req.body || {});
    const existing = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    const complaint = existing.rows[0];
    if (!complaint) throw new HttpError(404, 'Complaint not found');

    const next =
      complaint.stage === 'stage_1' ? 'stage_2' :
      complaint.stage === 'stage_2' ? 'ombudsman' : null;
    if (!next) throw new HttpError(400, 'Complaint cannot be escalated further');

    const escalatedOn = d.date || todayISO();
    const { rule } = await ruleForComplaint(complaint);

    // Assignments read the row as it was, so a Stage 2 response recorded as
    // responded_on is kept as the final response before it is cleared.
    await query(
      `UPDATE complaints
          SET final_response_on = COALESCE(final_response_on,
                CASE WHEN stage = 'stage_2' THEN responded_on END),
              stage = $2, stage_started_on = $3, responded_on = NULL,
              response_due_manual = false
        WHERE id = $1`,
      [req.params.id, next, escalatedOn],
    );
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note, created_by)
       VALUES ($1,$2,'escalated',$3,$4)`,
      [
        req.params.id, escalatedOn,
        next === 'ombudsman'
          ? `Referred to ${theOmbudsman(rule.ombudsman)}`
          : 'Escalated to Stage 2',
        who(req),
      ],
    );

    const updated = await recomputeDeadlines(req.params.id);
    scheduleReview(req.params.id);
    res.json(await decorate(updated));
  }),
);

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

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM complaints WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Complaint not found');
    res.status(204).end();
  }),
);

export default router;
