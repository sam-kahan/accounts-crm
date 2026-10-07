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
const PLACEHOLDER = /\b(?:name|date|amount|address|insert|paste|add|enter|fill|details?|title|number|here|tbc|xx+|landlord|tenant|supplier|organi[sz]ation|company|reference|ref|postcode|mpan|mprn|e-?mail|phone|telephone|account|month|year|day|time|signature|figure|sum|total)\b/i;
// What a person is told to do, never part of a reference.
const INSTRUCTION = /\b(?:insert|paste|add|enter|fill|here|tbc|to\s+follow|complete|e\.?g|eg|example|or|check|which|confirm)\b/i;
// In a subject, only a blank to fill in: a reply's subject is "Re: <their
// subject>", and their tags name all sorts ("[External Email: Do not click
// links]", "[Account Query]").
const SUBJECT_PLACEHOLDER = /\b(?:name|date|amount|insert|paste|add|enter|fill|here|tbc|xx+|postcode)\b/i;
// What a mail system or a council puts in brackets ("[EXTERNAL]", "[EXTERNAL
// EMAIL]", "[OFFICIAL-SENSITIVE]"): the whole bracket, never the start of a
// sentence ("[External link]", "[Re-attach the bill]").
const TAG = /^\s*(?:external(?:\s+(?:e-?mail|sender|message|mail))?|ext|secure|spam|suspected\s+spam|encrypt(?:ed)?|fwd?|re|caution|warning|urgent|important|confidential|official(?:[-\s]sensitive)?|sensitive|not\s+protectively\s+marked)\s*$/i;
// A blank to type a figure into: zeros, X's, underscores ("[00/00/0000]",
// "[XX/XX/XXXX]", "[£___]", "[0.00]").
// "[DD/MM/YYYY]" too.
const BLANK = (c) => /^[\s0xXdDmMyY\/.\-_£,:]+$/.test(c) && /[0xX_]|[dD]{2}|[mM]{2}|[yY]{2}/.test(c);
// A reference with its label ("[Ticket #12345 - Your complaint]", "[Case Ref:
// CAS-12345-ABCD]", "[Your reference: 12345]", "[ref:_00D4J2Ez._5008d:ref]"):
// a label word, then something with a digit in it, and no instruction.
const LABELLED = /^\s*(?:ticket|ref(?:erence)?|our\s+ref(?:erence)?|your\s+ref(?:erence)?|their\s+ref(?:erence)?|case(?:\s+ref(?:erence)?)?|incident|job|account(?:\s+(?:no\.?|number))?|crm|claim|policy|invoice|order|customer\s+(?:no\.?|number))\b\.?\s*(?:no\.?|number)?\s*[:#_]?/i;
const notGap = (c) => {
  if (/^\s*sic\s*$/i.test(c) || /@|:\/\/|cid:|mailto:|^\s*image\s*:/i.test(c)) return true;
  if (/^\s*GC-(?:C|CI|COM)-[A-Z0-9]+\s*$/i.test(c)) return true;
  if (BLANK(c)) return false;
  if (TAG.test(c)) return true;
  // ...but not "[Account no: 00000000]" or "[Account number, e.g. 850123456]".
  if (LABELLED.test(c) && /\d/.test(c) && !INSTRUCTION.test(c) && !BLANK(c.replace(LABELLED, '').trim())) return true;
  // Text in capitals and figures ("[PDF]", "[CRM:0012345]", "[850123456]"),
  // unless it is a placeholder ("[NAME]", "[POSTCODE]", "[ACCOUNT NUMBER]").
  if (!/[a-z]/.test(c) && !PLACEHOLDER.test(c)) return true;
  // One or two small letters ("[ok]", "[a]") are not a blank to fill in.
  if (/^\s*[a-z]{1,2}\s*$/i.test(c) && !/x/i.test(c)) return true;
  return false;
};
const BRACKETS = /\[([^\]\n]{2,})\]/g;
export const GAP_RE = /\[[^\]\n]{2,}\]/; // the shape only; gapIn decides
export function gapIn(subject, body = '') {
  // On an "Attached:" line, the file names (a copy's name carries their own
  // subject's tags: "Email 16 Sep 2026 - [EXTERNAL EMAIL] RE ….pdf", no gap
  // anyone could fill); anything else on it is checked like the rest.
  const own = String(body ?? '').replace(/^([ \t]*Attached: )(.*)$/gm, (_, lead, list) =>
    lead + list.replace(/\.\s*$/, '').split(/;\s*/).filter((f) => !/\.[A-Za-z0-9]{2,5}$/.test(f.trim())).join('; '));
  for (const [text, isSubject] of [[subject, true], [own, false]]) {
    for (const m of String(text ?? '').matchAll(BRACKETS)) {
      if (notGap(m[1])) continue;
      if (isSubject && !SUBJECT_PLACEHOLDER.test(m[1]) && !BLANK(m[1])) continue;
      return m[0];
    }
  }
  return null;
}
