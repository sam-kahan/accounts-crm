import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { toPence } from '../lib/money.js';

// ---------------------------------------------------------------------------
// Bridge to Greenco Invoicing (invoices.greenco.co.uk).
//
// A commission invoice raised here is pushed over there so it lands in the
// normal invoicing flow: PDF, email to the contractor, statements, the nightly
// overdue sweep and the chase screens. That system assigns the number the
// contractor sees — it stays the source of truth for invoice numbering — and
// our GC-COM-xxxxx goes across as its header reference, so a payment queried at
// either end reconciles to the same document.
//
// Everything is gated on INVOICING_API_URL / INVOICING_API_KEY /
// INVOICING_COMPANY_ID: with any of them unset the commission module works
// exactly as before, just without the push.
// ---------------------------------------------------------------------------

// The invoicing app only accepts the VAT rates its own invoice form offers.
// Catching this here gives a sentence the user can act on instead of a 400
// relayed from another system.
const ALLOWED_VAT_RATES = [0, 5, 20];

export function invoicingStatus() {
  return {
    enabled: config.invoicing.enabled,
    url: config.invoicing.baseUrl,
    company_id: config.invoicing.companyId,
    auto_push: config.invoicing.autoPush,
    push_as_sent: config.invoicing.pushAsSent,
  };
}

// One line per contractor invoice the commission came from, so the contractor
// can see exactly which jobs are being claimed — that is the whole argument for
// the invoice, and it's what stops the "what is this for?" email.
export function lineFor(row) {
  const parts = [];
  if (row.invoice_number) parts.push(row.invoice_number);
  if (row.property) parts.push(row.property);
  const head = parts.length ? parts.join(', ') : 'works';
  const works = row.description ? ` (${row.description})` : '';
  return {
    description: `Commission — ${head}${works}`.slice(0, 500),
    quantity: 1,
    unitPrice: Number(row.commission_amount || 0),
    vatRate: 0,
  };
}

// Build the payload the invoicing API expects. Pure — unit-tested directly.
export function buildInvoicePayload({ invoice, contractor, lines, companyId, asSent }) {
  const vatRate = Number(invoice.vat_rate || 0);
  if (!ALLOWED_VAT_RATES.includes(vatRate)) {
    throw new HttpError(
      400,
      `Greenco Invoicing only accepts VAT at ${ALLOWED_VAT_RATES.join('%, ')}% — this invoice is at ${vatRate}%. Change the contractor's commission VAT rate and re-raise it.`,
    );
  }

  const billable = lines.filter((l) => (toPence(l.commission_amount) ?? 0) > 0);
  if (billable.length === 0) {
    throw new HttpError(400, 'This invoice has no billable lines to send.');
  }

  return {
    companyId,
    // Doubles as the idempotency key over there: a retried push finds the
    // invoice it already created instead of raising a second one.
    reference: invoice.invoice_number,
    client: {
      name: contractor.name,
      email: contractor.email || '',
      address: contractor.address || '',
      phone: contractor.phone || '',
    },
    invoiceDate: invoice.issue_date,
    dueDate: invoice.due_date,
    status: asSent ? 'sent' : 'draft',
    notes:
      invoice.notes ||
      `Commission included in your invoices between ${invoice.period_start} and ${invoice.period_end}.`,
    lines: billable.map((l) => ({ ...lineFor(l), vatRate })),
  };
}

function requireEnabled() {
  if (!config.invoicing.enabled) {
    throw new HttpError(
      503,
      'Greenco Invoicing isn’t configured. Set INVOICING_API_URL, INVOICING_API_KEY and INVOICING_COMPANY_ID in the server environment.',
    );
  }
}

async function call(path, { method = 'GET', body } = {}) {
  requireEnabled();
  let res;
  try {
    res = await fetch(`${config.invoicing.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${config.invoicing.apiKey}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      // Without a deadline a hung invoicing box would hold this request open
      // and, on the auto-push path, the whole month-end raise with it.
      signal: AbortSignal.timeout(config.invoicing.timeoutMs),
    });
  } catch (err) {
    throw new HttpError(
      502,
      err.name === 'TimeoutError' || err.name === 'AbortError'
        ? 'Greenco Invoicing didn’t respond in time.'
        : `Couldn’t reach Greenco Invoicing: ${err.message}`,
    );
  }

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const detail = data?.error || `HTTP ${res.status}`;
    throw new HttpError(
      res.status === 401 ? 502 : res.status,
      `Greenco Invoicing rejected the invoice: ${detail}`,
    );
  }
  return data;
}

// Push a commission invoice across. Returns the linkage to store against it.
export async function pushInvoice({ invoice, contractor, lines }) {
  const payload = buildInvoicePayload({
    invoice,
    contractor,
    lines,
    companyId: config.invoicing.companyId,
    asSent: config.invoicing.pushAsSent,
  });
  const data = await call('/api/external/invoices', { method: 'POST', body: payload });
  return {
    external_id: String(data.invoice.id),
    external_number: data.invoice.invoiceNumber,
    external_url: data.invoice.url,
    external_status: data.invoice.status,
    external_total: data.invoice.grandTotal,
    created: data.created !== false,
  };
}

// Read an invoice's current state back — whether the contractor has paid is
// recorded over there, where the chasing happens.
export async function fetchInvoiceState(externalId) {
  const data = await call(`/api/external/invoices/${encodeURIComponent(externalId)}`);
  return data.invoice;
}
