// "Please send a copy of your email of 16 September": an email that is on
// file is a document Greenco HAS. When an organisation asks for one, it is
// made into a PDF, kept on the complaint as a document, and goes with the
// reply like any other document they asked for (draftChecks.js#withRequestedDocs)
// instead of being shown as "Not on file: Upload it".
//
// No AI: which email is decided by rule (the date the item names, the review's
// own `email_date`, and "our" for Greenco's own), and the PDF is plain text
// (lib/pdf.js). Made once: the same email makes the same bytes, which the
// attachment store recognises (saveAttachmentBuffer's hash).

import { query } from '../db/pool.js';
import { config } from '../config.js';
import { textPdf } from '../lib/pdf.js';
import { saveAttachmentBuffer } from './attachments.js';
import { datesIn } from './draftChecks.js';
import { isOurOwnEmail } from './emailAnalysis.js';
import { londonDateOf, todayISO } from '../lib/dates.js';

const ISO = /^\d{4}-\d{2}-\d{2}$/;
// What a person writing "a copy of our email" calls it.
const ABOUT_EMAIL = /\b(?:e-?mails?|correspondence)\b/i;
const OURS = /\b(?:our|greenco(?:['’]s)?|we\s+sent)\b/i;
// The organisation's own email ("their email", "the email they sent").
const THEIRS = /\b(?:their|they\s+sent|from\s+them)\b/i;

// "Wed 16 Sep 2026" (complaintRules.js#ukDate's form).
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ukDay = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// The day an email was SENT: the reading's `sent_on` (a forward's own date is
// the day it was forwarded), else the UK day it arrived.
export function sentDay(em) {
  const arrived = em.received_at ? londonDateOf(new Date(em.received_at)) : null;
  const read = em.analysis?.sent_on;
  return ISO.test(read || '') && (!arrived || read <= arrived) ? read : arrived;
}

// The emails on file that one requested item is a copy of, oldest first;
// [] when the item isn't a copy of an email, names no date, or none matches.
// Pure. `item`: { item, email_date? } from the review's "requested".
export function emailsRequested(item, emails, { today = todayISO(), ourDomain = '' } = {}) {
  const text = String(item?.item || '');
  const named = ISO.test(item?.email_date || '') ? item.email_date : null;
  if (!named && !ABOUT_EMAIL.test(text)) return [];
  const days = named ? [named] : [...new Set(datesIn(text, today))];
  if (days.length !== 1) return []; // no date, or two: not for a rule to pick
  // "Our emails of 16 and 20 September" reads as one date (the 20th): a day
  // number left over once the dates are taken out means more than one.
  if (!named && /\b\d{1,2}(?:st|nd|rd|th)?\b/i.test(text
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\b\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?:,?\s+\d{4})?/gi, ' '))) return [];
  const want = OURS.test(text) ? 'ours' : THEIRS.test(text) ? 'theirs' : null;
  const ours = (em) => em.direction === 'outbound' || isOurOwnEmail(em, em.analysis, ourDomain);
  const found = (emails || [])
    .filter((em) => !em.removed_org && sentDay(em) === days[0])
    .filter((em) => !want || (want === 'ours' ? ours(em) : !ours(em)))
    .sort((a, b) => new Date(a.received_at) - new Date(b.received_at));
  // One email in two copies (sent from here, and the copy that came back to
  // a mailbox before Message-IDs were kept) goes in once.
  const seen = new Set();
  return found.filter((em) => {
    const key = `${String(em.subject || '').trim().toLowerCase()}|${String(em.body_text || em.body_preview || '')
      .replace(/\s+/g, ' ').trim().slice(0, 300).toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The words of an email as sent. An email sent from here before its whole
// text was kept has only a 2,000-character preview; its send (the outbox
// row) has the rest. Null when only a cut-off copy exists: a document that
// stops mid-sentence is not a copy of the email.
async function fullBody(em) {
  if (em.body_text) return em.body_text;
  if (em.direction === 'outbound') {
    const { rows } = await query(
      `SELECT body FROM complaint_outbox
        WHERE complaint_id = $1 AND status = 'sent' AND subject IS NOT DISTINCT FROM $2
          AND finished_at BETWEEN $3::timestamptz - interval '1 day' AND $3::timestamptz + interval '1 day'
        ORDER BY abs(extract(epoch FROM finished_at - $3::timestamptz)) LIMIT 1`,
      [em.complaint_id, em.subject, em.received_at],
    );
    if (rows[0]?.body) return rows[0].body;
  }
  const preview = em.body_preview || '';
  return preview.length >= 2000 ? null : preview;
}

// "Wed 16 Sep 2026, 10:00", UK time.
const whenSent = (em) => {
  const d = new Date(em.received_at);
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });
  return `${ukDay(londonDateOf(d))}, ${time}`;
};

// The PDF's text: each email with its own headers, as a printed email reads.
export function copyText(emails, bodies) {
  return emails.map((em, i) => {
    const from = em.direction === 'outbound' ? em.sender_email : [em.sender_name, em.sender_email && `<${em.sender_email}>`].filter(Boolean).join(' ');
    return [
      `From:    ${from || ''}`,
      `To:      ${(em.to_addresses || []).join(', ')}`,
      `Sent:    ${whenSent(em)}`,
      `Subject: ${em.subject || '(no subject)'}`,
      '',
      String(bodies[i] || '').trim(),
    ].join('\n');
  }).join(`\n\n${'-'.repeat(60)}\n\n`);
}

// For each item of "requested" still missing (no file, not given, not
// Greenco's to give) that is a copy of an email on file: make it a document,
// name it in the item's `file` and add it to `docList`, so withRequestedDocs
// counts it on file and puts it on the email. Best-effort: anything that goes
// wrong leaves the item as it was ("Not on file"), never the review unwritten.
export async function attachRequestedEmails(complaintId, requested, { emails = [], docList = [], today = todayISO() } = {}) {
  if (!Array.isArray(requested)) return;
  const ourDomain = String(config.complaintEmail?.domain || '').toLowerCase();
  for (const x of requested) {
    if (!x || typeof x !== 'object' || x.given || x.not_ours) continue;
    if (x.file && docList.some((d) => d.filename === x.file)) continue;
    try {
      const found = emailsRequested(x, emails, { today, ourDomain });
      if (!found.length) continue;
      const bodies = await Promise.all(found.map(fullBody));
      if (bodies.some((b) => b == null)) continue;
      const day = sentDay(found[0]);
      const subject = String(found[0].subject || 'no subject').replace(/\s+/g, ' ').trim().slice(0, 60);
      const filename = `Email ${ukDay(day).slice(4)} - ${subject}.pdf`.replace(/[\\/:*?"<>|]+/g, ' ');
      const title = found.length === 1 ? `Email of ${ukDay(day)}: ${found[0].subject || '(no subject)'}` : `Emails of ${ukDay(day)}`;
      const buffer = textPdf({ title: title.slice(0, 80), text: copyText(found, bodies) });
      const saved = await saveAttachmentBuffer(
        complaintId,
        { filename, mimetype: 'application/pdf', buffer },
        found[0].id,
        { description: `Copy of the email${found.length > 1 ? 's' : ''} of ${ukDay(day)} (${subject}), made from the email on file` },
      );
      x.file = saved.filename;
      x.copy_of = { day, ours: found.every((em) => em.direction === 'outbound' || isOurOwnEmail(em, em.analysis, ourDomain)) };
      if (!docList.some((d) => d.id === saved.id)) {
        docList.push({ id: saved.id, filename: saved.filename, uploaded_at: new Date().toISOString(), description: null });
      }
    } catch (err) {
      console.warn(`[email copies] ${complaintId}: ${err.message}`);
    }
  }
}

// A gap left in a draft for pasting in an email ("[Paste our email of 16
// September 2026 here]") once that email is attached as a PDF: the line
// becomes "A copy of our email of 16 September 2026 is attached." Only a gap
// that asks to paste, insert, attach or include an email, and only when one
// copy was made (with two, which is which is not for a rule to guess).
const PASTE_GAP = /\[[^\]\n]*\b(?:paste|insert|attach|include|copy)\b[^\]\n]*\be-?mail\b[^\]\n]*\]/gi;
const longDay = (iso) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
export function fillPasteGaps(body, copies = []) {
  if (typeof body !== 'string' || copies.length !== 1) return body;
  const { day, ours } = copies[0];
  const sentence = `A copy of ${ours ? 'our' : 'the'} email of ${longDay(day)} is attached.`;
  return body.replace(PASTE_GAP, sentence);
}

// The copies made for a step's "requested" (attachRequestedEmails marks
// them). With `emails`, also an item already on file from an earlier pass:
// its email worked out again by the same rule.
export function copiesMade(requested, emails = null, { today = todayISO() } = {}) {
  const ourDomain = String(config.complaintEmail?.domain || '').toLowerCase();
  const ours = (em) => em.direction === 'outbound' || isOurOwnEmail(em, em.analysis, ourDomain);
  return (Array.isArray(requested) ? requested : []).map((x) => {
    if (x?.copy_of) return x.copy_of;
    if (!emails || !(x?.attachment_id || x?.file)) return null;
    const found = emailsRequested(x, emails, { today, ourDomain });
    return found.length ? { day: sentDay(found[0]), ours: found.every(ours) } : null;
  }).filter(Boolean);
}

export const hasPasteGap = (body) => typeof body === 'string' && new RegExp(PASTE_GAP.source, 'i').test(body);
