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
  if (user?.name) s = s.replace(NAME, user.name);
  if (user?.job_title) s = s.replace(TITLE, user.job_title);
  else s = s.replace(new RegExp(`^[ \\t]*${TITLE.source}[ \\t]*\\n?`, 'gim'), '').replace(TITLE, '');
  return s;
}
