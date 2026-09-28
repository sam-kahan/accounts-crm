// ---------------------------------------------------------------------------
// Filing an email by the numbers it quotes. An open complaint's account number
// (and its references: theirs, each further organisation's, our GC-C code) is
// unique to it, so an email that quotes one — whoever it is from: the
// supplier, their debt collector, a solicitor, a colleague — belongs on that
// complaint with certainty, and no AI is needed to decide where it goes.
// Pure and tested; mailWatch.js and the email processor use it.
//
// Numbers are matched however they are written ("8500 1234 5678",
// "8500-1234-5678", "850012345678") but only as a whole number — never as part
// of a longer one, so a phone number or an invoice number that happens to
// contain an account number's digits doesn't match.
// ---------------------------------------------------------------------------

export const keyOf = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Safe to file on: at least 6 letters/digits with a digit among them (a
// short or all-letter reference would match unrelated mail), or our own
// GC-C code, which is unique by construction.
export function searchableKey(key) {
  return /^GCC[A-Z0-9]{6}$/.test(key) || (key.length >= 6 && /\d/.test(key));
}

// The number as a pattern that allows the usual separators between its
// characters and requires it to stand on its own.
export function numberPattern(key) {
  const body = [...key].join('[\\s./-]?');
  return new RegExp(`(?<![A-Za-z0-9])${body}(?![A-Za-z0-9])`, 'i');
}

// Every number that identifies an open complaint, with the complaint it
// identifies. `complaints`: { id, account_numbers, reference, ref_code,
// party_refs }.
export function buildNumberIndex(complaints) {
  const out = [];
  for (const c of complaints) {
    const seen = new Set();
    const add = (value, kind) => {
      const key = keyOf(value);
      if (!key || seen.has(key) || !searchableKey(key)) return;
      seen.add(key);
      out.push({ key, kind, complaintId: c.id, re: numberPattern(key) });
    };
    for (const a of c.account_numbers || []) add(a, 'account');
    add(c.reference, 'reference');
    for (const r of c.party_refs || []) add(r, 'reference');
    add(c.ref_code, 'our code');
  }
  return out;
}

// The complaints a text quotes a number of.
export function complaintsQuoted(text, index) {
  const s = String(text || '');
  const ids = new Set();
  if (!s) return ids;
  for (const n of index) if (n.re.test(s)) ids.add(n.complaintId);
  return ids;
}

// The one complaint a text belongs to by its numbers, or null — when it
// quotes none, or numbers of more than one complaint (the same account on two
// complaints, say): then something else decides, never a guess here.
export function complaintByNumber(text, index) {
  const ids = complaintsQuoted(text, index);
  return ids.size === 1 ? [...ids][0] : null;
}
