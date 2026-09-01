import { query } from '../db/pool.js';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { cancelInvoice } from './invoicesManager.js';

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

// Hand every line on this invoice back to "to invoice", so its commission can
// be re-billed. Takes a client so the void path can do it in its transaction.
export async function releaseLinesOf(id, client = { query }) {
  const { rowCount } = await client.query(
    'UPDATE contractor_invoices SET commission_invoice_id = NULL WHERE commission_invoice_id = $1',
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
    `SELECT id, invoice_number, status, external_id, external_status
       FROM commission_invoices WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) throw new HttpError(404, 'Commission invoice not found');

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
