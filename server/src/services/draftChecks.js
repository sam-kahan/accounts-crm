// Checks on an email the AI drafted, before anyone sees it. Pure and tested.
import { addWorkingDays } from './complaintRules.js';

// The message says something goes with it ("attached", "enclosed"), not
// counting the "Attached: …" line the system writes itself.
export function saysAttached(body) {
  const text = String(body || '').replace(/\n*Attached: [^\n]*/g, '');
  return /\b(?:attached|enclosed|attach(?:ing)?|enclose|enclosing)\b/i.test(text);
}

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The complaint's documents the AI named for a drafted email, matched by
// file name. Only those: when it says something is attached but named none,
// the caller has the AI choose from the documents' descriptions
// (docChoice.js), never "all of them". `docs`: [{ id, filename }].
export function pickAttachments(email, docs = []) {
  if (!email || !docs.length) return [];
  const named = Array.isArray(email.attach) ? email.attach.map(norm).filter(Boolean) : [];
  return [...new Set(docs.filter((d) => named.includes(norm(d.filename))).map((d) => d.id))];
}

// What the organisation has asked Greenco for (proof of ownership, a
// tenancy agreement, meter readings…), as the review read it, each matched
// to the document on file that provides it by the exact file name the AI
// gave, or null when nothing on file does: the page then asks a person for
// it. A name that isn't on file is never taken on trust. At most 10 items.
// `docs`: [{ id, filename }]. Returns [{ item, attachment_id, filename,
// given, not_ours }], or null when they asked for nothing. Missing (to ask a
// person for) is only an item with none of the three: `stillMissing`.
export function normaliseRequested(list, docs = []) {
  if (!Array.isArray(list)) return null;
  const out = [];
  const seen = new Set();
  for (const x of list) {
    const raw = typeof x === 'string' ? x : x?.item;
    const item = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    if (!item || seen.has(norm(item))) continue;
    seen.add(norm(item));
    const want = typeof x === 'object' && x ? norm(x.file) : '';
    const d = want ? docs.find((doc) => norm(doc.filename) === want) : null;
    const note = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 200) : null);
    // Already given in one of Greenco's emails, or not Greenco's to give:
    // never shown as missing, never asked for again.
    out.push({
      item, attachment_id: d?.id || null, filename: d?.filename || null,
      given: d ? null : note(x?.given), not_ours: d ? null : note(x?.not_ours),
    });
    if (out.length >= 10) break;
  }
  return out.length ? out : null;
}

export const stillMissing = (x) => !x.attachment_id && !x.given && !x.not_ours;

// A step with what they asked for: the documents found on file go with its
// email, whatever else the AI chose, so nothing asked for and on file is
// left behind. `step`: a review, or one organisation's entry.
export function withRequestedDocs(step, docs = []) {
  if (!step || typeof step !== 'object') return step;
  const requested = normaliseRequested(step.requested, docs);
  const ids = (requested || []).map((r) => r.attachment_id).filter(Boolean);
  const email = step.email && ids.length
    ? { ...step.email, attachment_ids: [...new Set([...(step.email.attachment_ids || []), ...ids])] }
    : step.email;
  return { ...step, requested, email };
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
