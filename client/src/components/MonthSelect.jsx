import { monthOf, monthLabel } from '../api';

// ---------------------------------------------------------------------------
// Pick a month from a list.
//
// This was a native <input type="month">, which on the desktop browsers this is
// used from means clicking into the field and driving a little calendar — three
// actions to answer "which month am I doing?". Month end is the whole job here,
// so the months are just listed.
// ---------------------------------------------------------------------------

// A couple of months ahead (work is occasionally invoiced forward) and two
// years back, which covers anything anyone reaches for at month end.
const AHEAD = 2;
const BACK = 23;

export function monthOptions(selected, today = monthOf()) {
  const [y, m] = today.split('-').map(Number);
  const months = new Set();
  for (let i = AHEAD; i >= -BACK; i -= 1) {
    // Built in UTC so a month never slides either side of a DST change.
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    months.add(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  // Whatever is actually selected is always in the list: a bookmarked link or
  // an older month must never be silently swapped for a different one.
  if (selected) months.add(selected);
  return [...months].sort().reverse();
}

export default function MonthSelect({ value, onChange, label = 'Month' }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={label}
    >
      {monthOptions(value).map((m) => (
        <option key={m} value={m}>
          {monthLabel(m)}
        </option>
      ))}
    </select>
  );
}
