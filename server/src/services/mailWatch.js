import { query } from '../db/pool.js';
import { config } from '../config.js';
import { fetchMailboxSince } from './graphMail.js';
import { storeEmail } from './emailIngest.js';
import { getSetting, setSetting, watchedMailboxes } from './settings.js';

// ---------------------------------------------------------------------------
// Watching a mailbox people already copy (accounts@), so nothing has to be
// forwarded or copied in. Every five minutes the new mail in each watched
// mailbox is looked at, and only three kinds are kept — everything else is
// left alone and never stored:
//   thread  a reply in the same email thread as one already on a complaint:
//           filed on that complaint with certainty
//   watch   to or from an organisation we have an open complaint with: the AI
//           decides whether it is about the complaint (and it is discarded if
//           not)
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

export function routeWatchedEmail(e, { ourDomain, threads, orgDomains }) {
  if (e.conversationId && threads.has(e.conversationId)) {
    return { method: 'thread', complaintId: threads.get(e.conversationId) };
  }
  const people = [e.senderEmail, ...(e.toAddresses || [])].filter(Boolean);
  if (people.some((a) => orgDomains.has(domainOf(a)))) return { method: 'watch', complaintId: null };
  const fromUs = domainOf(e.senderEmail) === ourDomain;
  const external = people.some((a) => {
    const d = domainOf(a);
    return d && d !== ourDomain;
  });
  if (fromUs && external && /complain/i.test(`${e.subject || ''} ${e.bodyPreview || ''}`)) {
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
       SELECT e.sender_email FROM complaint_emails e JOIN complaints c ON c.id = e.complaint_id
        WHERE c.state = 'open' AND e.direction = 'inbound' AND e.sender_email IS NOT NULL`,
    )
  ).rows.map((r) => r.a);
  const orgDomains = new Set(
    addrs.map(domainOf).filter((d) => d && d !== ourDomain && !PUBLIC_DOMAINS.has(d)),
  );
  return { ourDomain, threads, orgDomains };
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
    const from = since[mb]
      ? new Date(new Date(since[mb]).getTime() - 3600000)
      : new Date(Date.now() - 86400000);
    const started = new Date();
    try {
      const mail = await fetchMailboxSince(mb, from);
      fetched += mail.length;
      for (const e of mail) {
        const route = routeWatchedEmail(e, ctx);
        if (!route) continue;
        const id = await storeEmail(e, { complaintId: route.complaintId, method: route.method, mailbox: mb });
        if (id) ids.push(id);
      }
      since[mb] = started.toISOString();
    } catch (err) {
      errors.push(`${mb}: ${err.message}`);
    }
  }
  await setSetting('watch_since', since);
  return { mailboxes, fetched, ids, errors };
}
