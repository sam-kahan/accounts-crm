// Date helpers. The app stores/compares dates as YYYY-MM-DD strings in UK local
// time, so "today" must be the London calendar date — not the UTC date, which
// is a day ahead between midnight and 01:00 during British Summer Time.

// Today's date in Europe/London as YYYY-MM-DD (en-CA formats as ISO).
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
    new Date(),
  );
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
