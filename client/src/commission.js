// The commission arithmetic as the forms show it, live, while the amounts are
// being typed. The server recomputes every figure from the contractor's
// agreement when it saves — this is only ever a preview, and the two must agree
// or the callout on screen would argue with the row that gets written.
//
// It lives here rather than in a page because two screens need it: logging one
// invoice, and checking a whole batch of them before submitting.
import { formatMoney } from './api';

// Money as whole pence, read exactly as the server reads it
// (server/src/lib/money.js#toPence): from the digits, never via a float, so
// "1.005" is 101p on both sides.
export function toPence(value) {
  if (value === null || value === undefined || value === '') return null;
  let s = typeof value === 'number' ? String(value) : String(value).trim();
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    s = n.toFixed(6);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.replace(/[£,\s]/g, ''));
  if (!m || (!m[2] && !m[3])) return null;
  const frac = m[3] || '';
  let pence = Number(m[2] || '0') * 100 + Number(`${frac}00`.slice(0, 2));
  if (Number(frac[2]) >= 5) pence += 1;
  return m[1] === '-' ? -pence : pence;
}

// A percentage of pence, the rate in integer thousandths
// (server/src/lib/money.js#percentOfPence).
function percentOfPence(pence, ratePercent) {
  const rateMilli = Math.round(Number(ratePercent || 0) * 1000);
  if (!Number.isFinite(rateMilli) || !rateMilli) return 0;
  const result = (pence * rateMilli) / 100000;
  return Math.round(Math.abs(result)) * (result < 0 ? -1 : 1);
}

// A preview of what the server will charge, shown live as the amounts are
// typed. The server recomputes from the contractor's agreement when it saves —
// this figure is only sent if the user deliberately overrides it. It is the
// server's commissionPence() line for line, in whole pence, so the two agree
// to the penny.
// The amounts as the server settles them before costing anything
// (server/src/services/commission.js#reconcileAmounts): a blank net is the
// total less the VAT, a blank total is the net plus the VAT.
function reconcile({ net, vat, total }) {
  let netP = toPence(net);
  const vatP = toPence(vat);
  let totalP = toPence(total);
  if (netP === null && totalP !== null) netP = totalP - (vatP ?? 0);
  if (totalP === null && netP !== null) totalP = netP + (vatP ?? 0);
  if (netP === null && totalP === null) {
    netP = 0;
    totalP = vatP ?? 0;
  }
  return { netP: Math.max(0, netP), totalP: Math.max(0, totalP) };
}

export function previewCommission(contractor, { net, vat, total, commissionable }) {
  if (!contractor) return 0;
  const { netP, totalP } = reconcile({ net, vat, total });
  const whole = Math.max(0, contractor.commission_on === 'gross' ? totalP : netP);
  // The part of the invoice carrying commission, when it isn't all of it.
  const partP = toPence(commissionable);
  const part = partP === null ? null : Math.max(0, Math.min(partP, whole));
  const base = part === null ? whole : part;
  const pot = part === null ? Math.max(0, totalP || whole) : part;
  const basis = contractor.commission_basis || 'markup';
  let pence;
  if (contractor.commission_type === 'fixed') {
    const fixed = Math.max(0, toPence(contractor.commission_fixed) ?? 0);
    pence = basis === 'on_top' ? fixed : Math.min(fixed, pot);
  } else if (basis === 'markup') {
    // The rate was added to the contractor's own price, so the commission
    // inside the invoice is net x rate / (100 + rate) — £9 on a £99 invoice
    // at 10%, not £9.90.
    const rateMilli = Math.round(Number(contractor.commission_rate || 0) * 1000);
    pence = Number.isFinite(rateMilli) && rateMilli > 0 ? Math.round((base * rateMilli) / (100000 + rateMilli)) : 0;
  } else {
    const raw = percentOfPence(base, contractor.commission_rate);
    pence = basis === 'inclusive' ? Math.min(raw, pot) : raw;
  }
  return pence / 100;
}

// What the commissionable part is measured against: the net or the gross,
// whichever the contractor's deal takes the rate on. Matches
// commissionableCeiling() on the server.
export function ceilingFor(contractor, { net, vat, total }) {
  const { netP, totalP } = reconcile({ net, vat, total });
  return (contractor?.commission_on === 'gross' ? totalP : netP) / 100;
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
