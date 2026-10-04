// A field that can hold more than one email address (a contractor's accounts@
// and their contact). Stored as "a@x.co.uk, b@x.co.uk": the same form Greenco
// Invoicing keeps a client's addresses in, so the push carries them across
// as they are, and nodemailer sends to every one of them.

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;

// Greenco Invoicing cuts a client's email at 500 characters; longer would
// arrive there with the last address cut in half.
export const EMAIL_LIST_MAX = 500;

export function isValidEmail(s) {
  return EMAIL_RE.test(String(s || '').trim());
}

// Split on commas, semicolons, spaces or new lines (Outlook copies a list
// with semicolons); trim, drop blanks, and de-duplicate ignoring case.
export function splitEmails(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || '').split(/[,;\s]+/)) {
    const e = part.trim();
    if (!e) continue;
    const key = e.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

// { value: "a, b" | null, bad: [what isn't an address] }. Nothing invalid is
// dropped quietly: the caller refuses the save and names it.
export function parseEmailList(raw) {
  const list = splitEmails(raw);
  const bad = list.filter((e) => !isValidEmail(e));
  return { value: list.length ? list.join(', ') : null, bad };
}

export function emailListProblem(raw) {
  const { value, bad } = parseEmailList(raw);
  if (bad.length) {
    return `${bad.map((b) => `“${b}”`).join(', ')} ${bad.length === 1 ? 'isn’t an email address' : 'aren’t email addresses'}. ` +
      'Separate more than one address with commas.';
  }
  if (value && value.length > EMAIL_LIST_MAX) return `That is too many addresses (${EMAIL_LIST_MAX} characters at most).`;
  return null;
}
