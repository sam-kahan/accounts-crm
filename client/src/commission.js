// The commission arithmetic as the forms show it, live, while the amounts are
// being typed. The server recomputes every figure from the contractor's
// agreement when it saves — this is only ever a preview, and the two must agree
// or the callout on screen would argue with the row that gets written.
//
// It lives here rather than in a page because two screens need it: logging one
// invoice, and checking a whole batch of them before submitting.
import { formatMoney } from './api';

// A preview of what the server will charge, shown live as the amounts are
// typed. The server recomputes from the contractor's agreement when it saves —
// this figure is only sent if the user deliberately overrides it.
export function previewCommission(contractor, { net, vat, total, commissionable }) {
  if (!contractor) return 0;
  const netN = Number(net || 0);
  const vatN = Number(vat || 0);
  const totalN = Number(total || 0) || netN + vatN;
  const whole = Math.max(0, contractor.commission_on === 'gross' ? totalN : netN);
  // The part of the invoice carrying commission, when it isn't all of it.
  const part =
    commissionable === '' || commissionable === null || commissionable === undefined
      ? null
      : Math.max(0, Math.min(Number(commissionable) || 0, whole));
  const base = part === null ? whole : part;
  const pot = part === null ? Math.max(0, totalN || whole) : part;
  const rate = Number(contractor.commission_rate || 0);
  const basis = contractor.commission_basis || 'markup';

  if (contractor.commission_type === 'fixed') {
    const fixed = Number(contractor.commission_fixed || 0);
    return basis === 'on_top' ? fixed : Math.min(fixed, pot || fixed);
  }
  // markup: the rate was added to the contractor's own price, so the
  // commission inside the invoice is net x rate / (100 + rate) — £9 on a £99
  // invoice at 10%, not £9.90.
  if (basis === 'markup') {
    return rate > 0 ? Math.round((base * rate * 100) / (100 + rate)) / 100 : 0;
  }
  const raw = Math.round(base * rate) / 100;
  return basis === 'inclusive' ? Math.min(raw, pot || raw) : raw;
}

// What the commissionable part is measured against: the net or the gross,
// whichever the contractor's deal takes the rate on. Matches
// commissionableCeiling() on the server.
export function ceilingFor(contractor, { net, vat, total }) {
  const netN = Number(net || 0);
  const totalN = Number(total || 0) || netN + Number(vat || 0);
  return contractor?.commission_on === 'gross' ? totalN : netN;
}

// One line saying what the rate was applied to, for the commission callout —
// so the figure can be read back and understood without opening the invoice.
export function describePart(value, note, owner, amounts) {
  if (value === '' || value === null || value === undefined) return '';
  const ceiling = ceilingFor(owner, amounts);
  const measure = owner?.commission_on === 'gross' ? 'total' : 'net';
  return ` · on ${formatMoney(Number(value) || 0)} of the ${formatMoney(ceiling)} ${measure}${
    note ? ` (${note})` : ''
  }`;
}
