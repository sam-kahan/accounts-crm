// Money helpers. Amounts live in the database as NUMERIC(12,2) (exact decimal)
// and travel over the API as plain numbers, but every calculation in between is
// done in INTEGER PENCE — binary floating point can't represent 0.1, so
// `100 * 10 / 100` is 10.000000000000002 and a month of those drifts a real
// invoice off by a penny. Convert in, do integer maths, convert out.

// Parse anything the API/DB might hand us (number, '12.34' from pg NUMERIC,
// '£1,200.50' read off an invoice, '', null) into integer pence. Returns null
// when there's no usable number.
//
// The digits are read out of the DECIMAL STRING rather than multiplied by 100,
// because `Math.round(1.005 * 100)` is 100 — 1.005 has no exact binary
// representation, so the naive conversion quietly loses a penny. Half-way
// values round away from zero, the way money is normally rounded.
export function toPence(value) {
  if (value === null || value === undefined) return null;
  let s = typeof value === 'number' ? String(value) : String(value).trim();
  // Exponent notation (very large/small numbers) — expand it before parsing.
  if (/e/i.test(s)) {
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    s = n.toFixed(6);
  }
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(s.replace(/[£,\s]/g, ''));
  if (!m || (!m[2] && !m[3])) return null;
  const whole = Number(m[2] || '0');
  if (!Number.isFinite(whole)) return null;
  const frac = m[3] || '';
  let pence = whole * 100 + Number(`${frac}00`.slice(0, 2));
  if (Number(frac[2]) >= 5) pence += 1; // round the third decimal up
  return m[1] === '-' ? -pence : pence;
}

// Integer pence back to a 2dp number for the API/DB (e.g. 1050 -> 10.5).
export function fromPence(pence) {
  if (pence === null || pence === undefined) return null;
  return Math.round(pence) / 100;
}

// Format pence as a UK money string for emails, CSVs and printed invoices.
export function formatPence(pence) {
  const p = Math.round(pence || 0);
  const sign = p < 0 ? '-' : '';
  const abs = Math.abs(p);
  return `${sign}£${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
}

// A percentage of an amount, in pence. The rate may carry up to 3 decimal
// places (10.5%, 12.375%), so it is scaled to integer thousandths first and the
// whole thing stays in integer arithmetic until the final rounding.
export function percentOfPence(pence, ratePercent) {
  const rateMilli = Math.round(Number(ratePercent || 0) * 1000);
  if (!Number.isFinite(rateMilli) || !rateMilli) return 0;
  const result = (pence * rateMilli) / 100000;
  return Math.round(Math.abs(result)) * (result < 0 ? -1 : 1);
}

// pg hands NUMERIC columns back as strings (to protect precision it can't
// guarantee in a JS number). Our amounts are invoice-sized, so convert the
// known money columns to numbers on the way out to the API — the client should
// never have to guess whether a total is '10.00' or 10.
export function withNumbers(row, keys) {
  if (!row) return row;
  const out = { ...row };
  for (const key of keys) {
    if (out[key] !== null && out[key] !== undefined) out[key] = Number(out[key]);
  }
  return out;
}
