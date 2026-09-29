import { query } from '../db/pool.js';
import { config } from '../config.js';
import { fetchMailboxSince, fetchMessageText } from './graphMail.js';
import { bounceFromMailbox } from './bounces.js';
import { storeEmail } from './emailIngest.js';
import { lookFrom, nextCheckpoint, passOverStuck, STUCK_TRIES } from './mailCheckpoint.js';
import { getSetting, setSetting, watchedMailboxes } from './settings.js';
import { postcodeOf, PARTY_COLS } from './orgMatch.js';
import { buildNumberIndex, complaintsQuoted } from './numberMatch.js';

// ---------------------------------------------------------------------------
// Watching a mailbox people already copy (accounts@), so nothing has to be
// forwarded or copied in. Every five minutes the new mail in each watched
// mailbox is looked at, and only three kinds are kept — everything else is
// left alone and never stored:
//   thread  a reply in the same email thread as one already on a complaint:
//           filed on that complaint with certainty
//   account quoting an open complaint's account number or reference (from
//           anyone — the supplier, a debt collector, a solicitor): filed on
//           that complaint with certainty (numberMatch.js), then read
//   watch   to or from an organisation we have an open complaint with AND
//           mentioning a complaint (the word, a stage, an ombudsman, a final
//           response) or one of its references or its property's postcode:
//           the AI decides whether it is about the complaint (discarded if
//           not). An ordinary bill or reminder from British Gas is never read
//           by the AI just because we have a complaint open with them.
//   new     sent by us with "complaint" in it: possibly a new complaint, which
//           the AI can create
// routeWatchedEmail() is the rule, pure and tested; the rest fetches and stores.
// ---------------------------------------------------------------------------

// Public mail providers: sharing one of these with an organisation says
// nothing about whether an email is from them.
const PUBLIC_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'hotmail.co.uk', 'live.com',
  'live.co.uk', 'yahoo.com', 'yahoo.co.uk', 'icloud.com', 'me.com', 'aol.com', 'btinternet.com',
  'sky.com', 'virginmedia.com', 'protonmail.com', 'msn.com',
]);

export const domainOf = (addr) => String(addr || '').toLowerCase().split('@')[1] || '';

// Words that make an email worth the AI's time. Checked on the subject and
// the preview Microsoft sends with the message list, so ruling an email out
// costs nothing.
const COMPLAINT_WORDS = /complain|ombudsman|stage\s*(?:1|2|one|two)\b|final\s+(?:response|viewpoint|decision)|deadlock|escalat|redress/i;

export function routeWatchedEmail(e, { ourDomain, threads, orgDomains, markers = [], numbers = [], ignoredThreads = null }) {
  // A thread that was on a complaint since deleted: left alone for good.
  if (e.conversationId && ignoredThreads?.has(e.conversationId)) return null;
  if (e.conversationId && threads.has(e.conversationId)) {
    return { method: 'thread', complaintId: threads.get(e.conversationId) };
  }
  // Quoting an open complaint's account number or reference: that complaint,
  // whoever sent it. Numbers of two complaints: the AI decides between them.
  const quoted = complaintsQuoted(`${e.subject || ''} ${e.bodyPreview || ''}`, numbers);
  if (quoted.size === 1) return { method: 'account', complaintId: [...quoted][0] };
  if (quoted.size > 1) return { method: 'watch', complaintId: null };
  const people = [e.senderEmail, ...(e.toAddresses || [])].filter(Boolean);
  const text = `${e.subject || ''} ${e.bodyPreview || ''}`;
  if (people.some((a) => orgDomains.has(domainOf(a)))) {
    const lower = text.toLowerCase();
    if (COMPLAINT_WORDS.test(text) || markers.some((m) => lower.includes(m))) return { method: 'watch', complaintId: null };
    return null;
  }
  const fromUs = domainOf(e.senderEmail) === ourDomain;
  const external = people.some((a) => {
    const d = domainOf(a);
    return d && d !== ourDomain;
  });
  if (fromUs && external && /complain/i.test(text)) {
    return { method: 'watch_new', complaintId: null };
  }
  return null;
}

// What the rule needs to know: the threads already on complaints, and the
// email domains of organisations with an open complaint (from their saved
// complaints address and from emails they have sent us).
async function watchContext() {
  const ourDomain = config.complaintEmail.domain.toLowerCase();
  const threads = new Map(
    (
      await query(
        `SELECT DISTINCT ON (conversation_id) conversation_id, complaint_id FROM complaint_emails
          WHERE conversation_id IS NOT NULL AND complaint_id IS NOT NULL
          ORDER BY conversation_id, received_at DESC`,
      )
    ).rows.map((r) => [r.conversation_id, r.complaint_id]),
  );
  const addrs = (
    await query(
      `SELECT o.complaints_email AS a FROM complaints c JOIN organisations o ON o.id = c.organisation_id
        WHERE c.state = 'open' AND o.complaints_email IS NOT NULL
       UNION
       SELECT o.complaints_email FROM complaint_parties p
         JOIN complaints c ON c.id = p.complaint_id JOIN organisations o ON o.id = p.organisation_id
        WHERE c.state = 'open' AND o.complaints_email IS NOT NULL
       UNION
       SELECT e.sender_email FROM complaint_emails e JOIN complaints c ON c.id = e.complaint_id
        WHERE c.state = 'open' AND e.direction = 'inbound' AND e.sender_email IS NOT NULL`,
    )
  ).rows.map((r) => r.a);
  const orgDomains = new Set(
    addrs.map(domainOf).filter((d) => d && d !== ourDomain && !PUBLIC_DOMAINS.has(d)),
  );
  // What identifies an open complaint in an email that doesn't use the word:
  // our reference, theirs, and the property postcode.
  const open = (await query(
    `SELECT c.ref_code, c.reference, c.our_reference, c.property, c.account_numbers,
            (SELECT coalesce(array_agg(p.reference) FILTER (WHERE p.reference IS NOT NULL), '{}')
               FROM complaint_parties p WHERE p.complaint_id = c.id) AS party_refs
       FROM complaints c WHERE c.state = 'open'`,
  )).rows;
  const markers = [...new Set(open.flatMap((c) => [c.ref_code, c.reference, c.our_reference, ...(c.party_refs || []), postcodeOf(c.property), ...(c.account_numbers || [])])
    .filter((m) => m && String(m).trim().length >= 5)
    .map((m) => String(m).trim().toLowerCase()))];
  const numbers = buildNumberIndex((await query(
    `SELECT c.id, c.account_numbers, c.reference, c.ref_code, ${PARTY_COLS} FROM complaints c WHERE c.state = 'open'`,
  )).rows);
  const ignoredThreads = new Set((await query('SELECT conversation_id FROM complaint_ignored_threads')).rows.map((r) => r.conversation_id));
  return { ourDomain, threads, orgDomains, markers, numbers, ignoredThreads };
}

// Look at the new mail in every watched mailbox. Returns the ids stored, for
// processEmail(). A mailbox is read from the moment it was first watched —
// earlier mail is what "Find past complaints" is for.
export async function watchMailboxes() {
  const mailboxes = await watchedMailboxes();
  if (!config.ms.enabled || !mailboxes.length) return { mailboxes, fetched: 0, ids: [] };
  const ctx = await watchContext();
  const since = (await getSetting('watch_since')) || {};
  const ids = [];
  let fetched = 0;
  const errors = [];
  for (const mb of mailboxes) {
    // Overlap each look by an hour (storing is de-duplicated, and mail can land
    // late); a mailbox watched for the first time starts from the day before.
    const from = lookFrom(since[mb], 86400000);
    const started = new Date();
    try {
      const { items: mail, complete, readTo } = await fetchMailboxSince(mb, from);
      fetched += mail.length;
      let stoppedAt = null;
      for (const e of mail) {
        // A bounce is flagged for a person to look into, never filed.
        try {
          if (await bounceFromMailbox(e, mb, (m) => fetchMessageText(m.graphId, mb))) continue;
        } catch (err) {
          errors.push(`${mb}: a bounce couldn't be recorded (${err.message})`);
        }
        const route = routeWatchedEmail(e, ctx);
        if (!route) continue;
        try {
          const id = await storeEmail(e, { complaintId: route.complaintId, method: route.method, mailbox: mb });
          if (id) ids.push(id);
        } catch (err) {
          // Stop here so nothing after it is skipped by the checkpoint; one
          // that fails three checks running is passed over and said.
          if (await passOverStuck(mb, e)) {
            errors.push(`${mb}: an email ("${String(e.subject || '').slice(0, 80)}") couldn't be stored after ${STUCK_TRIES} checks and was passed over: ${err.message}`);
            continue;
          }
          errors.push(`${mb}: an email couldn't be stored (${err.message}); tried again next check`);
          stoppedAt = e.receivedAt;
          break;
        }
      }
      // Only move on past what was dealt with; a busy spell read in part is
      // carried on from the last one read (storing is de-duplicated).
      const next = nextCheckpoint({ started, complete: complete && !stoppedAt, readTo, stoppedAt });
      if (next) since[mb] = next;
      if (!complete && !stoppedAt) errors.push(`${mb}: more new mail than one check reads; the rest is read next time`);
    } catch (err) {
      errors.push(`${mb}: ${err.message}`);
    }
  }
  await setSetting('watch_since', since);
  return { mailboxes, fetched, ids, errors };
}
