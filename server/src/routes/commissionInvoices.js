import { Router } from 'express';
import { z } from 'zod';
import { query, pool } from '../db/pool.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { config } from '../config.js';
import { todayISO, monthRange, monthOf } from '../lib/dates.js';
import { withNumbers, fromPence } from '../lib/money.js';
import {
  commissionInvoiceNumber,
  invoiceTotalsFromLines,
  commissionNetPence,
  applyExternalState,
  dueDateFor,
  buildCommissionInvoiceEmail,
} from '../services/commission.js';
import { sendMail, mailerStatus } from '../services/mailer.js';
import {
  invoicingStatus,
  pushInvoice,
  fetchInvoiceState,
} from '../services/invoicesManager.js';
import { REGION_KEYS, REGION_LABEL, isRegion } from '../services/regions.js';

const router = Router();

const MONEY_COLS = ['net_amount', 'vat_rate', 'vat_amount', 'total_amount', 'external_total'];
const LINE_MONEY_COLS = ['net_amount', 'vat_amount', 'total_amount', 'commission_rate', 'commission_amount'];

const COLS = `ci.id, ci.contractor_id, ci.invoice_number, ci.period_start, ci.period_end,
  ci.issue_date, ci.due_date, ci.net_amount, ci.vat_rate, ci.vat_amount, ci.total_amount,
  ci.status, ci.sent_at, ci.sent_to, ci.paid_on, ci.notes, ci.region, ci.external_id,
  ci.external_number, ci.external_url, ci.external_status, ci.external_total,
  ci.external_synced_at, ci.external_company_id, ci.external_error, ci.created_at, ci.updated_at`;

const decorate = (row) =>
  row
    ? {
        ...withNumbers(row, MONEY_COLS),
        region_label: REGION_LABEL[row.region] || row.region || null,
        // Which Greenco company this invoice is raised by. The region is the
        // decision; this is the name that goes on the paperwork.
        company_name: config.regions[row.region]?.company_name || config.billing.name,
      }
    : row;

// Our own details as they appear on the invoice — the details of whichever
// Greenco company is raising it, since Manchester and Liverpool are separate
// legal entities with their own VAT and company numbers. Anything unset falls
// back to the shared block and is otherwise left off rather than invented.
function billingBlock(region) {
  const office = config.regions[region] || {};
  return {
    name: office.company_name || config.billing.name,
    address: office.address || config.billing.address,
    email: config.billing.email,
    phone: config.billing.phone,
    vat_number: office.vat_number || config.billing.vatNumber,
    company_number: office.company_number || config.billing.companyNumber,
    bank_details: config.billing.bankDetails,
    complete: config.billing.complete,
    region: region || null,
    region_label: REGION_LABEL[region] || null,
  };
}

router.get(
  '/settings',
  asyncHandler(async (_req, res) => {
    res.json({
      billing: billingBlock(),
      mailer: mailerStatus(),
      invoicing: invoicingStatus(),
      commission: { vat_rate: config.commission.vatRate, invoice_prefix: config.commission.invoicePrefix },
      // The offices an invoice can be raised from, and who each of them is.
      regions: REGION_KEYS.map((key) => ({
        key,
        label: REGION_LABEL[key],
        company_name: config.regions[key].company_name,
      })),
    });
  }),
);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT ${COLS}, c.name AS contractor_name, c.email AS contractor_email,
              (SELECT count(*)::int FROM contractor_invoices i WHERE i.commission_invoice_id = ci.id) AS line_count
         FROM commission_invoices ci
         JOIN contractors c ON c.id = ci.contractor_id
        WHERE ($1::uuid IS NULL OR ci.contractor_id = $1::uuid)
          AND ($2 = '' OR ci.status = $2)
          AND ($3 = '' OR ci.region = $3)
        ORDER BY ci.issue_date DESC, ci.invoice_number DESC`,
      [
        req.query.contractor_id || null,
        req.query.status || '',
        isRegion(req.query.region) ? req.query.region : '',
      ],
    );
    res.json(rows.map(decorate));
  }),
);

// One invoice with everything needed to print or email it: our billing block,
// the contractor, and the lines it is made of.
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT ${COLS}, c.name AS contractor_name, c.email AS contractor_email,
              c.address AS contractor_address, c.contact_name AS contractor_contact
         FROM commission_invoices ci
         JOIN contractors c ON c.id = ci.contractor_id
        WHERE ci.id = $1`,
      [req.params.id],
    );
    if (!rows[0]) throw new HttpError(404, 'Commission invoice not found');

    const { rows: lines } = await query(
      `SELECT id, invoice_number, invoice_date, property, landlord_ref, description,
              net_amount, vat_amount, total_amount, commission_rate, commission_amount,
              commission_vat_inclusive, region, (storage_path IS NOT NULL) AS has_document
         FROM contractor_invoices
        WHERE commission_invoice_id = $1
        ORDER BY invoice_date, created_at`,
      [req.params.id],
    );

    res.json({
      ...decorate(rows[0]),
      // `commission_amount` is what the contractor collected; `commission_net`
      // is what we invoice before VAT — the same for a VAT-registered
      // contractor, netted down for one who isn't.
      lines: lines.map((l) => ({
        ...withNumbers(l, LINE_MONEY_COLS),
        commission_net: fromPence(commissionNetPence(l, rows[0].vat_rate)),
      })),
      billing: billingBlock(rows[0].region),
      invoicing: invoicingStatus(),
    });
  }),
);

// What would go on an invoice for this contractor and period, without raising
// one — the "check before you send" view.
router.get(
  '/preview/:contractorId',
  asyncHandler(async (req, res) => {
    const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : monthOf();
    const range = monthRange(month);
    const from = req.query.from || range.from;
    const to = req.query.to || range.to;

    const { rows: contractors } = await query('SELECT * FROM contractors WHERE id = $1', [
      req.params.contractorId,
    ]);
    if (!contractors[0]) throw new HttpError(404, 'Contractor not found');

    // An invoice is raised by one Greenco company, so a preview is of one
    // office's work. Without a region the preview would total up jobs that can
    // never share a document.
    const region = isRegion(req.query.region) ? req.query.region : null;

    const { rows: lines } = await query(
      `SELECT id, invoice_number, invoice_date, property, description,
              net_amount, vat_amount, total_amount, commission_rate, commission_amount,
              commission_vat_inclusive, region
         FROM contractor_invoices
        WHERE contractor_id = $1 AND commission_invoice_id IS NULL AND NOT waived
          AND invoice_date BETWEEN $2 AND $3
          AND ($4 = '' OR region = $4)
        ORDER BY invoice_date, created_at`,
      [req.params.contractorId, from, to, region || ''],
    );

    res.json({
      contractor: withNumbers(contractors[0], ['commission_rate', 'commission_fixed']),
      period_start: from,
      period_end: to,
      month,
      region,
      region_label: REGION_LABEL[region] || null,
      billing: billingBlock(region),
      lines: lines.map((l) => withNumbers(l, LINE_MONEY_COLS)),
      ...invoiceTotalsFromLines(lines, config.commission.vatRate),
    });
  }),
);

const raiseInput = z.object({
  contractor_id: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  period_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  period_end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  issue_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // Optional: bill only these lines. Omitted = everything pending in the period.
  invoice_ids: z.array(z.string().uuid()).max(500).optional(),
  vat_rate: z.number().min(0).max(100).optional(),
  notes: z.string().max(2000).optional().nullable(),
  // Which Greenco company raises it. Required, because the two are separate
  // legal entities: an invoice has to be one company's, and picking one on the
  // caller's behalf would be picking whose VAT return the money lands in.
  region: z.enum(REGION_KEYS),
});

// Raise the month's commission invoice: claim every pending line in the period,
// total them, and link them to the new invoice.
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const d = parse(raiseInput, req.body);
    const range = monthRange(d.month || monthOf());
    const from = d.period_start || range.from;
    const to = d.period_end || range.to;
    if (to < from) throw new HttpError(400, 'The period ends before it starts.');
    const issue = d.issue_date || todayISO();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const { rows: contractors } = await client.query(
        'SELECT * FROM contractors WHERE id = $1',
        [d.contractor_id],
      );
      const contractor = contractors[0];
      if (!contractor) throw new HttpError(404, 'Contractor not found');

      // FOR UPDATE holds the pending lines for the length of the transaction:
      // two people raising the same month's invoice at once would otherwise
      // each claim the same commission, and we'd bill the contractor twice.
      const { rows: lines } = await client.query(
        `SELECT id, commission_amount, commission_vat_inclusive FROM contractor_invoices
          WHERE contractor_id = $1 AND commission_invoice_id IS NULL AND NOT waived
            AND invoice_date BETWEEN $2 AND $3
            AND region = $5
            AND ($4::uuid[] IS NULL OR id = ANY($4::uuid[]))
          ORDER BY invoice_date, created_at
          FOR UPDATE`,
        [d.contractor_id, from, to, d.invoice_ids?.length ? d.invoice_ids : null, d.region],
      );

      if (lines.length === 0) {
        throw new HttpError(
          400,
          `There is no ${REGION_LABEL[d.region]} commission left to invoice for that period.`,
        );
      }

      // Greenco's own VAT, one setting for every commission invoice. The
      // per-raise override stays for the odd exception, but nothing routine
      // needs it.
      const vatRate = d.vat_rate ?? config.commission.vatRate;
      const totals = invoiceTotalsFromLines(lines, vatRate);

      const { rows: seq } = await client.query("SELECT nextval('commission_invoice_number_seq') AS n");
      const number = commissionInvoiceNumber(seq[0].n, config.commission.invoicePrefix);

      const { rows: created } = await client.query(
        `INSERT INTO commission_invoices
           (contractor_id, invoice_number, period_start, period_end, issue_date, due_date,
            net_amount, vat_rate, vat_amount, total_amount, notes, region)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          d.contractor_id, number, from, to, issue,
          dueDateFor(issue, contractor.payment_terms_days),
          totals.net_amount, totals.vat_rate, totals.vat_amount, totals.total_amount,
          d.notes || null, d.region,
        ],
      );

      await client.query(
        'UPDATE contractor_invoices SET commission_invoice_id = $1 WHERE id = ANY($2::uuid[])',
        [created[0].id, lines.map((l) => l.id)],
      );

      await client.query('COMMIT');

      // Send it straight on to Greenco Invoicing so it can be emailed and
      // chased there. Best-effort by design: the commission is already claimed
      // and the lines are already linked, so a push failure is recorded on the
      // invoice for a retry — it must never undo a correct month-end raise.
      let pushed = null;
      let pushError = null;
      if (config.invoicing.enabled && config.invoicing.autoPush) {
        try {
          const ctx = await loadForPush(created[0].id);
          pushed = await pushInvoice(ctx);
          await recordPush(created[0].id, pushed, null);
        } catch (err) {
          pushError = err.message;
          console.error(`[commission] push of ${number} to invoicing failed:`, err.message);
          await recordPush(created[0].id, null, err.message).catch(() => {});
        }
      }

      res.status(201).json({
        id: created[0].id,
        invoice_number: number,
        region: d.region,
        region_label: REGION_LABEL[d.region],
        company_name: config.regions[d.region].company_name,
        lines: lines.length,
        pushed: pushed
          ? { number: pushed.external_number, url: pushed.external_url }
          : null,
        push_error: pushError,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);

// Email the invoice to the contractor and mark it sent.
router.post(
  '/:id/send',
  asyncHandler(async (req, res) => {
    const d = parse(
      z.object({
        to: z.string().max(320).optional().nullable(),
        message: z.string().max(2000).optional().nullable(),
      }),
      req.body || {},
    );

    const { rows } = await query(
      `SELECT ${COLS}, c.name AS contractor_name, c.email AS contractor_email
         FROM commission_invoices ci JOIN contractors c ON c.id = ci.contractor_id
        WHERE ci.id = $1`,
      [req.params.id],
    );
    const invoice = decorate(rows[0]);
    if (!invoice) throw new HttpError(404, 'Commission invoice not found');
    if (invoice.status === 'void') throw new HttpError(409, 'This invoice has been voided.');

    const to = (d.to || invoice.contractor_email || '').trim();
    if (!to) {
      throw new HttpError(400, 'No email address for this contractor — add one, or type one here.');
    }

    const { rows: lines } = await query(
      `SELECT invoice_number, invoice_date, property, description, total_amount,
              commission_amount, commission_vat_inclusive
         FROM contractor_invoices WHERE commission_invoice_id = $1 ORDER BY invoice_date, created_at`,
      [req.params.id],
    );

    const mail = buildCommissionInvoiceEmail({
      invoice: { ...invoice, notes: d.message || invoice.notes },
      contractor: { name: invoice.contractor_name },
      lines: lines.map((l) => ({
        ...withNumbers(l, LINE_MONEY_COLS),
        commission_amount: fromPence(commissionNetPence(l, invoice.vat_rate)),
      })),
      billing: billingBlock(invoice.region),
      invoicing: invoicingStatus(),
    });

    await sendMail({ to, subject: mail.subject, text: mail.text, html: mail.html });

    // Only a draft advances to 'sent' — re-sending a paid invoice as a chaser
    // must not walk its status backwards.
    const { rows: updated } = await query(
      `UPDATE commission_invoices
          SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
              sent_at = now(), sent_to = $2
        WHERE id = $1 RETURNING ${COLS.replaceAll('ci.', '')}`,
      [req.params.id, to],
    );
    res.json({ sent: true, to, invoice: decorate(updated[0]) });
  }),
);

// Gather everything the invoicing system needs about one commission invoice.
async function loadForPush(id, client = { query }) {
  const { rows } = await client.query(
    `SELECT ${COLS}, c.name AS contractor_name, c.email AS contractor_email,
            c.address AS contractor_address, c.phone AS contractor_phone
       FROM commission_invoices ci JOIN contractors c ON c.id = ci.contractor_id
      WHERE ci.id = $1`,
    [id],
  );
  const invoice = decorate(rows[0]);
  if (!invoice) throw new HttpError(404, 'Commission invoice not found');
  const { rows: lines } = await client.query(
    `SELECT invoice_number, invoice_date, property, description, commission_amount,
            commission_vat_inclusive
       FROM contractor_invoices WHERE commission_invoice_id = $1
      ORDER BY invoice_date, created_at`,
    [id],
  );
  return {
    invoice,
    contractor: {
      name: invoice.contractor_name,
      email: invoice.contractor_email,
      address: invoice.contractor_address,
      phone: invoice.contractor_phone,
    },
    lines,
  };
}

// Store the outcome of a push (success or failure) against the invoice, so the
// UI can always say where it stands rather than silently losing a failure.
async function recordPush(id, link, error) {
  const { rows } = await query(
    `UPDATE commission_invoices SET
       external_id = COALESCE($2, external_id),
       external_number = COALESCE($3, external_number),
       external_url = COALESCE($4, external_url),
       external_status = COALESCE($5, external_status),
       external_total = COALESCE($6, external_total),
       external_company_id = COALESCE($8, external_company_id),
       external_synced_at = CASE WHEN $2 IS NULL THEN external_synced_at ELSE now() END,
       external_error = $7
     WHERE id = $1 RETURNING ${COLS.replaceAll('ci.', '')}`,
    [
      id,
      link?.external_id ?? null,
      link?.external_number ?? null,
      link?.external_url ?? null,
      link?.external_status ?? null,
      link?.external_total ?? null,
      error ?? null,
      link?.external_company_id ?? null,
    ],
  );
  return decorate(rows[0]);
}

// Push (or re-push) this invoice to Greenco Invoicing, where it is emailed,
// tracked and chased. Safe to repeat: the reference is the idempotency key at
// the other end, so a retry after a timeout links to the invoice already there.
router.post(
  '/:id/push',
  asyncHandler(async (req, res) => {
    const ctx = await loadForPush(req.params.id);
    if (ctx.invoice.status === 'void') {
      throw new HttpError(409, 'This invoice has been voided — there is nothing to send.');
    }
    try {
      const link = await pushInvoice(ctx);
      const invoice = await recordPush(req.params.id, link, null);
      res.json({ pushed: true, created: link.created, invoice });
    } catch (err) {
      // Keep the reason on the record, then surface it — a push that failed
      // must not look like one that never happened.
      await recordPush(req.params.id, null, err.message).catch(() => {});
      throw err;
    }
  }),
);

// Read the invoice's state back from the invoicing system. Payment is recorded
// there (that's where the chasing happens), so this is how "paid" gets home.
router.post(
  '/:id/refresh',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      'SELECT id, external_id, status, paid_on, external_status FROM commission_invoices WHERE id = $1',
      [req.params.id],
    );
    const row = rows[0];
    if (!row) throw new HttpError(404, 'Commission invoice not found');
    if (!row.external_id) {
      throw new HttpError(409, 'This invoice hasn’t been sent to Greenco Invoicing yet.');
    }

    const state = await fetchInvoiceState(row.external_id);
    // Same mapping the webhook uses, so a refresh and a pushed update can never
    // leave the invoice in different states.
    const next = applyExternalState(row, state);
    const { rows: updated } = await query(
      `UPDATE commission_invoices SET
         external_status = $2,
         external_total = COALESCE($3, external_total),
         external_synced_at = now(),
         external_error = NULL,
         status = $4,
         paid_on = $5
       WHERE id = $1 RETURNING ${COLS.replaceAll('ci.', '')}`,
      [req.params.id, next.external_status, next.external_total, next.status, next.paid_on],
    );
    res.json({ invoice: decorate(updated[0]), external: state });
  }),
);

const statusInput = z.object({
  status: z.enum(['draft', 'sent', 'paid', 'void']),
  paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
});

router.post(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const d = parse(statusInput, req.body);

    // Voiding releases the lines back to pending, so the commission can be
    // re-invoiced rather than being stranded on a dead invoice.
    if (d.status === 'void') {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Voiding a PAID invoice would release lines the contractor has
        // already settled, and they'd be billed for the same commission twice.
        // Take it off 'paid' first — deliberately, not as a side effect.
        const { rows } = await client.query(
          `UPDATE commission_invoices SET status = 'void', paid_on = NULL
            WHERE id = $1 AND status <> 'paid' RETURNING id`,
          [req.params.id],
        );
        if (!rows[0]) {
          const { rows: exists } = await client.query(
            'SELECT status FROM commission_invoices WHERE id = $1',
            [req.params.id],
          );
          throw exists[0]
            ? new HttpError(
                409,
                'This invoice is marked paid. Mark it unpaid first if it really needs voiding.',
              )
            : new HttpError(404, 'Commission invoice not found');
        }
        const { rowCount } = await client.query(
          'UPDATE contractor_invoices SET commission_invoice_id = NULL WHERE commission_invoice_id = $1',
          [req.params.id],
        );
        await client.query('COMMIT');
        return res.json({ status: 'void', released: rowCount });
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const { rows } = await query(
      `UPDATE commission_invoices
          SET status = $2,
              paid_on = CASE WHEN $2 = 'paid' THEN COALESCE($3::date, CURRENT_DATE) ELSE NULL END
        WHERE id = $1 RETURNING ${COLS.replaceAll('ci.', '')}`,
      [req.params.id, d.status, d.paid_on || null],
    );
    if (!rows[0]) throw new HttpError(404, 'Commission invoice not found');
    return res.json(decorate(rows[0]));
  }),
);

// Delete an invoice outright (draft/void only) — the lines go back to pending.
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { rows } = await query(
      "DELETE FROM commission_invoices WHERE id = $1 AND status IN ('draft', 'void') RETURNING id",
      [req.params.id],
    );
    if (!rows[0]) {
      const { rows: exists } = await query('SELECT status FROM commission_invoices WHERE id = $1', [
        req.params.id,
      ]);
      throw exists[0]
        ? new HttpError(409, `A ${exists[0].status} invoice can’t be deleted — void it instead.`)
        : new HttpError(404, 'Commission invoice not found');
    }
    res.status(204).end();
  }),
);

export default router;
