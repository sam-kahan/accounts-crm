import { toPence, fromPence, percentOfPence, formatPence } from '../lib/money.js';
import { addDays, monthLabel } from '../lib/dates.js';

// ---------------------------------------------------------------------------
// Contractor commission: the rules that turn "an invoice arrived from Bob's
// Plumbing" into "we are owed £10", and a period's worth of those into the
// invoice we send Bob.
//
// The deal is held on the contractor and snapshotted onto each invoice, so
// renegotiating a rate never rewrites what was already billed. Everything here
// is pure — no DB, no network — so it is unit-tested directly.
// ---------------------------------------------------------------------------

export const COMMISSION_TYPES = ['percentage', 'fixed'];
export const COMMISSION_ON = ['net', 'gross'];
export const COMMISSION_BASES = ['inclusive', 'on_top'];
export const PAID_FROM = ['client', 'business'];
export const COMMISSION_INVOICE_STATUSES = ['draft', 'sent', 'paid', 'void'];

// Pull the commission deal off a contractor row, with safe fallbacks.
export function dealFor(contractor = {}) {
  const type = COMMISSION_TYPES.includes(contractor.commission_type)
    ? contractor.commission_type
    : 'percentage';
  const on = COMMISSION_ON.includes(contractor.commission_on) ? contractor.commission_on : 'net';
  const basis = COMMISSION_BASES.includes(contractor.commission_basis)
    ? contractor.commission_basis
    : 'inclusive';
  return {
    commission_type: type,
    commission_rate: Number(contractor.commission_rate ?? 0) || 0,
    commission_fixed: Number(contractor.commission_fixed ?? 0) || 0,
    commission_on: on,
    commission_basis: basis,
  };
}

// The commission on one invoice, in pence.
//
//   percentage → rate% of the net (or gross, if that's the deal)
//   fixed      → a flat amount per invoice
//
// An 'inclusive' commission is part of what we already paid the contractor, so
// it can never exceed the invoice itself — a mis-keyed 500% rate would
// otherwise produce a claim for more than the job was worth. An 'on_top'
// commission is charged in addition, so it isn't capped by the invoice.
export function commissionPence(deal, { netPence = 0, totalPence = 0 }) {
  const d = dealFor(deal);
  const base = d.commission_on === 'gross' ? totalPence : netPence;
  const raw =
    d.commission_type === 'fixed'
      ? Math.max(0, toPence(d.commission_fixed) ?? 0)
      : percentOfPence(Math.max(0, base), d.commission_rate);
  if (d.commission_basis === 'inclusive') {
    return Math.min(raw, Math.max(0, totalPence || base));
  }
  return raw;
}

// Commission for an invoice expressed in pounds, ready for the API/DB.
export function commissionFor(deal, { net_amount, vat_amount, total_amount }) {
  const netPence = toPence(net_amount) ?? 0;
  const vatPence = toPence(vat_amount) ?? 0;
  const totalPence = toPence(total_amount) ?? netPence + vatPence;
  return fromPence(commissionPence(deal, { netPence, totalPence }));
}

// Given whichever amounts the user (or the extractor) supplied, work out the
// missing one. Net + VAT is the pair we prefer; a lone total is treated as the
// net when no VAT is given, because that is how a non-VAT-registered
// contractor's invoice reads.
export function reconcileAmounts({ net_amount, vat_amount, total_amount }) {
  let net = toPence(net_amount);
  let vat = toPence(vat_amount);
  let total = toPence(total_amount);
  if (net === null && total !== null) net = total - (vat ?? 0);
  if (total === null && net !== null) total = net + (vat ?? 0);
  if (net === null && total === null) {
    net = 0;
    total = vat ?? 0;
  }
  if (vat === null) vat = Math.max(0, (total ?? 0) - (net ?? 0));
  return {
    net_amount: fromPence(Math.max(0, net)),
    vat_amount: fromPence(Math.max(0, vat)),
    total_amount: fromPence(Math.max(0, total)),
  };
}

// The VAT and gross of a commission invoice we raise (net = the commission
// total for the period).
export function invoiceTotals(netAmount, vatRate) {
  const netPence = toPence(netAmount) ?? 0;
  const vatPence = percentOfPence(netPence, vatRate);
  return {
    net_amount: fromPence(netPence),
    vat_rate: Number(vatRate || 0),
    vat_amount: fromPence(vatPence),
    total_amount: fromPence(netPence + vatPence),
  };
}

// The same totals, but with VAT worked out per line and then summed — which is
// how invoicing systems (ours included, once an invoice is pushed to Greenco
// Invoicing) add an invoice up. Rounding per line and rounding the sum can
// differ by a penny, and a penny between two systems showing the same invoice
// is a query nobody wants to answer, so both ends do it the same way.
export function invoiceTotalsFromLines(lines, vatRate) {
  let netPence = 0;
  let vatPence = 0;
  for (const line of lines) {
    const linePence = toPence(line.commission_amount) ?? 0;
    netPence += linePence;
    vatPence += percentOfPence(linePence, vatRate);
  }
  return {
    net_amount: fromPence(netPence),
    vat_rate: Number(vatRate || 0),
    vat_amount: fromPence(vatPence),
    total_amount: fromPence(netPence + vatPence),
  };
}

// Sum a set of logged invoices' commission, in pence.
export function sumCommissionPence(invoices) {
  return invoices.reduce((acc, i) => acc + (toPence(i.commission_amount) ?? 0), 0);
}

// Format a sequence value as an invoice number: 1 -> GC-COM-00001.
export function commissionInvoiceNumber(seq, prefix = 'GC-COM-') {
  return `${prefix}${String(Math.max(0, Math.trunc(Number(seq) || 0))).padStart(5, '0')}`;
}

// Where a logged invoice stands in the cycle. Derived rather than stored, so it
// can't drift out of step with the commission invoice it belongs to.
export function commissionStatus(row) {
  if (row.waived) return 'waived';
  if (!row.commission_invoice_id) return 'pending';
  if (row.commission_invoice_status === 'paid') return 'paid';
  return 'invoiced';
}

// A one-line description of the agreement, for the UI and the invoice email.
export function describeDeal(contractor) {
  const d = dealFor(contractor);
  const amount =
    d.commission_type === 'fixed'
      ? `${formatPence(toPence(d.commission_fixed) ?? 0)} per invoice`
      : `${d.commission_rate}% of the ${d.commission_on === 'gross' ? 'gross (inc VAT)' : 'net'}`;
  return d.commission_basis === 'inclusive'
    ? `${amount}, included in their invoice`
    : `${amount}, charged on top`;
}

export function dueDateFor(issueDate, termsDays) {
  const days = Number.isFinite(Number(termsDays)) ? Math.max(0, Number(termsDays)) : 30;
  return addDays(issueDate, days);
}

// --- the invoice we send ---------------------------------------------------

// Everything below renders text a contractor supplied (invoice numbers, work
// descriptions, property addresses) — some of it read off a PDF by the
// extractor. It goes into an HTML email, so it is escaped, never trusted.
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(`${String(iso).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// Build the commission invoice email (subject + text + HTML). `billing` is our
// own name/address/bank details from config; `lines` are the logged contractor
// invoices being claimed.
export function buildCommissionInvoiceEmail({ invoice, contractor, lines, billing = {} }) {
  const period = `${fmtDate(invoice.period_start)} – ${fmtDate(invoice.period_end)}`;
  const subject = `${billing.name || 'Greenco'} commission invoice ${invoice.invoice_number} — ${monthLabel(
    String(invoice.period_end).slice(0, 7),
  )}`;

  const textLines = lines.map(
    (l) =>
      `  ${fmtDate(l.invoice_date)}  ${l.invoice_number || '(no number)'}  ${
        l.property || l.description || 'Works'
      }  invoice ${formatPence(toPence(l.total_amount) ?? 0)}  commission ${formatPence(
        toPence(l.commission_amount) ?? 0,
      )}`,
  );

  const text = [
    `${billing.name || 'Greenco'} — commission invoice ${invoice.invoice_number}`,
    '',
    `To:      ${contractor.name}`,
    `Period:  ${period}`,
    `Issued:  ${fmtDate(invoice.issue_date)}`,
    `Due:     ${fmtDate(invoice.due_date)}`,
    '',
    `Commission included in your invoices below, now due back to ${billing.name || 'Greenco'}:`,
    '',
    ...textLines,
    '',
    `Commission total: ${formatPence(toPence(invoice.net_amount) ?? 0)}`,
    ...(Number(invoice.vat_rate) > 0
      ? [
          `VAT (${invoice.vat_rate}%):  ${formatPence(toPence(invoice.vat_amount) ?? 0)}`,
          `Total due:        ${formatPence(toPence(invoice.total_amount) ?? 0)}`,
        ]
      : []),
    '',
    ...(billing.bank_details ? ['Payment details:', billing.bank_details, ''] : []),
    ...(invoice.notes ? [invoice.notes, ''] : []),
    billing.name || 'Greenco',
    billing.address || '',
    billing.vat_number ? `VAT registration: ${billing.vat_number}` : '',
  ]
    .filter((l) => l !== '')
    .join('\n');

  const rows = lines
    .map(
      (l) => `
      <tr>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;white-space:nowrap;">${fmtDate(
          l.invoice_date,
        )}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(
          l.invoice_number || '—',
        )}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;">${escapeHtml(
          l.property || l.description || 'Works',
        )}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;">${formatPence(
          toPence(l.total_amount) ?? 0,
        )}</td>
        <td style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:right;white-space:nowrap;font-weight:600;">${formatPence(
          toPence(l.commission_amount) ?? 0,
        )}</td>
      </tr>`,
    )
    .join('');

  const vatRows =
    Number(invoice.vat_rate) > 0
      ? `<tr><td colspan="4" style="padding:6px 10px;text-align:right;">VAT (${escapeHtml(
          invoice.vat_rate,
        )}%)</td><td style="padding:6px 10px;text-align:right;">${formatPence(
          toPence(invoice.vat_amount) ?? 0,
        )}</td></tr>`
      : '';

  const html = `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#1e2235;max-width:720px;">
    <h2 style="color:#1e2235;margin:0 0 4px;">Commission invoice ${escapeHtml(
      invoice.invoice_number,
    )}</h2>
    <p style="color:#6b7280;margin:0 0 18px;">${escapeHtml(billing.name || 'Greenco')} · ${escapeHtml(
      period,
    )}</p>
    <table style="border-collapse:collapse;margin-bottom:18px;font-size:14px;">
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">To</td><td>${escapeHtml(
        contractor.name,
      )}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Issued</td><td>${fmtDate(
        invoice.issue_date,
      )}</td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#6b7280;">Payment due</td><td>${fmtDate(
        invoice.due_date,
      )}</td></tr>
    </table>
    <p style="font-size:14px;">The invoices below included commission for ${escapeHtml(
      billing.name || 'Greenco',
    )}. Please settle the total against this invoice.</p>
    <table style="border-collapse:collapse;width:100%;font-size:13px;">
      <thead>
        <tr>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #a2c533;">Invoice date</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #a2c533;">Your invoice</th>
          <th style="text-align:left;padding:6px 10px;border-bottom:2px solid #a2c533;">Property / works</th>
          <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #a2c533;">Invoice total</th>
          <th style="text-align:right;padding:6px 10px;border-bottom:2px solid #a2c533;">Commission</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
      <tfoot>
        <tr><td colspan="4" style="padding:8px 10px;text-align:right;font-weight:600;">Commission total</td>
            <td style="padding:8px 10px;text-align:right;font-weight:600;">${formatPence(
              toPence(invoice.net_amount) ?? 0,
            )}</td></tr>
        ${vatRows}
        <tr><td colspan="4" style="padding:8px 10px;text-align:right;font-weight:700;border-top:2px solid #1e2235;">Total due</td>
            <td style="padding:8px 10px;text-align:right;font-weight:700;border-top:2px solid #1e2235;">${formatPence(
              toPence(invoice.total_amount) ?? 0,
            )}</td></tr>
      </tfoot>
    </table>
    ${invoice.notes ? `<p style="font-size:13px;color:#6b7280;">${escapeHtml(invoice.notes)}</p>` : ''}
    ${
      billing.bank_details
        ? `<div style="margin-top:18px;padding:12px 14px;background:#f6f8ef;border:1px solid #dce8b8;border-radius:8px;font-size:13px;">
             <strong>Payment details</strong><br>${escapeHtml(billing.bank_details).replace(/\n/g, '<br>')}
           </div>`
        : ''
    }
    <p style="margin-top:20px;font-size:12px;color:#6b7280;">
      ${escapeHtml(billing.name || 'Greenco')}${billing.address ? ` · ${escapeHtml(billing.address)}` : ''}
      ${billing.vat_number ? `<br>VAT registration ${escapeHtml(billing.vat_number)}` : ''}
    </p>
  </div>`;

  return { subject, text, html };
}
