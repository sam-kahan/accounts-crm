import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { buildUpdateSet } from '../lib/sql.js';
import { withNumbers } from '../lib/money.js';
import { config } from '../config.js';
import { COMMISSION_TYPES, COMMISSION_ON, COMMISSION_BASES, describeDeal } from '../services/commission.js';

const router = Router();

const NUMERIC_COLS = ['commission_rate', 'commission_fixed', 'commission_vat_rate'];

const COLS = `id, name, trade, contact_name, email, phone, address,
  commission_type, commission_rate, commission_fixed, commission_on, commission_basis,
  commission_vat_rate, payment_terms_days, vat_registered, agreement_notes, active, notes,
  created_at, updated_at`;

const input = z.object({
  name: z.string().min(1).max(200),
  trade: z.string().max(100).optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  email: z.string().max(320).optional().nullable(),
  phone: z.string().max(64).optional().nullable(),
  address: z.string().max(1000).optional().nullable(),
  commission_type: z.enum(COMMISSION_TYPES).optional(),
  commission_rate: z.number().min(0).max(100).optional(),
  commission_fixed: z.number().min(0).max(1000000).optional(),
  commission_on: z.enum(COMMISSION_ON).optional(),
  commission_basis: z.enum(COMMISSION_BASES).optional(),
  commission_vat_rate: z.number().min(0).max(100).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  vat_registered: z.boolean().optional(),
  agreement_notes: z.string().max(4000).optional().nullable(),
  active: z.boolean().optional(),
  notes: z.string().max(4000).optional().nullable(),
});

// Decorate a contractor row with the deal in words, so every surface (list,
// form, invoice email) describes the agreement the same way.
function decorate(row) {
  if (!row) return row;
  const r = withNumbers(row, [...NUMERIC_COLS, 'pending_commission', 'billed_commission', 'invoice_count', 'pending_count']);
  return { ...r, deal_summary: describeDeal(r) };
}

// Defaults for a brand-new contractor, so the form opens on the house terms.
router.get(
  '/defaults',
  asyncHandler(async (_req, res) => {
    res.json({
      commission_type: 'percentage',
      commission_rate: 0,
      commission_fixed: 0,
      commission_on: 'net',
      commission_basis: 'markup',
      commission_vat_rate: config.commission.defaultVatRate,
      payment_terms_days: config.commission.paymentTermsDays,
      vat_registered: true,
      active: true,
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const search = (req.query.search || '').trim();
    const activeOnly = req.query.active === 'true';
    const { rows } = await query(
      `SELECT c.*,
              count(i.id)                                        AS invoice_count,
              count(i.id) FILTER (WHERE i.commission_invoice_id IS NULL
                                    AND NOT i.waived)            AS pending_count,
              COALESCE(sum(i.commission_amount) FILTER (
                WHERE i.commission_invoice_id IS NULL AND NOT i.waived), 0) AS pending_commission,
              COALESCE(sum(i.commission_amount) FILTER (
                WHERE i.commission_invoice_id IS NOT NULL), 0)   AS billed_commission
         FROM contractors c
         LEFT JOIN contractor_invoices i ON i.contractor_id = c.id
        WHERE ($1 = '' OR c.name ILIKE '%' || $1 || '%' OR COALESCE(c.trade, '') ILIKE '%' || $1 || '%')
          AND ($2::boolean IS NOT TRUE OR c.active)
        GROUP BY c.id
        ORDER BY c.active DESC, c.name ASC`,
      [search, activeOnly],
    );
    res.json(rows.map(decorate));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT ${COLS} FROM contractors WHERE id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Contractor not found');
    res.json(decorate(rows[0]));
  }),
);

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    // Defaults are resolved here rather than with COALESCE in SQL: an untyped
    // null parameter comes through as text, which a NUMERIC column rejects.
    const { rows } = await query(
      `INSERT INTO contractors
        (name, trade, contact_name, email, phone, address, commission_type, commission_rate,
         commission_fixed, commission_on, commission_basis, commission_vat_rate,
         payment_terms_days, vat_registered, agreement_notes, active, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING ${COLS}`,
      [
        d.name, d.trade || null, d.contact_name || null, d.email || null, d.phone || null,
        d.address || null,
        d.commission_type ?? 'percentage',
        d.commission_rate ?? 0,
        d.commission_fixed ?? 0,
        d.commission_on ?? 'net',
        d.commission_basis ?? 'markup',
        d.commission_vat_rate ?? config.commission.defaultVatRate,
        d.payment_terms_days ?? config.commission.paymentTermsDays,
        d.vat_registered ?? true,
        d.agreement_notes || null,
        d.active ?? true,
        d.notes || null,
      ],
    );
    res.status(201).json(decorate(rows[0]));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input.partial(), req.body);
    // buildUpdateSet so an omitted field is left alone while an explicit null
    // clears a nullable column (a contact name really can be removed).
    const { clause, values } = buildUpdateSet({
      name: d.name,
      trade: d.trade,
      contact_name: d.contact_name,
      email: d.email,
      phone: d.phone,
      address: d.address,
      commission_type: d.commission_type,
      commission_rate: d.commission_rate,
      commission_fixed: d.commission_fixed,
      commission_on: d.commission_on,
      commission_basis: d.commission_basis,
      commission_vat_rate: d.commission_vat_rate,
      payment_terms_days: d.payment_terms_days,
      vat_registered: d.vat_registered,
      agreement_notes: d.agreement_notes,
      active: d.active,
      notes: d.notes,
    });
    if (!clause) throw new HttpError(400, 'Nothing to update');
    const { rows } = await query(
      `UPDATE contractors SET ${clause} WHERE id = $1 RETURNING ${COLS}`,
      [req.params.id, ...values],
    );
    if (!rows[0]) throw new HttpError(404, 'Contractor not found');
    res.json(decorate(rows[0]));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    // Logged invoices are financial records — a contractor with history is
    // deactivated, never deleted out from under them.
    const { rows: used } = await query(
      'SELECT count(*)::int AS n FROM contractor_invoices WHERE contractor_id = $1',
      [req.params.id],
    );
    if (used[0].n > 0) {
      throw new HttpError(
        409,
        `This contractor has ${used[0].n} logged invoice(s). Mark them inactive instead of deleting.`,
      );
    }
    const { rowCount } = await query('DELETE FROM contractors WHERE id = $1', [req.params.id]);
    if (!rowCount) throw new HttpError(404, 'Contractor not found');
    res.status(204).end();
  }),
);

export default router;
