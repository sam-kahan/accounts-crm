import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config, complaintEmailAddress } from '../config.js';
import { todayISO } from '../lib/dates.js';
import { buildUpdateSet } from '../lib/sql.js';
import { requireAuth, sessionOrCronKey } from '../middleware/auth.js';
import {
  effectiveRule,
  computeResponseDue,
  computeOmbudsmanDeadline,
  deriveStatus,
} from '../services/complaintRules.js';
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
} from '../services/attachments.js';

const router = Router();

// Unambiguous characters only (no 0/O/1/I).
function makeRefCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return `GC-C-${s}`;
}

const ORG_TYPES = ['council', 'housing_association', 'water', 'energy', 'supplier', 'other'];

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
  raised_on: z.string().min(1),
  response_due: z.string().optional().nullable(), // override
  // Set when importing an existing complaint at a known stage.
  stage: z.enum(['stage_1', 'stage_2', 'ombudsman']).optional(),
  acknowledged_on: z.string().optional().nullable(),
  responded_on: z.string().optional().nullable(),
  imported: z.boolean().optional(),
});

async function getRuleForComplaint(c) {
  let org = null;
  if (c.organisation_id) {
    const r = await query('SELECT * FROM organisations WHERE id = $1', [c.organisation_id]);
    org = r.rows[0] || null;
  }
  return effectiveRule(org, c.org_type);
}

// Attach derived status + rule + org contact context to a complaint row.
async function decorate(c) {
  let org = null;
  if (c.organisation_id) {
    const r = await query('SELECT * FROM organisations WHERE id = $1', [c.organisation_id]);
    org = r.rows[0] || null;
  }
  const rule = effectiveRule(org, c.org_type);
  const derived = deriveStatus(c, rule);
  return {
    ...c,
    ...derived,
    rule,
    email_address: complaintEmailAddress(c.ref_code),
    org_email: org?.complaints_email || null,
    org_complaints_url: org?.complaints_url || null,
  };
}

// --- Email fetch (cron-accessible: session OR cron key) --------------------
// Defined before the requireAuth guard below so the cron can call it with a key.
router.post(
  '/email/fetch',
  sessionOrCronKey,
  asyncHandler(async (_req, res) => {
    const emails = await fetchMailboxMessages();
    const r = await ingestEmails(emails);
    res.json({ ...r, configured: emailConfigured() });
  }),
);

// Everything below this line requires a logged-in session.
router.use(requireAuth);

// Is the mailbox integration configured? (for the UI)
router.get(
  '/email/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: emailConfigured(), mailbox: config.ms.mailbox || null });
  }),
);

// Is the AI assistant configured? (for the UI)
router.get(
  '/ai/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: config.anthropic.enabled });
  }),
);

// Gather a complaint's full context (row + rule + timeline + emails + attachment
// text) for the AI endpoints. Throws 404 if the complaint doesn't exist.
async function gatherContext(id, extraContext) {
  const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Complaint not found');
  const complaint = await decorate(rows[0]);
  const events = (
    await query(
      'SELECT * FROM complaint_events WHERE complaint_id = $1 ORDER BY event_date DESC, created_at DESC',
      [id],
    )
  ).rows;
  const emails = await listComplaintEmails(id);
  const docs = await attachmentTexts(id);
  const docText = docs.length
    ? docs.map((a) => `--- Attached document: ${a.filename} ---\n${a.extracted_text}`).join('\n\n')
    : '';
  const merged = [extraContext, docText].filter(Boolean).join('\n\n');
  return { complaint, rule: complaint.rule, events, emails, extraContext: merged };
}

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
    });
    const updated = (await query('SELECT * FROM complaints WHERE id = $1', [req.params.id])).rows[0];
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
    lines.push(`OMBUDSMAN / ADR REFERRAL — ${c.ref_code}`);
    lines.push('='.repeat(48));
    lines.push(`Organisation: ${c.org_name} (${c.rule.label})`);
    lines.push(`Refer to: ${c.rule.ombudsman}${c.rule.ombudsmanUrl ? ` — ${c.rule.ombudsmanUrl}` : ''}`);
    if (c.property) lines.push(`Property / account: ${c.property}`);
    if (c.reference) lines.push(`Their reference: ${c.reference}`);
    lines.push(`Subject: ${c.subject}`);
    lines.push(`Raised: ${c.raised_on}   Stage: ${c.stage}   Status: ${c.label}`);
    if (c.acknowledged_on) lines.push(`Acknowledged: ${c.acknowledged_on}`);
    if (c.responded_on) lines.push(`Their response: ${c.responded_on}`);
    lines.push(`Refer by: ${c.ombudsman_deadline || 'n/a'}`);
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
          `${(em.received_at || '').slice(0, 10)}  ${em.direction === 'outbound' ? 'SENT' : 'RECEIVED'}  ` +
            `${em.subject || '(no subject)'} — ${em.sender_name || em.sender_email || ''}`,
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
  text: z.string().min(20),
  hint: z.string().max(500).optional().nullable(),
});

router.post(
  '/import/parse',
  asyncHandler(async (req, res) => {
    const d = parse(importInput, req.body);
    const parsed = await parseImportedComplaint({ text: d.text, hint: d.hint });
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
    const decorated = await Promise.all(open.map(decorate));
    const overdue = decorated.filter((c) => c.status === 'response_overdue').slice(0, 12);

    const drafts = [];
    for (const c of overdue) {
      try {
        const ctx = await gatherContext(c.id);
        const r = await assistComplaint({
          ...ctx,
          instruction:
            'Draft a firm chaser email pressing for the overdue response and noting that the ' +
            'missed statutory deadline is itself a complaint-handling failure.',
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
    res.status(201).json(saved);
  }),
);

router.get(
  '/attachments/:attId/download',
  asyncHandler(async (req, res) => {
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
    const decorated = await Promise.all(open.map(decorate));

    const overdue = decorated.filter((c) => c.status === 'response_overdue');
    const awaiting = decorated.filter((c) => c.status !== 'response_overdue');

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
    res.json(await Promise.all(rows.map(decorate)));
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
    const rule = effectiveRule(
      d.organisation_id
        ? (await query('SELECT * FROM organisations WHERE id = $1', [d.organisation_id])).rows[0]
        : null,
      d.org_type,
    );
    const stage = d.stage || 'stage_1';
    const base = { ...d, stage };
    // Response-due date. Computing it from raised_on only makes sense for a
    // Stage 1 clock; for an imported complaint already at Stage 2/ombudsman the
    // original stage clock can't be reconstructed from raised_on, so leave it
    // null (unless the user supplied an override) rather than showing it as
    // spuriously overdue the moment it's imported.
    let responseDue = d.response_due || null;
    if (!responseDue && !(d.imported && stage !== 'stage_1')) {
      responseDue = computeResponseDue(base, rule);
    }
    const ombudsmanDeadline = computeOmbudsmanDeadline(base, rule);

    // Retry on the (astronomically unlikely) ref_code collision rather than
    // surfacing a 500 from the unique index.
    let created = null;
    for (let attempt = 0; attempt < 5 && !created; attempt += 1) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          `INSERT INTO complaints
            (organisation_id, org_name, org_type, reference, our_reference, property,
             subject, category, description, channel, raised_on, stage, state,
             response_due, ombudsman_deadline, ref_code, acknowledged_on, responded_on, imported)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'open',$13,$14,$15,$16,$17,$18)
           RETURNING *`,
          [
            d.organisation_id || null, d.org_name, d.org_type || 'council',
            d.reference || null, d.our_reference || null, d.property || null,
            d.subject, d.category || null, d.description || null, d.channel || 'email',
            d.raised_on, stage, responseDue, ombudsmanDeadline, makeRefCode(),
            d.acknowledged_on || null, d.responded_on || null, d.imported || false,
          ],
        );
        await client.query(
          `INSERT INTO complaint_events (complaint_id, event_date, type, note)
           VALUES ($1, $2, 'raised', $3)`,
          [
            rows[0].id, d.raised_on,
            d.imported
              ? `Existing complaint imported (raised via ${d.channel || 'email'})`
              : `Complaint raised via ${d.channel || 'email'}`,
          ],
        );
        await client.query('COMMIT');
        created = rows[0];
      } catch (err) {
        await client.query('ROLLBACK');
        // Unique violation on the ref_code index — try a fresh code.
        if (err.code === '23505' && /ref_code/.test(`${err.constraint || ''}${err.detail || ''}`)) {
          continue;
        }
        throw err;
      } finally {
        client.release();
      }
    }
    if (!created) throw new HttpError(500, 'Could not allocate a complaint reference; please retry.');
    res.status(201).json(await decorate(created));
  }),
);

// Add a timeline event (chase, acknowledged, response received, note, …).
const eventInput = z.object({
  event_date: z.string().min(1),
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
      `INSERT INTO complaint_events (complaint_id, event_date, type, note)
       VALUES ($1,$2,$3,$4)`,
      [req.params.id, d.event_date, d.type, d.note || null],
    );

    // Side effects: certain event types update the complaint's own fields.
    if (d.type === 'acknowledged') {
      await query('UPDATE complaints SET acknowledged_on = $2 WHERE id = $1', [
        req.params.id, d.event_date,
      ]);
    } else if (d.type === 'response_received') {
      await query('UPDATE complaints SET responded_on = $2 WHERE id = $1', [
        req.params.id, d.event_date,
      ]);
    } else if (d.type === 'resolved') {
      await query(
        `UPDATE complaints SET state = 'resolved', stage = 'resolved', closed_on = $2 WHERE id = $1`,
        [req.params.id, d.event_date],
      );
    }

    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    res.status(201).json(await decorate(rows[0]));
  }),
);

// Escalate to the next stage; recomputes the response deadline for that stage.
router.post(
  '/:id/escalate',
  asyncHandler(async (req, res) => {
    const existing = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    const complaint = existing.rows[0];
    if (!complaint) throw new HttpError(404, 'Complaint not found');

    const next =
      complaint.stage === 'stage_1' ? 'stage_2' :
      complaint.stage === 'stage_2' ? 'ombudsman' : null;
    if (!next) throw new HttpError(400, 'Complaint cannot be escalated further');

    const escalatedOn = req.body?.date || todayISO();
    const rule = await getRuleForComplaint(complaint);

    let responseDue = complaint.response_due;
    if (next === 'stage_2') {
      // New Stage 2 clock from the escalation date.
      responseDue = computeResponseDue(
        { raised_on: escalatedOn, stage: 'stage_2' }, rule,
      );
    }

    await query(
      `UPDATE complaints SET stage = $2, responded_on = NULL, response_due = $3 WHERE id = $1`,
      [req.params.id, next, next === 'ombudsman' ? null : responseDue],
    );
    await query(
      `INSERT INTO complaint_events (complaint_id, event_date, type, note)
       VALUES ($1,$2,'escalated',$3)`,
      [
        req.params.id, escalatedOn,
        next === 'ombudsman'
          ? `Referred to the ${rule.ombudsman}`
          : 'Escalated to Stage 2',
      ],
    );

    const { rows } = await query('SELECT * FROM complaints WHERE id = $1', [req.params.id]);
    res.json(await decorate(rows[0]));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input.partial(), req.body);
    // Update only the sent fields; an explicit null clears a nullable column
    // (reference, our_reference, property, category, description, response_due)
    // instead of being ignored. org_name/subject are NOT NULL in the schema.
    const { clause, values } = buildUpdateSet({
      org_name: d.org_name,
      reference: d.reference,
      our_reference: d.our_reference,
      property: d.property,
      subject: d.subject,
      category: d.category,
      description: d.description,
      response_due: d.response_due,
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    const { rows } = await query(
      `UPDATE complaints SET ${clause} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values],
    );
    if (!rows[0]) throw new HttpError(404, 'Complaint not found');
    res.json(await decorate(rows[0]));
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
