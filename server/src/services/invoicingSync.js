import { query } from '../db/pool.js';
import { config } from './../config.js';
import { pushInvoice, fetchInvoiceState } from './invoicesManager.js';
import { applyExternalState } from './commission.js';
import { withdrawExternally } from './commissionVoid.js';

// ---------------------------------------------------------------------------
// Keeping the two systems in step without anyone watching.
//
// Two things go wrong quietly:
//
//   1. A push fails at the moment an invoice is raised — the invoicing app is
//      restarting, the network hiccups, a company id is missing. The month end
//      itself is correct and the commission is claimed, so the raise is not
//      undone; the invoice simply never reaches the place that emails and
//      chases it, and it sits there looking raised.
//   2. A status webhook doesn't arrive. Most do, so an invoice emailed over
//      there flips to "sent" here within seconds — and the one that didn't
//      looks, forever, like a draft nobody sent.
//   3. A void doesn't reach the other side. The commission is correctly
//      released here, but the document the contractor holds is still being
//      chased over there — and the corrected month end will arrive as a second
//      invoice next to a first one that still stands.
//
// None of them is visible unless somebody happens to open the invoice, so all
// are re-tried on the nightly run: unsent invoices are pushed again (idempotent —
// our GC-COM number is the key at the other end, so a retry links to whatever
// is already there rather than billing the contractor twice), voided invoices
// are withdrawn again (idempotent for the same reason), and anything not yet
// paid or voided is read back. Everything here is best-effort and capped: it
// must never be the reason the nightly job fails.
// ---------------------------------------------------------------------------

const PUSH_LIMIT = 25;
const WITHDRAW_LIMIT = 25;
const REFRESH_LIMIT = 100;

async function loadForPush(id) {
  const { rows } = await query(
    `SELECT ci.*, c.name AS contractor_name FROM commission_invoices ci
       JOIN contractors c ON c.id = ci.contractor_id
      WHERE ci.id = $1`,
    [id],
  );
  const invoice = rows[0];
  if (!invoice) return null;
  const { rows: contractors } = await query('SELECT * FROM contractors WHERE id = $1', [
    invoice.contractor_id,
  ]);
  const { rows: lines } = await query(
    `SELECT id, invoice_number, invoice_date, property, description,
            net_amount, vat_amount, total_amount, commission_rate, commission_amount,
            commission_vat_inclusive
       FROM contractor_invoices
      WHERE commission_invoice_id = $1
      ORDER BY invoice_date, created_at`,
    [id],
  );
  return { invoice, contractor: contractors[0], lines };
}

// Push anything that was raised here but never landed over there.
async function pushStranded() {
  const { rows } = await query(
    `SELECT id, invoice_number FROM commission_invoices
      WHERE external_id IS NULL AND status <> 'void'
      ORDER BY issue_date DESC
      LIMIT $1`,
    [PUSH_LIMIT],
  );

  let sent = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const ctx = await loadForPush(row.id);
      if (!ctx) continue;
      // eslint-disable-next-line no-await-in-loop
      const link = await pushInvoice(ctx);
      // eslint-disable-next-line no-await-in-loop
      await query(
        `UPDATE commission_invoices SET
           external_id = $2, external_number = $3, external_url = $4,
           external_status = $5, external_total = $6, external_company_id = $7,
           external_synced_at = now(), external_error = NULL
         WHERE id = $1`,
        [
          row.id, link.external_id, link.external_number, link.external_url,
          link.external_status, link.external_total, link.external_company_id,
        ],
      );
      sent += 1;
    } catch (err) {
      failed += 1;
      // Keep the reason on the invoice — the page shows it, and a retry that
      // fails the same way every night is something to read, not to hide.
      // eslint-disable-next-line no-await-in-loop
      await query('UPDATE commission_invoices SET external_error = $2 WHERE id = $1', [
        row.id,
        err.message,
      ]).catch(() => {});
      console.error(`[invoicing] retrying push of ${row.invoice_number} failed:`, err.message);
    }
  }
  return { sent, failed, considered: rows.length };
}

// Read back anything that could still change over there: a draft that has since
// been emailed, or a sent invoice that has since been paid. Paid and void are
// final here, so they are left alone.
async function refreshOpen() {
  const { rows } = await query(
    `SELECT id, invoice_number, external_id, status, paid_on, external_status
       FROM commission_invoices
      WHERE external_id IS NOT NULL AND status IN ('draft', 'sent')
      ORDER BY issue_date DESC
      LIMIT $1`,
    [REFRESH_LIMIT],
  );

  let changed = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const state = await fetchInvoiceState(row.external_id);
      const next = applyExternalState(row, state);
      if (!next.changed) continue;
      // eslint-disable-next-line no-await-in-loop
      await query(
        `UPDATE commission_invoices SET
           status = $2, paid_on = $3, external_status = $4,
           external_total = COALESCE($5, external_total),
           external_synced_at = now(), external_error = NULL
         WHERE id = $1`,
        [row.id, next.status, next.paid_on, next.external_status, next.external_total],
      );
      changed += 1;
    } catch (err) {
      failed += 1;
      console.error(`[invoicing] refreshing ${row.invoice_number} failed:`, err.message);
    }
  }
  return { changed, failed, considered: rows.length };
}

// Withdraw anything voided here that is still standing over there.
//
// The void path tries this itself, so what reaches here is the attempt that
// failed — and the failure matters more than a failed push does: the contractor
// is being chased for an invoice we have withdrawn, and once the corrected
// month end goes out they are holding two. Invoices voided before any of this
// existed are swept up by the same query.
async function withdrawVoided() {
  const { rows } = await query(
    `SELECT id, invoice_number FROM commission_invoices
      WHERE status = 'void' AND external_id IS NOT NULL
        AND external_status IS DISTINCT FROM 'cancelled'
      ORDER BY issue_date DESC
      LIMIT $1`,
    [WITHDRAW_LIMIT],
  );

  let withdrawn = 0;
  let failed = 0;
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    const result = await withdrawExternally(row.id, 'Voided in the Accounts CRM');
    if (result.error) failed += 1;
    else if (result.cancelled) withdrawn += 1;
  }
  return { withdrawn, failed, considered: rows.length };
}

// Hand back any line still attached to a voided invoice.
//
// Every path that voids releases its own lines, so this normally finds nothing.
// It exists because the ones that don't own a transaction — the webhook and the
// Refresh button, where the void is decided over there — could be interrupted
// between writing the status and releasing, and a line stuck on a dead invoice
// is invisible: it isn't pending, so no month end will ever bill it again.
async function releaseOrphanedLines() {
  const { rowCount } = await query(
    `UPDATE contractor_invoices i SET commission_invoice_id = NULL
       FROM commission_invoices ci
      WHERE ci.id = i.commission_invoice_id AND ci.status = 'void'`,
  );
  if (rowCount > 0) {
    console.warn(`[invoicing] released ${rowCount} line(s) stranded on a voided invoice`);
  }
  return { released: rowCount };
}

// The whole reconcile. Returns what it did so the caller can log or show it.
export async function syncInvoicing() {
  // The orphan sweep is ours alone — no network, no configuration — so it runs
  // whether or not the bridge is switched on.
  const orphans = await releaseOrphanedLines();
  if (!config.invoicing.enabled) {
    return { skipped: 'Greenco Invoicing is not configured', orphans };
  }
  const pushes = await pushStranded();
  const withdrawals = await withdrawVoided();
  const refreshes = await refreshOpen();
  return { pushes, withdrawals, refreshes, orphans };
}
