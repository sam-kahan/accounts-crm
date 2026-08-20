import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query } from '../db/pool.js';
import { config } from '../config.js';
import { asyncHandler, HttpError, parse } from '../lib/http.js';
import { applyExternalState } from '../services/commission.js';

// ---------------------------------------------------------------------------
// Greenco Invoicing tells us when a commission invoice changes over there —
// emailed, paid, gone overdue. Without this the status only caught up when
// somebody remembered to press Refresh, so an invoice paid last week still
// looked outstanding here.
//
// Authenticated with the same shared secret as the outbound push (there:
// INTEGRATION_SECRET, here: INVOICING_API_KEY), compared in constant time. It
// is deliberately outside `requireAuth` — the caller is a server, not a person
// — and mounted on its own path so nothing else loses its session check.
// ---------------------------------------------------------------------------

const router = Router();

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function authorised(req) {
  const key = config.invoicing.apiKey;
  if (!key) return false;
  const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return Boolean(token) && safeEqual(token, key);
}

const input = z.object({
  event: z.string().max(64).optional(),
  // Our own GC-COM number, which went across as their header reference.
  reference: z.string().max(64).optional().nullable(),
  invoiceId: z.union([z.number(), z.string()]).optional().nullable(),
  invoiceNumber: z.string().max(64).optional().nullable(),
  status: z.string().max(32),
  grandTotal: z.number().optional().nullable(),
  paidAt: z.string().max(40).optional().nullable(),
  lastPaymentOn: z.string().max(40).optional().nullable(),
  url: z.string().max(500).optional().nullable(),
});

router.post(
  '/',
  asyncHandler(async (req, res) => {
    if (!authorised(req)) throw new HttpError(401, 'Unauthorised');
    const d = parse(input, req.body || {});

    // Match on their id first, then on our reference — a push that timed out
    // before we stored the id still leaves the reference to find it by.
    const { rows } = await query(
      `SELECT id, status, paid_on, external_status, external_id
         FROM commission_invoices
        WHERE ($1::text IS NOT NULL AND external_id = $1::text)
           OR ($2::text IS NOT NULL AND invoice_number = $2::text)
        LIMIT 1`,
      [d.invoiceId != null ? String(d.invoiceId) : null, d.reference || null],
    );
    const current = rows[0];
    if (!current) {
      // Not ours: every invoice raised by hand over there also changes status,
      // and that is not an error worth alarming anyone about.
      return res.status(404).json({ ok: false, reason: 'No matching commission invoice' });
    }

    const next = applyExternalState(current, d);
    const { rows: updated } = await query(
      `UPDATE commission_invoices SET
         status = $2,
         paid_on = $3,
         external_status = $4,
         external_total = COALESCE($5, external_total),
         external_id = COALESCE(external_id, $6),
         external_number = COALESCE($7, external_number),
         external_url = COALESCE($8, external_url),
         external_synced_at = now(),
         external_error = NULL
       WHERE id = $1
       RETURNING invoice_number, status, paid_on, external_status`,
      [
        current.id,
        next.status,
        next.paid_on,
        next.external_status,
        next.external_total,
        d.invoiceId != null ? String(d.invoiceId) : null,
        d.invoiceNumber || null,
        d.url || null,
      ],
    );

    res.json({ ok: true, changed: next.changed, invoice: updated[0] });
  }),
);

export default router;
