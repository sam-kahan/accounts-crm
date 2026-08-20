import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { monthRange, monthOf, monthLabel } from '../lib/dates.js';
import { withNumbers, toPence, fromPence } from '../lib/money.js';
import { toCsv } from '../lib/csv.js';
import {
  COMMISSION_TYPES,
  COMMISSION_ON,
  COMMISSION_BASES,
  PAID_FROM,
  dealFor,
  commissionFor,
  reconcileAmounts,
  commissionStatus,
} from '../services/commission.js';
import { invoiceUpload, invoiceMemoryUpload, documentStream, removeDocument } from '../services/contractorDocs.js';
import { extractInvoice } from '../services/invoiceExtract.js';

const router = Router();

const MONEY_COLS = ['net_amount', 'vat_amount', 'total_amount', 'commission_rate', 'commission_amount'];

const COLS = `i.id, i.contractor_id, i.invoice_number, i.invoice_date, i.property, i.landlord_ref,
  i.description, i.net_amount, i.vat_amount, i.total_amount, i.commission_type, i.commission_rate,
  i.commission_on, i.commission_basis, i.commission_amount, i.commission_override,
  i.commission_vat_inclusive, i.paid_from,
  i.paid_on, i.waived, i.waived_reason, i.commission_invoice_id, i.filename, i.mimetype,
  i.size_bytes, i.extracted, i.notes, i.created_at, i.updated_at`;

const FROM = `FROM contractor_invoices i
  JOIN contractors c ON c.id = i.contractor_id
  LEFT JOIN commission_invoices ci ON ci.id = i.commission_invoice_id`;

const JOINED = `${COLS}, c.name AS contractor_name, c.email AS contractor_email,
  ci.invoice_number AS commission_invoice_number, ci.status AS commission_invoice_status,
  (i.storage_path IS NOT NULL) AS has_document`;

// Filters matching commissionStatus() in services/commission.js — that function
// stays the canonical definition (it decorates every row on the way out); these
// are its SQL twins, used only to narrow a list query. Keys are validated
// against this map, so the fragments are never user input.
const STATUS_SQL = {
  pending: 'i.commission_invoice_id IS NULL AND NOT i.waived',
  invoiced: "i.commission_invoice_id IS NOT NULL AND COALESCE(ci.status, '') <> 'paid'",
  paid: "ci.status = 'paid'",
  waived: 'i.waived',
};

function decorate(row) {
  if (!row) return row;
  const r = withNumbers(row, MONEY_COLS);
  return { ...r, status: commissionStatus(r) };
}

// Multipart fields all arrive as strings, and an untouched form field arrives
// as ''. Drop the blanks so zod's .optional() means what it says, and so an
// empty date box doesn't become the string ''.
function stripEmpty(body = {}) {
  const out = {};
  for (const [k, v] of Object.entries(body)) {
    if (v === '' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

const money = z.coerce.number().min(0).max(1000000);
// Multipart sends booleans as the strings 'true'/'false', and Boolean('false')
// is true — so coerce explicitly rather than with z.coerce.boolean().
const boolish = z.preprocess(
  (v) => (typeof v === 'string' ? v === 'true' || v === '1' : v),
  z.boolean(),
);

const input = z.object({
  contractor_id: z.string().uuid(),
  invoice_number: z.string().max(60).optional().nullable(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  property: z.string().max(300).optional().nullable(),
  landlord_ref: z.string().max(120).optional().nullable(),
  description: z.string().max(1000).optional().nullable(),
  net_amount: money.optional(),
  vat_amount: money.optional(),
  total_amount: money.optional(),
  commission_type: z.enum(COMMISSION_TYPES).optional(),
  commission_rate: z.coerce.number().min(0).max(100).optional(),
  commission_on: z.enum(COMMISSION_ON).optional(),
  commission_basis: z.enum(COMMISSION_BASES).optional(),
  commission_amount: money.optional(),
  paid_from: z.enum(PAID_FROM).optional(),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  notes: z.string().max(4000).optional().nullable(),
  extracted: boolish.optional(),
});

async function getContractor(id) {
  const { rows } = await query('SELECT * FROM contractors WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Contractor not found');
  return rows[0];
}

// Work out the commission for an invoice: the deal comes from the contractor
// unless this invoice overrides part of it, and the amount is computed rather
// than taken on trust. A hand-typed figure that differs from the computed one
// is kept, but flagged, so a month-end total can always be explained.
function resolveCommission(contractor, d, amounts) {
  const deal = {
    ...dealFor(contractor),
    ...(d.commission_type ? { commission_type: d.commission_type } : {}),
    ...(d.commission_rate !== undefined ? { commission_rate: d.commission_rate } : {}),
    ...(d.commission_on ? { commission_on: d.commission_on } : {}),
    ...(d.commission_basis ? { commission_basis: d.commission_basis } : {}),
  };
  const computed = commissionFor(deal, amounts);
  const supplied = d.commission_amount;
  const override = supplied !== undefined && toPence(supplied) !== toPence(computed);
  return {
    ...deal,
    commission_amount: override ? supplied : computed,
    commission_override: override,
    computed_commission: computed,
  };
}

// --- AI extraction ----------------------------------------------------------

router.get(
  '/ai/config',
  asyncHandler(async (_req, res) => {
    res.json({ enabled: config.anthropic.enabled });
  }),
);

// Read an uploaded invoice and return the fields it contains, WITHOUT saving
// anything: the user checks them, then submits the form (with the same file) to
// save. Nothing is written to disk here, so an abandoned upload leaves nothing
// behind.
router.post(
  '/extract',
  invoiceMemoryUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, 'No file uploaded');
    const extracted = await extractInvoice(req.file);
    const amounts = reconcileAmounts(extracted);

    // If we know which contractor it's from, apply their deal straight away so
    // the form comes back complete.
    let commission = null;
    if (req.body?.contractor_id) {
      const contractor = await getContractor(req.body.contractor_id);
      commission = resolveCommission(contractor, {}, amounts);
    }

    res.json({
      ...extracted,
      ...amounts,
      commission_amount: commission ? commission.commission_amount : null,
      commission_rate: commission ? commission.commission_rate : null,
      commission_type: commission ? commission.commission_type : null,
    });
  }),
);

// --- reporting --------------------------------------------------------------

// Resolve the report window: ?month=YYYY-MM, or explicit ?from/&to, defaulting
// to the current UK month (the "what do I invoice this month?" question).
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
function windowFrom(q) {
  if (ISO_DATE.test(q.from || '') && ISO_DATE.test(q.to || '')) {
    return { from: q.from, to: q.to, month: null };
  }
  const month = /^\d{4}-\d{2}$/.test(q.month || '') ? q.month : monthOf();
  return { ...monthRange(month), month };
}

async function summarise({ from, to }) {
  const { rows } = await query(
    `SELECT c.id AS contractor_id, c.name AS contractor_name, c.email AS contractor_email,
            count(i.id)::int                                        AS invoice_count,
            COALESCE(sum(i.total_amount), 0)                        AS invoiced_total,
            COALESCE(sum(i.commission_amount), 0)                   AS commission_total,
            count(i.id) FILTER (WHERE i.commission_invoice_id IS NULL
                                  AND NOT i.waived)::int            AS pending_count,
            COALESCE(sum(i.commission_amount) FILTER (
              WHERE i.commission_invoice_id IS NULL AND NOT i.waived), 0) AS pending_commission,
            COALESCE(sum(i.commission_amount) FILTER (
              WHERE i.commission_invoice_id IS NOT NULL), 0)        AS billed_commission,
            COALESCE(sum(i.commission_amount) FILTER (WHERE i.waived), 0) AS waived_commission
       FROM contractors c
       JOIN contractor_invoices i
         ON i.contractor_id = c.id AND i.invoice_date BETWEEN $1 AND $2
      GROUP BY c.id, c.name, c.email
      HAVING count(i.id) > 0
      ORDER BY pending_commission DESC, c.name ASC`,
    [from, to],
  );

  const contractors = rows.map((r) =>
    withNumbers(r, [
      'invoiced_total',
      'commission_total',
      'pending_commission',
      'billed_commission',
      'waived_commission',
    ]),
  );

  const sum = (key) => fromPence(contractors.reduce((acc, r) => acc + (toPence(r[key]) ?? 0), 0));
  return {
    contractors,
    totals: {
      invoice_count: contractors.reduce((a, r) => a + r.invoice_count, 0),
      pending_count: contractors.reduce((a, r) => a + r.pending_count, 0),
      invoiced_total: sum('invoiced_total'),
      commission_total: sum('commission_total'),
      pending_commission: sum('pending_commission'),
      billed_commission: sum('billed_commission'),
      waived_commission: sum('waived_commission'),
    },
  };
}

// The month-end report: what each contractor owes us, and how much of it is
// still to be invoiced.
router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const w = windowFrom(req.query);
    const data = await summarise(w);
    res.json({ ...w, label: w.month ? monthLabel(w.month) : `${w.from} – ${w.to}`, ...data });
  }),
);

// The same period as a spreadsheet, line by line.
router.get(
  '/export.csv',
  asyncHandler(async (req, res) => {
    const w = windowFrom(req.query);
    const statusKey = STATUS_SQL[req.query.status] ? req.query.status : null;
    const { rows } = await query(
      `SELECT * FROM (SELECT ${JOINED} ${FROM}
         WHERE i.invoice_date BETWEEN $1 AND $2
           AND ($3::uuid IS NULL OR i.contractor_id = $3::uuid)) t
       ORDER BY t.contractor_name, t.invoice_date`,
      [w.from, w.to, req.query.contractor_id || null],
    );

    const lines = rows.map(decorate).filter((r) => !statusKey || r.status === statusKey);
    const csv = toCsv(
      [
        { key: 'contractor_name', label: 'Contractor' },
        { key: 'invoice_date', label: 'Invoice date' },
        { key: 'invoice_number', label: 'Their invoice no.' },
        { key: 'property', label: 'Property' },
        { key: 'landlord_ref', label: 'Landlord ref' },
        { key: 'description', label: 'Works' },
        { key: 'net_amount', label: 'Net' },
        { key: 'vat_amount', label: 'VAT' },
        { key: 'total_amount', label: 'Invoice total' },
        { key: 'commission_rate', label: 'Rate %' },
        { key: 'commission_amount', label: 'Commission' },
        { key: 'paid_from', label: 'Paid from' },
        { key: 'status', label: 'Status' },
        { key: 'commission_invoice_number', label: 'Commission invoice' },
      ],
      lines,
    );

    const name = `commission-${w.month || `${w.from}_${w.to}`}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(csv);
  }),
);

// --- the logged invoices ----------------------------------------------------

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const statusKey = STATUS_SQL[req.query.status] ? req.query.status : null;
    const limit = Math.min(Number(req.query.limit) || 200, 500);
    const { rows } = await query(
      `SELECT ${JOINED} ${FROM}
        WHERE ($1::uuid IS NULL OR i.contractor_id = $1::uuid)
          AND ($2::date IS NULL OR i.invoice_date >= $2::date)
          AND ($3::date IS NULL OR i.invoice_date <= $3::date)
          AND ($4 = '' OR i.invoice_number ILIKE '%' || $4 || '%'
                       OR COALESCE(i.property, '') ILIKE '%' || $4 || '%'
                       OR COALESCE(i.description, '') ILIKE '%' || $4 || '%'
                       OR c.name ILIKE '%' || $4 || '%')
          ${statusKey ? `AND ${STATUS_SQL[statusKey]}` : ''}
        ORDER BY i.invoice_date DESC, i.created_at DESC
        LIMIT $5`,
      [
        req.query.contractor_id || null,
        req.query.from || null,
        req.query.to || null,
        (req.query.search || '').trim(),
        limit,
      ],
    );
    res.json(rows.map(decorate));
  }),
);

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(`SELECT ${JOINED} ${FROM} WHERE i.id = $1`, [req.params.id]);
    if (!rows[0]) throw new HttpError(404, 'Invoice not found');
    res.json(decorate(rows[0]));
  }),
);

// Log an invoice, with the document attached in the same request.
router.post(
  '/',
  invoiceUpload.single('file'),
  asyncHandler(async (req, res) => {
    let d = null;
    try {
      d = parse(input, stripEmpty(req.body));
      const contractor = await getContractor(d.contractor_id);
      const amounts = reconcileAmounts(d);
      const commission = resolveCommission(contractor, d, amounts);
      const file = req.file;

      const { rows } = await query(
        `INSERT INTO contractor_invoices
          (contractor_id, invoice_number, invoice_date, property, landlord_ref, description,
           net_amount, vat_amount, total_amount, commission_type, commission_rate, commission_on,
           commission_basis, commission_amount, commission_override, commission_vat_inclusive,
           paid_from, paid_on, notes,
           filename, mimetype, size_bytes, storage_path, extracted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$24,
                 COALESCE($16,'client'),$17,$18,$19,$20,$21,$22,COALESCE($23,false))
         RETURNING id`,
        [
          d.contractor_id, d.invoice_number || null, d.invoice_date, d.property || null,
          d.landlord_ref || null, d.description || null,
          amounts.net_amount, amounts.vat_amount, amounts.total_amount,
          commission.commission_type, commission.commission_rate, commission.commission_on,
          commission.commission_basis, commission.commission_amount, commission.commission_override,
          d.paid_from ?? null, d.paid_on || null, d.notes || null,
          file?.originalname || null, file?.mimetype || null, file?.size || null,
          file?.path || null, d.extracted ?? null,
          // Snapshot the VAT treatment: a contractor registering for VAT later
          // must not re-rate commission they have already collected.
          !contractor.vat_registered,
        ],
      );

      const { rows: full } = await query(`SELECT ${JOINED} ${FROM} WHERE i.id = $1`, [rows[0].id]);
      res.status(201).json(decorate(full[0]));
    } catch (err) {
      // The file is already on disk by the time we get here; don't leave an
      // orphan behind if the row didn't save.
      await removeDocument(req.file?.path);
      if (err?.code === '23505') {
        throw new HttpError(
          409,
          `Invoice ${d?.invoice_number} is already logged against this contractor — its commission would be claimed twice.`,
        );
      }
      throw err;
    }
  }),
);

router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const d = parse(input.omit({ contractor_id: true }).partial(), stripEmpty(req.body));
    const { rows: existing } = await query('SELECT * FROM contractor_invoices WHERE id = $1', [
      req.params.id,
    ]);
    const current = existing[0];
    if (!current) throw new HttpError(404, 'Invoice not found');
    if (current.commission_invoice_id) {
      throw new HttpError(
        409,
        'This invoice is already on a commission invoice. Void that invoice first if it needs changing.',
      );
    }

    const contractor = await getContractor(current.contractor_id);
    // Amounts fall back to what is already stored, so editing just the property
    // doesn't zero the money.
    const amounts = reconcileAmounts({
      net_amount: d.net_amount ?? current.net_amount,
      vat_amount: d.vat_amount ?? current.vat_amount,
      // Left out on purpose: the total is re-derived from net + VAT unless the
      // caller states one, so editing the net keeps the invoice adding up.
      total_amount: d.total_amount,
    });
    // Recompute against the snapshot on the row, not today's contractor deal —
    // re-saving an old invoice must not silently re-rate it.
    const commission = resolveCommission(
      { ...contractor, ...dealFor(current) },
      d,
      amounts,
    );

    const { rows } = await query(
      `UPDATE contractor_invoices SET
         invoice_number = COALESCE($2, invoice_number),
         invoice_date   = COALESCE($3, invoice_date),
         property       = $4, landlord_ref = $5, description = $6,
         net_amount = $7, vat_amount = $8, total_amount = $9,
         commission_type = $10, commission_rate = $11, commission_on = $12,
         commission_basis = $13, commission_amount = $14, commission_override = $15,
         paid_from = COALESCE($16, paid_from), paid_on = $17, notes = $18
       WHERE id = $1 RETURNING id`,
      [
        req.params.id, d.invoice_number ?? null, d.invoice_date ?? null,
        d.property ?? current.property, d.landlord_ref ?? current.landlord_ref,
        d.description ?? current.description,
        amounts.net_amount, amounts.vat_amount, amounts.total_amount,
        commission.commission_type, commission.commission_rate, commission.commission_on,
        commission.commission_basis, commission.commission_amount, commission.commission_override,
        d.paid_from ?? null, d.paid_on ?? current.paid_on, d.notes ?? current.notes,
      ],
    );
    const { rows: full } = await query(`SELECT ${JOINED} ${FROM} WHERE i.id = $1`, [rows[0].id]);
    res.json(decorate(full[0]));
  }),
);

// Waive (or un-waive) a commission — e.g. the work was redone free, or the
// contractor already credited it.
router.post(
  '/:id/waive',
  asyncHandler(async (req, res) => {
    const d = parse(
      z.object({ waived: z.boolean().optional(), reason: z.string().max(500).optional().nullable() }),
      req.body || {},
    );
    const waived = d.waived ?? true;
    const { rows } = await query(
      `UPDATE contractor_invoices
          SET waived = $2, waived_reason = CASE WHEN $2 THEN $3 ELSE NULL END
        WHERE id = $1 AND commission_invoice_id IS NULL
        RETURNING id`,
      [req.params.id, waived, d.reason || null],
    );
    if (!rows[0]) {
      const { rows: exists } = await query('SELECT id FROM contractor_invoices WHERE id = $1', [
        req.params.id,
      ]);
      throw exists[0]
        ? new HttpError(409, 'This commission has already been invoiced, so it can’t be waived.')
        : new HttpError(404, 'Invoice not found');
    }
    const { rows: full } = await query(`SELECT ${JOINED} ${FROM} WHERE i.id = $1`, [req.params.id]);
    res.json(decorate(full[0]));
  }),
);

router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `DELETE FROM contractor_invoices
        WHERE id = $1 AND commission_invoice_id IS NULL
        RETURNING storage_path`,
      [req.params.id],
    );
    if (!rows[0]) {
      const { rows: exists } = await query('SELECT id FROM contractor_invoices WHERE id = $1', [
        req.params.id,
      ]);
      throw exists[0]
        ? new HttpError(409, 'This invoice is on a commission invoice — void that first.')
        : new HttpError(404, 'Invoice not found');
    }
    await removeDocument(rows[0].storage_path);
    res.status(204).end();
  }),
);

// Download the stored invoice document.
router.get(
  '/:id/document',
  asyncHandler(async (req, res) => {
    if (!z.string().uuid().safeParse(req.params.id).success) {
      throw new HttpError(400, 'Invalid invoice id');
    }
    const { rows } = await query(
      'SELECT filename, mimetype, storage_path FROM contractor_invoices WHERE id = $1',
      [req.params.id],
    );
    const doc = rows[0];
    if (!doc || !doc.storage_path) throw new HttpError(404, 'No document stored for this invoice');
    // Always a download, never rendered inline: an uploaded HTML or SVG file
    // would otherwise execute as script on our own origin.
    res.setHeader('Content-Type', doc.mimetype || 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${(doc.filename || 'invoice').replace(/"/g, '')}"`,
    );
    documentStream(doc.storage_path).pipe(res);
  }),
);

export { summarise, windowFrom };
export default router;
