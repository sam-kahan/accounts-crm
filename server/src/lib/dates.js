// Date helpers. The app stores/compares dates as YYYY-MM-DD strings in UK local
// time, so "today" must be the London calendar date — not the UTC date, which
// is a day ahead between midnight and 01:00 during British Summer Time.

// Today's date in Europe/London as YYYY-MM-DD (en-CA formats as ISO).
export function todayISO() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(
    new Date(),
  );
}
