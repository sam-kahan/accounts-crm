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
export function ensureSignOff(body) {
  const s = String(body ?? '').replace(/\s+$/, '');
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
