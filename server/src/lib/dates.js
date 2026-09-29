// Date helpers. The app stores/compares dates as YYYY-MM-DD strings in UK local
// time, so "today" must be the London calendar date — not the UTC date, which
// is a day ahead between midnight and 01:00 during British Summer Time.

// Today's date in Europe/London as YYYY-MM-DD (en-CA formats as ISO).
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
    new Date(),
  );
}

// The Europe/London calendar date of an instant (e.g. when an email arrived).
// An email at 00:30 BST is on the London day, not the UTC day before — and that
// date can decide whether an acknowledgement was on time.
export function londonDateOf(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(date);
}

// Add N calendar days to a YYYY-MM-DD string (used for payment terms, which
// are calendar days — unlike complaint deadlines, which are working days).
// The maths is done in UTC so a DST change can never shift the day.
export function addDays(dateStr, n) {
  if (!dateStr) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d) + n * 86400000);
  return t.toISOString().slice(0, 10);
}

// First and last day of a YYYY-MM month, e.g. '2026-08' -> Aug 1st–31st.
// Day 0 of the following month is the last day of this one, leap years included.
export function monthRange(month) {
  const [y, m] = String(month).split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) return null;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return {
    from: `${y}-${String(m).padStart(2, '0')}-01`,
    to: `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

// The YYYY-MM month a date falls in; defaults to the current UK month.
export function monthOf(dateStr) {
  return (dateStr || todayISO()).slice(0, 7);
}

// '2026-08' -> 'August 2026', for report headings and invoice descriptions.
export function monthLabel(month) {
  const range = monthRange(month);
  if (!range) return String(month);
  return new Date(`${range.from}T00:00:00Z`).toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

// The next occurrence of a recurring date AFTER `today` (marking a VAT
// quarter or a PAYE month done). Each occurrence is counted from the ORIGINAL
// date and clamped to the month's end, so 31 Aug monthly is 30 Sep, then
// 31 Oct — never drifting to the 1st, a day after the real deadline — and
// 29 Feb annual is 28 Feb in other years. As many periods as needed, so a
// date several periods overdue doesn't land on another past date.
export function nextOccurrence(dateStr, recurrence, today = todayISO()) {
  const step = { annual: 12, quarterly: 3, monthly: 1 }[recurrence];
  if (!step || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || '')) return null;
  const [y, m, d] = dateStr.split('-').map(Number);
  for (let n = 1; n < 2400; n += 1) {
    const total = y * 12 + (m - 1) + n * step;
    const ty = Math.floor(total / 12);
    const tm = total % 12;
    const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
    const next = `${ty}-${String(tm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
    if (next > today) return next;
  }
  return null;
}
