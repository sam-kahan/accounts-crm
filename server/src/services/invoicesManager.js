import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { toPence, fromPence } from '../lib/money.js';
import { commissionNetPence } from './commission.js';
import { REGIONS, REGION_LABEL, isRegion } from './regions.js';

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
// WHICH company it is raised from is the invoice's region: Manchester work goes
// to Greenco Group Limited, Liverpool work to Greenco Liverpool Limited, each
// its own company over there. The region was settled when the contractor's
// invoice was logged (services/regions.js); nothing is decided here.
//
// Everything is gated on INVOICING_API_URL / INVOICING_API_KEY and at least one
// office's company id: with those unset the commission module works exactly as
// before, just without the push.
// ---------------------------------------------------------------------------

// The invoicing app only accepts the VAT rates its own invoice form offers.
// Catching this here gives a sentence the user can act on instead of a 400
// relayed from another system.
const ALLOWED_VAT_RATES = [0, 5, 20];

// Which company over there raises this region's invoices. A region nobody has
// linked yet is a configuration gap, not a bad invoice — say which setting is
// missing rather than letting the push fail as an opaque rejection.
export function companyIdFor(region) {
  const key = isRegion(region) ? region : 'manchester';
  const id = config.invoicing.companies[key] || 0;
  if (!id) {
    throw new HttpError(
      503,
      `${config.regions[key].company_name} isn’t linked to a company in Greenco Invoicing yet — set INVOICING_COMPANY_ID_${key.toUpperCase()} in the server environment.`,
    );
  }
  return id;
}

export function invoicingStatus() {
  return {
    enabled: config.invoicing.enabled,
    url: config.invoicing.baseUrl,
    auto_push: config.invoicing.autoPush,
    push_as_sent: config.invoicing.pushAsSent,
    // One entry per office, so the UI can say "Liverpool isn't linked yet"
    // before somebody raises an invoice that can't be sent.
    companies: REGIONS.map((r) => ({
      region: r.key,
      label: REGION_LABEL[r.key],
      company_name: config.regions[r.key].company_name,
      company_id: config.invoicing.companies[r.key] || null,
      linked: Boolean(config.invoicing.companies[r.key]),
    })),
  };
}

// One line per contractor invoice the commission came from, so the contractor
// can see exactly which jobs are being claimed — that is the whole argument for
// the invoice, and it's what stops the "what is this for?" email.
export function lineFor(row, vatRate = 0) {
  const parts = [];
  if (row.invoice_number) parts.push(row.invoice_number);
  if (row.property) parts.push(row.property);
  const head = parts.length ? parts.join(', ') : 'works';
  const works = row.description ? ` (${row.description})` : '';
  return {
    description: `Commission - ${head}${works}`.slice(0, 500),
    quantity: 1,
    // The NET commission: the invoicing system adds VAT to the unit price it
    // is given. For a contractor who isn't VAT registered that is the amount
    // they collected netted down, so the gross there comes back to what they
    // actually took from us.
    unitPrice: fromPence(commissionNetPence(row, vatRate)),
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
    lines: billable.map((l) => ({ ...lineFor(l, vatRate), vatRate })),
  };
}

function requireEnabled() {
  if (!config.invoicing.enabled) {
    throw new HttpError(
      503,
      'Greenco Invoicing isn’t configured. Set INVOICING_API_URL, INVOICING_API_KEY and at least one of INVOICING_COMPANY_ID_MANCHESTER / INVOICING_COMPANY_ID_LIVERPOOL in the server environment.',
    );
  }
}

async function call(path, { method = 'GET', body, rejected = 'rejected the invoice' } = {}) {
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
      `Greenco Invoicing ${rejected}: ${detail}`,
    );
  }
  return data;
}

// Push a commission invoice across. Returns the linkage to store against it.
export async function pushInvoice({ invoice, contractor, lines }) {
  // The region decides the company, and it is checked before the request goes
  // out: a Liverpool invoice must never land in Manchester's books because a
  // setting was missing.
  const companyId = companyIdFor(invoice.region);
  const payload = buildInvoicePayload({
    invoice,
    contractor,
    lines,
    companyId,
    asSent: config.invoicing.pushAsSent,
  });
  const data = await call('/api/external/invoices', { method: 'POST', body: payload });
  return {
    external_company_id: companyId,
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

// Withdraw an invoice over there, because it has been voided here.
//
// Cancelling is not deleting: the contractor already has the emailed PDF, so
// the invoice stays on their system marked cancelled, with the reason on it.
// That is what stops it being chased, and what stops the corrected month end
// arriving as a second invoice against a first one still standing.
//
// Safe to repeat — a second call reports the invoice as already cancelled
// rather than failing — so the nightly reconcile can retry it freely. An
// invoice with money recorded against it is refused at the far end (a payment
// would drop out of their books), and that refusal comes back as its message.
export async function cancelInvoice(externalId, reason) {
  const data = await call(`/api/external/invoices/${encodeURIComponent(externalId)}/cancel`, {
    method: 'POST',
    body: { reason: reason ? String(reason).slice(0, 500) : '' },
    rejected: 'wouldn’t cancel the invoice',
  });
  return {
    // False when it was already cancelled — the outcome is the same, but the
    // caller can tell "we withdrew it" from "it was already withdrawn".
    cancelled: data.cancelled !== false,
    external_status: data.invoice?.status || 'cancelled',
    external_number: data.invoice?.invoiceNumber || null,
    external_url: data.invoice?.url || null,
  };
}
