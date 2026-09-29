import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam } from '../lib/http.js';
import { nextOccurrence } from '../lib/dates.js';
import { buildUpdateSet } from '../lib/sql.js';

const router = Router();
// Every :id route on this router is a UUID primary key — reject anything else
// with a clean 400 instead of a raw Postgres "invalid input syntax" 500.
router.param('id', requireUuidParam);

const input = z.object({
  company_id: z.string().uuid(),
  category: z
    .enum([
      'year_end',
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

// Advancing a recurring date to its next occurrence: lib/dates.js#nextOccurrence.

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

// Mark done.
//
// Manual recurring dates (e.g. a self-tracked VAT quarter) roll forward to the
// next occurrence instead of closing, so the series is never "lost".
//
// Companies-House-sourced dates do NOT roll forward here: Companies House is
// the source of truth for when the next period begins, and it only advances
// once the filing is actually made. So we just mark them done — the next
// re-sync rolls the date forward when CH genuinely moves it (a hand-completed
// financial year end therefore stays done until the accounts are filed, rather
// than being guessed a year ahead and then dragged back to overdue on the next
// sync).
router.post(
  '/:id/complete',
  asyncHandler(async (req, res) => {
    const { rows } = await query('SELECT * FROM key_dates WHERE id = $1', [
      req.params.id,
    ]);
    const kd = rows[0];
    if (!kd) throw new HttpError(404, 'Key date not found');
    // The page says which date it was marking done. A second press (a
    // double-click, or a page not refreshed) would otherwise roll a recurring
    // date on twice and skip a period's reminder without anyone noticing.
    const expected = typeof req.body?.due_date === 'string' ? req.body.due_date : null;
    if ((expected && expected !== kd.due_date) || (expected && kd.status === 'done')) {
      throw new HttpError(409, 'This date has already been marked done. Refresh to see where it stands.');
    }

    const next =
      kd.source === 'companies_house'
        ? null
        : nextOccurrence(kd.due_date, kd.recurrence);
    if (next) {
      // Only from the date read above: two presses at once both read the same
      // date, and only the first moves it.
      const updated = await query(
        `UPDATE key_dates SET due_date = $2, status = 'pending', completed_at = NULL
           WHERE id = $1 AND due_date = $3 RETURNING *`,
        [req.params.id, next, kd.due_date],
      );
      if (!updated.rows[0]) throw new HttpError(409, 'This date has already been marked done. Refresh to see where it stands.');
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
    // Update only the sent fields; an explicit null clears `notes` (the only
    // nullable column here — title/due_date are NOT NULL and the schema keeps
    // them non-null, so they can't be wiped).
    const { clause, values } = buildUpdateSet({
      category: data.category,
      title: data.title,
      due_date: data.due_date,
      recurrence: data.recurrence,
      notes: data.notes,
    });
    if (!clause) throw new HttpError(400, 'No fields to update');
    const { rows } = await query(
      `UPDATE key_dates SET ${clause} WHERE id = $1 RETURNING *`,
      [req.params.id, ...values],
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
