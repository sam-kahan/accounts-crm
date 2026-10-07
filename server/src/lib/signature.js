// Drafts (the AI's, and the plain ones the page writes) are signed with a
// placeholder — "[Name]", "[Your name]", "[Job title]" — because nobody knows
// who will send them. The person sending fills it: their name, and their job
// title where one is set (a title placeholder with no title set is dropped,
// with its line). client/src/api.js#signEmail is the same rule, so what is
// shown and copied matches what is sent; this one is the backstop, so a
// placeholder can never go out.
const NAME = /\[\s*(?:your\s+)?(?:full\s+)?name\s*\]/gi;
const TITLE = /\[\s*(?:your\s+)?(?:job\s*title|position|role|title)\s*\]/gi;

export function signEmail(text, user) {
  let s = String(text ?? '');
  // A person with no name set signs with their email address rather than
  // letting "[Name]" go out. Functions, so a "$" in either is kept as typed.
  const name = user?.name || user?.email;
  if (name) s = s.replace(NAME, () => name);
  if (user?.job_title) s = s.replace(TITLE, () => user.job_title);
  else s = s.replace(new RegExp(`^[ \\t]*${TITLE.source}[ \\t]*\\n?`, 'gim'), '').replace(TITLE, '');
  return s;
}

// A draft whose sign-off has no placeholder (the AI signed it with a company
// name, say "Greenco Property Group, Accounts") would never carry the
// sender's name. The closing line and everything after it are replaced with
// the standard sign-off, which signEmail then fills. A draft with no closing
// line gets one added.
const CLOSING = /^[ \t]*(?:kind regards|best regards|regards|many thanks|yours sincerely|yours faithfully),?[ \t]*$/im;
// The stock phrases that give a drafted email away, taken out whatever the
// AI wrote (the instructions ask it not to use them; this is the backstop).
// Only whole stock sentences are removed, and long dashes become commas, so
// the meaning of the email is never changed.
const STOCK_SENTENCES = [
  /^\s*I hope (?:this|my) (?:email|message|letter) finds you well[.!]?\s*/gim,
  /^\s*I hope you are (?:keeping )?well[.!]?\s*/gim,
  /\s*(?:Please )?(?:do not|don['’]t) hesitate to (?:contact|get in touch with) (?:us|me)[^.\n]*\.\s*/gi,
  /\s*(?:Please )?(?:feel free to )?(?:let us know|contact us) if you (?:have|need) any (?:further )?(?:questions|queries|information)[^.\n]*\.\s*/gi,
  /\s*Thank you (?:in advance )?for your (?:time and )?(?:attention|assistance|cooperation|co-operation) (?:to|in|with) this matter\.\s*/gi,
];
export function tidyEmail(body) {
  let s = String(body ?? '');
  for (const re of STOCK_SENTENCES) s = s.replace(re, (m) => (/\n/.test(m) ? '\n' : ' '));
  s = s.replace(/\s*[—–]\s*/g, ', ').replace(/ ,/g, ',').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return s.replace(/^\s+/, '');
}

export function ensureSignOff(body) {
  const s = tidyEmail(body).replace(/\s+$/, '');
  if (!s) return s;
  if (NAME.test(s)) { NAME.lastIndex = 0; return s; }
  NAME.lastIndex = 0;
  const lines = s.split('\n');
  let at = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (CLOSING.test(lines[i])) { at = i; break; }
  }
  const head = at >= 0 ? lines.slice(0, at).join('\n').replace(/\s+$/, '') : s;
  return `${head}\n\nKind regards,\n\n[Name]\n[Job title]\nGreenco`;
}

// A gap left to fill in, once [Name] / [Job title] are filled: "[Paste our
// email of 16 September here]", "[date]", "[Landlord name]". Nothing goes to
// an organisation or an ombudsman with one. NOT a gap: our own reference in
// a subject ("[GC-C-BLV2WK]", put there so replies file themselves), a tag a
// mail system adds ("[EXTERNAL]", "[Ticket #12345]", "[850123456]"), an
// image or address a quoted email carries ("[image: logo]", "[mailto:…]"),
// "[sic]". A subject counts only a clear placeholder: its tags vary too much.
const PLACEHOLDER = /\b(?:name|date|amount|address|insert|paste|add|enter|fill|details?|title|number|here|tbc|xx+)\b/i;
// A word a mail system puts in brackets on its own ("[EXTERNAL]"), never the
// start of a sentence ("[External link]", "[Re-attach the bill]").
const TAG = /^\s*(?:external|ext|secure|spam|suspected\s+spam|encrypt(?:ed)?|fwd?|re|caution|warning|urgent|important|confidential)\s*$/i;
// A reference or number: an optional label ("Ticket #", "Ref:", "Case")
// then digits and short codes, with no word in it ("[Ticket #12345]",
// "[850123456]", "[Ref: AB-1234]"), never "[Case notes here]".
const CODE = (c) => {
  const rest = c.replace(/^\s*(?:ticket|ref(?:erence)?|our\s+ref|your\s+ref|case|incident|job)\b\.?\s*(?:no\.?|number)?\s*[:#]?\s*/i, '');
  return /\d/.test(rest) && !/[a-z]{4,}/i.test(rest) && /^[#A-Z0-9][A-Z0-9#\-\/. ]*$/i.test(rest.trim());
};
const notGap = (c) => /^\s*sic\s*$/i.test(c) ||
  /@|:\/\/|cid:|mailto:|^\s*image\s*:/i.test(c) ||
  /^\s*GC-(?:C|CI|COM)-[A-Z0-9]+\s*$/i.test(c) ||
  TAG.test(c) || CODE(c) ||
  // Another single word in capitals ("[PDF]"), unless it is a placeholder
  // ("[NAME]", "[DATE]", "[TBC]").
  (/^\s*[A-Z]{2,12}\s*$/.test(c) && !PLACEHOLDER.test(c));
const BRACKETS = /\[([^\]\n]{2,})\]/g;
export const GAP_RE = /\[[^\]\n]{2,}\]/; // the shape only; gapIn decides
export function gapIn(subject, body = '') {
  for (const [text, isSubject] of [[subject, true], [body, false]]) {
    for (const m of String(text ?? '').matchAll(BRACKETS)) {
      if (notGap(m[1])) continue;
      if (isSubject && !PLACEHOLDER.test(m[1])) continue;
      return m[0];
    }
  }
  return null;
}
