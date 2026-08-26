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
export const COMMISSION_BASES = ['markup', 'inclusive', 'on_top'];
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
    : 'markup';
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
// The basis decides what the percentage is a percentage OF, which is the whole
// ball game:
//
//   markup    — the contractor's own price plus X%, already inside the invoice.
//               They want £90, add 10%, and invoice us £99 — £9 of it ours.
//               So the commission is net x rate / (100 + rate), NOT rate% of
//               the invoice, which would be £9.90 and over-claim every job.
//   inclusive — X% of the invoice total, already inside it (£99 -> £9.90).
//   on_top    — X%, charged in addition to what they invoiced.
//
// A commission that is already inside the invoice can never exceed the invoice
// itself: a mis-keyed 500% rate must not produce a claim for more than the job
// was worth. An 'on_top' commission is charged separately, so it isn't capped.
export function commissionPence(deal, { netPence = 0, totalPence = 0 }) {
  const d = dealFor(deal);
  const base = Math.max(0, d.commission_on === 'gross' ? totalPence : netPence);

  if (d.commission_type === 'fixed') {
    const fixed = Math.max(0, toPence(d.commission_fixed) ?? 0);
    return d.commission_basis === 'on_top'
      ? fixed
      : Math.min(fixed, Math.max(0, totalPence || base));
  }

  if (d.commission_basis === 'markup') {
    // Integer maths throughout: rate is scaled to thousandths so 12.375% is
    // exact, and the divisor is (100% + rate) in the same units.
    const rateMilli = Math.round(Number(d.commission_rate || 0) * 1000);
    if (!Number.isFinite(rateMilli) || rateMilli <= 0) return 0;
    return Math.round((base * rateMilli) / (100000 + rateMilli));
  }

  const raw = percentOfPence(base, d.commission_rate);
  return d.commission_basis === 'inclusive'
    ? Math.min(raw, Math.max(0, totalPence || base))
    : raw;
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

// The net commission on one line, in pence — what goes on the invoice we raise
// before VAT is added.
//
// For a VAT-registered contractor the amount they collected IS the net: their
// own invoice carried the VAT alongside it, so they collected £9 + £1.80 and we
// bill £9 + £1.80. For a contractor who isn't VAT registered there was no VAT
// on their invoice at all — they only ever collected the £9 — so that £9 is
// treated as the VAT-INCLUSIVE total and netted down to £7.50 + £1.50, and they
// pay back exactly what they took.
//
// The net is chosen so that `net + round(net x rate)` comes back to the amount
// collected, because Greenco Invoicing recomputes the VAT from the net we send
// it: agreeing with that system matters more than the arithmetic being
// text-book, since its copy is the one the contractor reads. About one penny
// value in six has no exact split (£0.10 at 5% is the smallest); those land a
// penny under rather than a penny over.
export function commissionNetPence(line, vatRate) {
  const collected = Math.max(0, toPence(line.commission_amount) ?? 0);
  const rate = Number(vatRate || 0);
  if (!line.commission_vat_inclusive || !rate || !collected) return collected;
  const start = Math.floor((collected * 100) / (100 + rate));
  for (const candidate of [start, start + 1, start - 1]) {
    if (candidate >= 0 && candidate + percentOfPence(candidate, rate) === collected) {
      return candidate;
    }
  }
  return start;
}

// The invoice totals, with VAT worked out per line and then summed — which is
// how invoicing systems (ours included, once an invoice is pushed to Greenco
// Invoicing) add an invoice up. Rounding per line and rounding the sum can
// differ by a penny, and a penny between two systems showing the same invoice
// is a query nobody wants to answer, so both ends do it the same way.
export function invoiceTotalsFromLines(lines, vatRate) {
  let netPence = 0;
  let vatPence = 0;
  for (const line of lines) {
    const lineNet = commissionNetPence(line, vatRate);
    netPence += lineNet;
    vatPence += percentOfPence(lineNet, vatRate);
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
  const of = d.commission_on === 'gross' ? 'gross (inc VAT)' : 'net';
  if (d.commission_type === 'fixed') {
    const amount = `${formatPence(toPence(d.commission_fixed) ?? 0)} per invoice`;
    return d.commission_basis === 'on_top'
      ? `${amount}, charged on top`
      : `${amount}, included in their invoice`;
  }
  if (d.commission_basis === 'markup') {
    return `their price + ${d.commission_rate}%, included in their invoice`;
  }
  return d.commission_basis === 'inclusive'
    ? `${d.commission_rate}% of the invoice ${of}, included in their invoice`
    : `${d.commission_rate}% of the ${of}, charged on top`;
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
  const period = `${fmtDate(invoice.period_start)} - ${fmtDate(invoice.period_end)}`;
  const subject = `${billing.name || 'Greenco'} commission invoice ${invoice.invoice_number} - ${monthLabel(
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
    `${billing.name || 'Greenco'} - commission invoice ${invoice.invoice_number}`,
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

// --- matching an invoice to a contractor ------------------------------------

// Company names on invoices never match the register exactly: "Bob's Plumbing
// Ltd" vs "Bobs Plumbing", "J & J Electrical" vs "J and J Electrical". Strip
// everything that varies — punctuation, "&"/"and", and the company suffixes —
// and compare what's left.
const NAME_NOISE = /\b(ltd|limited|llp|llc|plc|inc|co|company|the)\b/g;

export function normaliseName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(NAME_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// One name contains the other, and the shorter is distinctive enough to mean
// something: a bare "plumbing" must not auto-select Bob's Plumbing and apply
// their rate to someone else's invoice.
function containsName(a, b) {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.split(' ').length < 2) return false;
  return longer.includes(shorter);
}

// Match a name read off an invoice against the contractors on file. Returns the
// best candidate with a score: 1 is an exact match once normalised, and only
// 0.8 or better is confident enough to fill the form in without being asked.
export function matchContractorByName(name, contractors = []) {
  const target = normaliseName(name);
  if (!target) return null;
  const targetWords = new Set(target.split(' ').filter((w) => w.length > 2));

  let best = null;
  for (const contractor of contractors) {
    const candidate = normaliseName(contractor.name);
    if (!candidate) continue;

    let score = 0;
    if (candidate === target) {
      score = 1;
    } else if (containsName(candidate, target)) {
      // "Bobs Plumbing" inside "Bobs Plumbing and Heating".
      score = 0.85;
    } else if (targetWords.size) {
      // Otherwise judge on how much of the distinctive wording they share.
      const candidateWords = candidate.split(' ').filter((w) => w.length > 2);
      const shared = candidateWords.filter((w) => targetWords.has(w)).length;
      const ratio = shared / Math.max(targetWords.size, candidateWords.length || 1);
      if (ratio >= 0.5) score = 0.5 + ratio * 0.3;
    }

    if (score > 0 && (!best || score > best.score)) best = { contractor, score };
  }

  if (!best) return null;
  return { ...best, confident: best.score >= 0.8 };
}

// Everything needed to set up a contractor we haven't dealt with before, taken
// from the invoice they sent. Whether they are VAT registered is read off the
// document itself — a VAT number, or VAT actually charged, means they are. The
// commission rate is deliberately absent: an invoice can't tell us the
// agreement, so it has to be confirmed by a person.
export function contractorSuggestionFrom(extracted = {}, amounts = {}) {
  if (!extracted.contractor_name) return null;
  return {
    name: extracted.contractor_name,
    address: extracted.contractor_address || null,
    email: extracted.contractor_email || null,
    phone: extracted.contractor_phone || null,
    vat_registered: Boolean(
      extracted.contractor_vat_number || (toPence(amounts.vat_amount) ?? 0) > 0,
    ),
  };
}

// --- reacting to the invoicing system ---------------------------------------

// How a state read from Greenco Invoicing lands on our copy. Their 'overdue' is
// our 'sent': an unpaid invoice past its due date is still just sent as far as
// this side is concerned, and the chasing happens over there.
//
// Shared by the webhook and the manual Refresh so the two can never drift.
// A voided invoice here is never resurrected by anything arriving from there.
export function applyExternalState(current, state) {
  const externalStatus = String(state?.status || '').toLowerCase();
  const status =
    current?.status === 'void'
      ? 'void'
      : externalStatus === 'paid'
        ? 'paid'
        : externalStatus === 'draft'
          ? 'draft'
          : 'sent';

  // When the money actually arrived, falling back to when it was marked paid.
  // Their date wins over anything already here: payments are recorded on that
  // side, so a correction over there is the correction — keeping our older copy
  // would just leave a stale date nobody could explain. We only fall back to
  // what we hold when they send no date at all.
  const paidOn =
    status === 'paid'
      ? (state?.lastPaymentOn ? String(state.lastPaymentOn).slice(0, 10) : null) ||
        (state?.paidAt ? String(state.paidAt).slice(0, 10) : null) ||
        current?.paid_on ||
        null
      : null;

  return {
    status,
    paid_on: paidOn,
    external_status: externalStatus || null,
    external_total: state?.grandTotal ?? null,
    changed: current?.status !== status || (current?.external_status || null) !== (externalStatus || null),
  };
}

// Who the logged invoice belongs to, once the name has been read off it.
//
// Three things can be true at once and were previously conflated: a contractor
// may already be chosen (the form was opened from a filtered view, or the user
// picked one), the printed name may match somebody on file, and those two may
// disagree. Returning that as one shape stops the form reporting "no contractor
// matches" about an invoice whose contractor is sitting selected in front of it.
export function resolveContractor({ given = null, match = null }) {
  if (given) {
    const mismatch = Boolean(
      match?.confident && String(match.contractor.id) !== String(given.id),
    );
    return { contractor: given, selected_by: 'given', mismatch };
  }
  if (match?.confident) {
    return { contractor: match.contractor, selected_by: 'matched', mismatch: false };
  }
  return { contractor: null, selected_by: null, mismatch: false };
}

// ---------------------------------------------------------------------------
// "Have we had this invoice before?"
//
// The unique index on (contractor_id, lower(invoice_number)) is the guarantee —
// the same numbered invoice cannot be logged, and its commission claimed,
// twice. But it only fires on save, and only when a number was typed, so on its
// own it catches a duplicate at the worst moment (after the form is filled in
// and the document re-attached) and misses one entirely when the invoice has no
// number on it. This classifies a candidate against what is already on file so
// the form can say so first.
//
// Two tiers, and the difference matters:
//   - `exact`   — the same number, compared exactly as the index compares it.
//                 Saving is going to be refused; say so before anyone tries.
//   - `similar` — worth a look, but might be legitimate: the same number give or
//                 take punctuation, or the same day and the same money with a
//                 number missing from one side. Never blocks.
// Pure: the caller does the querying, this decides what the rows mean.

// The index compares lower(invoice_number) and nothing else, so exact matching
// must too — promising a save that the index then refuses would be worse than
// no warning at all.
function indexKey(number) {
  const s = String(number ?? '');
  return s ? s.toLowerCase() : '';
}

// "INV-1042", "inv 1042" and "INV1042" are one invoice to everybody except the
// index. Not exact, so it warns rather than blocks.
function looseKey(number) {
  return indexKey(number).replace(/[^a-z0-9]/g, '');
}

function sameMoney(a, b) {
  const x = toPence(a);
  const y = toPence(b);
  return x !== null && x !== undefined && y !== null && y !== undefined && x === y;
}

export function findDuplicates(candidate = {}, rows = []) {
  const exclude = candidate.exclude_id ? String(candidate.exclude_id) : null;
  const key = indexKey(candidate.invoice_number);
  const loose = looseKey(candidate.invoice_number);
  const date = candidate.invoice_date || null;
  const total = candidate.total_amount;

  let exact = null;
  const similar = [];

  for (const row of rows) {
    if (exclude && String(row.id) === exclude) continue;
    const rowKey = indexKey(row.invoice_number);
    const rowLoose = looseKey(row.invoice_number);

    if (key && rowKey && key === rowKey) {
      exact = exact || row;
      continue;
    }
    if (loose && rowLoose && loose === rowLoose) {
      similar.push({ invoice: row, reason: 'number' });
      continue;
    }
    // Only when one side has no number to compare: two invoices that both
    // carry a number and don't match are two invoices, however alike the
    // money looks — a contractor can bill the same day for the same price
    // twice, and nagging about it would train everyone to click past this.
    if ((!key || !rowKey) && date && row.invoice_date === date && sameMoney(total, row.total_amount)) {
      similar.push({ invoice: row, reason: 'details' });
    }
  }

  return { exact, similar };
}
