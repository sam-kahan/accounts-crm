// Checks on an email the AI drafted, before anyone sees it. Pure and tested.
import { addWorkingDays } from './complaintRules.js';

// The message says something goes with it ("attached", "enclosed"), not
// counting the "Attached: …" line the system writes itself.
export function saysAttached(body) {
  const text = String(body || '').replace(/\n*Attached: [^\n]*/g, '');
  return /\b(?:attached|enclosed|attach(?:ing)?|enclose|enclosing)\b/i.test(text);
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Which of the complaint's documents go with a drafted email: the ones the AI
// named from the list it was given (matched by file name), and, if it says
// something is attached but named none that exist, every document on file
// rather than none (an email saying "attached" with nothing on it is the
// mistake this exists to stop). `docs`: [{ id, filename }].
export function pickAttachments(email, docs = []) {
  if (!email || !docs.length) return [];
  const named = Array.isArray(email.attach) ? email.attach.map(norm).filter(Boolean) : [];
  const ids = docs.filter((d) => named.includes(norm(d.filename))).map((d) => d.id);
  if (ids.length) return [...new Set(ids)];
  return saysAttached(email.body) ? docs.map((d) => d.id) : [];
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const pad = (n) => String(n).padStart(2, '0');
// The dates a sentence mentions, as YYYY-MM-DD: "28 September 2026",
// "28 Sep", "28/09/2026", "28/09/26", "28/09" (a date with no year is this
// year's, or last year's if that would put it in the future).
export function datesIn(text, today) {
  const out = [];
  const year = Number(today.slice(0, 4));
  const push = (d, m, y) => {
    if (!(m >= 1 && m <= 12 && d >= 1 && d <= 31)) return;
    let yy = y ?? year;
    if (yy < 100) yy += 2000;
    let iso = `${yy}-${pad(m)}-${pad(d)}`;
    if (y == null && iso > today) iso = `${yy - 1}-${pad(m)}-${pad(d)}`;
    out.push(iso);
  };
  for (const m of String(text).matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([A-Za-z]{3,9})\.?(?:,?\s+(\d{4}))?\b/g)) {
    const idx = MONTHS.findIndex((x) => x.startsWith(m[2].toLowerCase()) && m[2].length >= 3);
    if (idx >= 0) push(Number(m[1]), idx + 1, m[3] ? Number(m[3]) : null);
  }
  for (const m of String(text).matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    push(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : null);
  }
  return out;
}

const NO_REPLY = /\b(?:not\s+(?:yet\s+)?(?:received|had|heard)|no\s+(?:response|reply|answer)|haven['’]?t\s+(?:yet\s+)?(?:heard|received|had|replied|responded)|have\s+not\s+(?:yet\s+)?(?:heard|received|had|replied|responded)|still\s+(?:waiting|awaiting)|yet\s+to\s+(?:receive|hear|respond|reply)|failed\s+to\s+(?:respond|reply)|without\s+(?:a\s+|any\s+)?(?:response|reply)|not\s+(?:been\s+)?(?:responded|replied))\b/i;
export const REPLY_GAP_WORKING_DAYS = 10;

// A draft that complains of no reply to something sent only days ago reads
// badly ("we asked on 28 September and have had no response", written on the
// 29th). The sentence that does it, and the date, or null.
export function staleNoReply(body, today) {
  const sentences = String(body || '').split(/(?<=[.!?])\s+|\n+/);
  for (const s of sentences) {
    if (!NO_REPLY.test(s)) continue;
    const recent = datesIn(s, today).filter((d) => d <= today && addWorkingDays(d, REPLY_GAP_WORKING_DAYS) > today);
    if (recent.length) return { sentence: s.trim(), date: recent.sort().pop() };
  }
  return null;
}
