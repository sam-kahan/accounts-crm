import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config, complaintEmailAddress } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
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
  listUnmatchedEmails,
} from '../services/emailIngest.js';

const router = Router();

// Unambiguous characters only (no 0/O/1/I).
function makeRefCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i += 1) s += A[Math.floor(Math.random() * A.length)];
  return `GC-C-${s}`;
}

// Allow either a logged-in session or the cron key (for the email-fetch cron).
function sessionOrCronKey(req, res, next) {
  if (req.session?.userId) return next();
  const key = req.query.key || req.body?.key;
  if (config.reminderCronKey && key === config.reminderCronKey) return next();
  return next(new HttpError(401, 'Not authenticated'));
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
});

async function getRuleForComplaint(c) {
  let org = null;
  if (c.organisation_id) {
    const r = await query('SELECT * FROM organisations WHERE id = $1', [c.organisation_id]);
    org = r.rows[0] || null;
  }
  return effectiveRule(org, c.org_type);
}

// Attach derived status + rule context to a complaint row.
async function decorate(c) {
  const rule = await getRuleForComplaint(c);
  const derived = deriveStatus(c, rule);
  return { ...c, ...derived, rule, email_address: complaintEmailAddress(c.ref_code) };
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

// Emails that couldn't be matched to a complaint (for review).
router.get(
  '/email/unmatched',
  asyncHandler(async (_req, res) => {
    res.json(await listUnmatchedEmails());
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
    res.json({ ...decorated, events, emails });
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
    const base = { ...d, stage: 'stage_1' };
    const responseDue = d.response_due || computeResponseDue(base, rule);
    const ombudsmanDeadline = computeOmbudsmanDeadline(base, rule);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `INSERT INTO complaints
          (organisation_id, org_name, org_type, reference, our_reference, property,
           subject, category, description, channel, raised_on, stage, state,
           response_due, ombudsman_deadline, ref_code)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'stage_1','open',$12,$13,$14)
         RETURNING *`,
        [
          d.organisation_id || null, d.org_name, d.org_type || 'council',
          d.reference || null, d.our_reference || null, d.property || null,
          d.subject, d.category || null, d.description || null, d.channel || 'email',
          d.raised_on, responseDue, ombudsmanDeadline, makeRefCode(),
        ],
      );
      await client.query(
        `INSERT INTO complaint_events (complaint_id, event_date, type, note)
         VALUES ($1, $2, 'raised', $3)`,
        [rows[0].id, d.raised_on, `Complaint raised via ${d.channel || 'email'}`],
      );
      await client.query('COMMIT');
      res.status(201).json(await decorate(rows[0]));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

    const escalatedOn = req.body?.date || new Date().toISOString().slice(0, 10);
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
    const { rows } = await query(
      `UPDATE complaints SET
        org_name = COALESCE($2, org_name),
        reference = COALESCE($3, reference),
        our_reference = COALESCE($4, our_reference),
        property = COALESCE($5, property),
        subject = COALESCE($6, subject),
        category = COALESCE($7, category),
        description = COALESCE($8, description),
        response_due = COALESCE($9, response_due)
       WHERE id = $1 RETURNING *`,
      [
        req.params.id, d.org_name ?? null, d.reference ?? null, d.our_reference ?? null,
        d.property ?? null, d.subject ?? null, d.category ?? null, d.description ?? null,
        d.response_due ?? null,
      ],
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
