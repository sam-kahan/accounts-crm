import { Router } from 'express';
import { z } from 'zod';
import { pool, query } from '../db/pool.js';
import { asyncHandler, HttpError, parse, requireUuidParam } from '../lib/http.js';
import { buildUpdateSet } from '../lib/sql.js';
import { withNumbers } from '../lib/money.js';
import { config } from '../config.js';
import { COMMISSION_TYPES, COMMISSION_ON, COMMISSION_BASES, describeDeal } from '../services/commission.js';
import { REGION_KEYS } from '../services/regions.js';
import { emailListProblem, parseEmailList } from '../lib/emailList.js';

const router = Router();
// Every :id route on this router is a UUID primary key — reject anything else
// with a clean 400 instead of a raw Postgres "invalid input syntax" 500.
router.param('id', requireUuidParam);

const NUMERIC_COLS = ['commission_rate', 'commission_fixed'];

const COLS = `id, name, trade, contact_name, email, phone, address,
  commission_type, commission_rate, commission_fixed, commission_on, commission_basis,
  payment_terms_days, vat_registered, commission_vat_exempt, default_region, agreement_notes, active, notes,
  created_at, updated_at`;

const input = z.object({
  name: z.string().min(1).max(200),
  trade: z.string().max(100).optional().nullable(),
  contact_name: z.string().max(200).optional().nullable(),
  // One address or several (commas between them); see emailWanted().
  email: z.string().max(2000).optional().nullable(),
  phone: z.string().max(64).optional().nullable(),
  address: z.string().max(1000).optional().nullable(),
  commission_type: z.enum(COMMISSION_TYPES).optional(),
  commission_rate: z.number().min(0).max(100).optional(),
  commission_fixed: z.number().min(0).max(1000000).optional(),
  commission_on: z.enum(COMMISSION_ON).optional(),
  commission_basis: z.enum(COMMISSION_BASES).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  vat_registered: z.boolean().optional(),
  // Their commission is exempt from VAT (an insurance broker's: arranging
  // insurance is an exempt supply), so it is invoiced back at 0%.
  commission_vat_exempt: z.boolean().optional(),
  // The office to fall back on when the property address doesn't settle it.
  // Null clears it back to asking.
  default_region: z.enum(REGION_KEYS).optional().nullable(),
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
      payment_terms_days: config.commission.paymentTermsDays,
      // Shown read-only on the form: it is Greenco's VAT, not a per-contractor
      // choice, so there is nothing to set here.
      vat_rate: config.commission.vatRate,
      vat_registered: true,
      commission_vat_exempt: false,
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

// The email field as stored: "a@x.co.uk, b@x.co.uk", null when cleared, and
// undefined (left alone) when not sent. Refused, naming the culprit, rather
// than saved with an address that would bounce or be dropped.
function emailWanted(raw) {
  if (raw === undefined) return undefined;
  const problem = emailListProblem(raw);
  if (problem) throw new HttpError(400, problem);
  return parseEmailList(raw).value;
}

router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(input, req.body);
    d.email = emailWanted(d.email);
    // Defaults are resolved here rather than with COALESCE in SQL: an untyped
    // null parameter comes through as text, which a NUMERIC column rejects.
    const { rows } = await query(
      `INSERT INTO contractors
        (name, trade, contact_name, email, phone, address, commission_type, commission_rate,
         commission_fixed, commission_on, commission_basis,
         payment_terms_days, vat_registered, agreement_notes, active, notes, default_region,
         commission_vat_exempt)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
       RETURNING ${COLS}`,
      [
        d.name, d.trade || null, d.contact_name || null, d.email || null, d.phone || null,
        d.address || null,
        d.commission_type ?? 'percentage',
        d.commission_rate ?? 0,
        d.commission_fixed ?? 0,
        d.commission_on ?? 'net',
        d.commission_basis ?? 'markup',
        d.payment_terms_days ?? config.commission.paymentTermsDays,
        d.vat_registered ?? true,
        d.agreement_notes || null,
        d.active ?? true,
        d.notes || null,
        d.default_region || null,
        d.commission_vat_exempt ?? false,
      ],
    );
    res.status(201).json(decorate(rows[0]));
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input.partial(), req.body);
    d.email = emailWanted(d.email);
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
      payment_terms_days: d.payment_terms_days,
      vat_registered: d.vat_registered,
      commission_vat_exempt: d.commission_vat_exempt,
      default_region: d.default_region,
      agreement_notes: d.agreement_notes,
      active: d.active,
      notes: d.notes,
    });
    if (!clause) throw new HttpError(400, 'Nothing to update');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(
        `UPDATE contractors SET ${clause} WHERE id = $1 RETURNING ${COLS}`,
        [req.params.id, ...values],
      );
      if (!rows[0]) throw new HttpError(404, 'Contractor not found');

      // Whether commission is exempt from VAT is a fact about what they do
      // (insurance), not a negotiated term, so correcting it reaches the
      // invoices logged but not yet invoiced. One already on a commission
      // invoice is left as billed: void that invoice to re-raise it.
      let restated = 0;
      let alreadyInvoiced = 0;
      if (d.commission_vat_exempt !== undefined) {
        const upd = await client.query(
          `UPDATE contractor_invoices SET commission_vat_exempt = $2
            WHERE contractor_id = $1 AND commission_invoice_id IS NULL
              AND commission_vat_exempt IS DISTINCT FROM $2`,
          [req.params.id, d.commission_vat_exempt],
        );
        restated = upd.rowCount;
        const { rows: billed } = await client.query(
          `SELECT count(DISTINCT i.commission_invoice_id)::int AS n
             FROM contractor_invoices i
             JOIN commission_invoices ci ON ci.id = i.commission_invoice_id
            WHERE i.contractor_id = $1 AND ci.status <> 'void'
              AND i.commission_vat_exempt IS DISTINCT FROM $2`,
          [req.params.id, d.commission_vat_exempt],
        );
        alreadyInvoiced = billed[0].n;
      }
      await client.query('COMMIT');
      res.json({ ...decorate(rows[0]), vat_exempt_restated: restated, vat_exempt_already_invoiced: alreadyInvoiced });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
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
