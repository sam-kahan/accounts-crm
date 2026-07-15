import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';

const router = Router();

const input = z.object({
  company_id: z.string().uuid(),
  category: z
    .enum([
      'accounts',
      'confirmation_statement',
      'corporation_tax',
      'vat',
      'paye',
      'custom',
    ])
    .optional(),
  title: z.string().min(1),
  due_date: z.string().min(1),
  recurrence: z.enum(['none', 'annual', 'quarterly', 'monthly']).optional(),
  notes: z.string().optional().nullable(),
});

// Advance a date by the recurrence interval (used when marking a date done).
function nextOccurrence(dateStr, recurrence) {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (recurrence === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (recurrence === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
  else if (recurrence === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else return null;
  return d.toISOString().slice(0, 10);
}

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const params = [];
    let where = '';
    if (req.query.company_id) {
      params.push(req.query.company_id);
      where = 'WHERE company_id = $1';
    }
    const { rows } = await query(
      `SELECT k.*, c.name AS company_name
         FROM key_dates k JOIN companies c ON c.id = k.company_id
         ${where} ORDER BY due_date ASC`,
      params,
    );
    res.json(rows);
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const data = parse(input, req.body);
    const { rows } = await query(
      `INSERT INTO key_dates
         (company_id, category, title, due_date, recurrence, notes, source)
       VALUES ($1,$2,$3,$4,$5,$6,'manual') RETURNING *`,
      [
        data.company_id,
        data.category || 'custom',
        data.title,
        data.due_date,
        data.recurrence || 'none',
        data.notes || null,
      ],
    );
    res.status(201).json(rows[0]);
  }),
);

// Mark done. Recurring dates roll forward to the next occurrence instead of
// closing, so a company's annual accounts date is never "lost".
router.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM key_dates WHERE id = $1', [
      req.params.id,
    ]);
    const kd = rows[0];
    if (!kd) throw new HttpError(404, 'Key date not found');

    const next = nextOccurrence(kd.due_date, kd.recurrence);
    if (next) {
      const updated = await query(
        `UPDATE key_dates SET due_date = $2, status = 'pending', completed_at = NULL
           WHERE id = $1 RETURNING *`,
        [req.params.id, next],
      );
      return res.json({ ...updated.rows[0], rolled_forward_to: next });
    }
    const updated = await query(
      `UPDATE key_dates SET status = 'done', completed_at = now()
         WHERE id = $1 RETURNING *`,
      [req.params.id],
    );
    res.json(updated.rows[0]);
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const data = parse(input.partial(), req.body);
    const { rows } = await query(
      `UPDATE key_dates SET
         category = COALESCE($2, category),
         title = COALESCE($3, title),
         due_date = COALESCE($4, due_date),
         recurrence = COALESCE($5, recurrence),
         notes = COALESCE($6, notes)
       WHERE id = $1 RETURNING *`,
      [
        req.params.id,
        data.category ?? null,
        data.title ?? null,
        data.due_date ?? null,
        data.recurrence ?? null,
        data.notes ?? null,
      ],
    );
    if (!rows[0]) throw new HttpError(404, 'Key date not found');
    res.json(rows[0]);
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rowCount } = await query('DELETE FROM key_dates WHERE id = $1', [
      req.params.id,
    ]);
    if (!rowCount) throw new HttpError(404, 'Key date not found');
    res.status(204).end();
  }),
);

export default router;
