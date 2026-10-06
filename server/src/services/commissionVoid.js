import { query } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { cancelInvoice, findInvoiceByReference, fetchInvoiceState } from './invoicesManager.js';

// ---------------------------------------------------------------------------
// Reversing a month end.
//
// Voiding a commission invoice has always done the right thing HERE: the lines
// go back to "to invoice", so the commission can be re-billed once whatever was
// wrong with it has been fixed (a line waived, an amount amended). What it
// never did was reach the other side. The invoice had already been numbered,
// PDF'd and emailed by Greenco Invoicing, and it carried on being chased there
// — so the contractor was left holding an invoice we had withdrawn, and got a
// second one the moment the corrected month end was raised.
//
// So a void is two things now: release the lines, and withdraw the document.
// The second is best-effort by the same reasoning the push already follows —
// the reversal here is correct whatever the network does, and a withdrawal that
// didn't land is recorded for a retry (a button on the invoice, and the nightly
// reconcile) rather than blocking the void or being lost.
//
// The far end refuses to cancel an invoice with payments recorded against it,
// which is right: money that has actually arrived cannot be made to vanish out
// of their books because of a correction over here. That refusal comes back as
// a sentence to act on.
// ---------------------------------------------------------------------------

// Whether money is recorded against the invoice in Greenco Invoicing, asked
// BEFORE a void releases its lines. Payments are recorded there, and a
// webhook that was lost or late leaves ours at "sent": voiding then released
// commission the contractor had settled, the cancel over there was refused,
// and the next month end billed it again. Returns a sentence refusing the
// void, or null. A system that can't be reached is a refusal too: the
// question matters more than the wait.
const PAID_STATUSES = new Set(['paid', 'partially_paid', 'part_paid', 'partial', 'partpaid']);
export function paymentRecorded(state) {
  if (!state) return false;
  const status = String(state.status || '').toLowerCase().replace(/[\s-]+/g, '_');
  const amount = Number(state.amountPaid ?? state.paidAmount ?? state.totalPaid ?? 0);
  return PAID_STATUSES.has(status) || Boolean(state.lastPaymentOn) || Boolean(state.paidAt) || amount > 0;
}
export async function voidRefusal(row) {
  if (!config.invoicing.enabled) return null;
  if (!row.external_id && !row.external_error) return null; // never reached it
  let state;
  try {
    if (row.external_id) {
      state = await fetchInvoiceState(row.external_id);
    } else {
      // A push that failed may have landed: look it up by our reference.
      const found = await findInvoiceByReference(row.invoice_number, row.region);
      if (!found) return null;
      state = await fetchInvoiceState(found.external_id);
    }
  } catch (err) {
    return `Couldn’t check with Greenco Invoicing whether it has been paid (${err.message}). Try again shortly.`;
  }
  if (paymentRecorded(state)) {
    return 'A payment is recorded against this invoice in Greenco Invoicing, so it can’t be voided (the contractor would be billed again for commission they have paid). Refresh it to bring the payment across.';
  }
  return null;
}

// Hand every line on this invoice back to "to invoice", so its commission can
// be re-billed. Takes a client so the void path can do it in its transaction.
// A released line takes the contractor's CURRENT "exempt from VAT" setting:
// voiding is how an invoice raised with the wrong VAT is corrected, so the
// re-raise must not repeat it.
export async function releaseLinesOf(id, client = { query }) {
  const { rowCount } = await client.query(
    `UPDATE contractor_invoices i
        SET commission_invoice_id = NULL, commission_vat_exempt = c.commission_vat_exempt
       FROM contractors c
      WHERE c.id = i.contractor_id AND i.commission_invoice_id = $1`,
    [id],
  );
  return rowCount;
}

// Withdraw the invoice in Greenco Invoicing and record what happened.
//
// Returns rather than throws, so the void path can carry on regardless; the
// caller decides whether an `error` is worth surfacing. `skipped` covers the
// cases where there is genuinely nothing to withdraw — an invoice that never
// reached the other side has nothing standing against it.
export async function withdrawExternally(id, reason) {
  const { rows } = await query(
    `SELECT id, invoice_number, status, region, external_id, external_status, external_error
       FROM commission_invoices WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Commission invoice not found');

  // A push that failed may still have landed (it timed out after they had
  // created it), so an invoice with a push error is looked up by our
  // reference before it is taken as never having got there.
  if (!row.external_id && row.external_error && config.invoicing.enabled) {
    try {
      const found = await findInvoiceByReference(row.invoice_number, row.region);
      if (!found) {
        await query('UPDATE commission_invoices SET external_error = NULL WHERE id = $1', [id]);
        return { skipped: 'It never reached Greenco Invoicing.' };
      }
      await query(
        `UPDATE commission_invoices SET
           external_id = $2, external_number = $3, external_url = $4,
           external_status = $5, external_total = $6, external_company_id = $7,
           external_synced_at = now()
         WHERE id = $1`,
        [id, found.external_id, found.external_number, found.external_url,
          found.external_status, found.external_total, found.external_company_id],
      );
      row.external_id = found.external_id;
      row.external_status = found.external_status;
    } catch (err) {
      await query('UPDATE commission_invoices SET external_error = $2 WHERE id = $1', [
        id,
        `Couldn’t check whether it reached Greenco Invoicing: ${err.message}`,
      ]).catch(() => {});
      return { error: err.message };
    }
  }
  if (!row.external_id) return { skipped: 'It never reached Greenco Invoicing.' };
  if (row.external_status === 'cancelled') {
    return { skipped: 'It is already cancelled in Greenco Invoicing.', cancelled: false };
  }
  if (!config.invoicing.enabled) {
    return { skipped: 'Greenco Invoicing isn’t configured.' };
  }

  try {
    const result = await cancelInvoice(row.external_id, reason);
    await query(
      `UPDATE commission_invoices
          SET external_status = $2, external_synced_at = now(), external_error = NULL
        WHERE id = $1`,
      [id, result.external_status],
    );
    return { cancelled: result.cancelled, external_status: result.external_status };
  } catch (err) {
    // Keep the reason on the invoice: a withdrawal that failed must not look
    // like one that was never needed. The page shows it with a retry.
    await query('UPDATE commission_invoices SET external_error = $2 WHERE id = $1', [
      id,
      err.message,
    ]).catch(() => {});
    console.error(`[invoicing] cancelling ${row.invoice_number} over there failed:`, err.message);
    return { error: err.message };
  }
}
