import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Microsoft Graph transport for reading the shared domain catch-all mailbox
// (app-only / client credentials), the same mailbox refurb polls. It's a busy
// firehose (all unaddressed mail, spam included), so we pull a generous window
// of the most-recent messages and let ingestEmails pick out only the ones
// addressed to a complaint; the fetch cron should run frequently (~5 min) so
// complaint emails are picked up before they're buried. When MS_* env is not
// set, returns a couple of synthetic dev emails so the pipeline is exercisable
// without live credentials. Requires the Azure app's Mail.Read (application).
// ---------------------------------------------------------------------------

export function emailConfigured() {
  return config.ms.enabled;
}

// One app token, reused until shortly before it expires (it lasts about an
// hour) — a long search would otherwise ask Microsoft for hundreds of them.
let cachedToken = null;
async function getAppToken() {
  if (cachedToken && cachedToken.expires > Date.now() + 120000) return cachedToken.value;
  const body = new URLSearchParams({
    client_id: config.ms.clientId,
    client_secret: config.ms.clientSecret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(
    `https://login.microsoftonline.com/${config.ms.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    },
  );
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Graph token response missing access_token');
  cachedToken = { value: json.access_token, expires: Date.now() + (Number(json.expires_in) || 3000) * 1000 };
  return cachedToken.value;
}

function normalise(m) {
  return {
    graphId: m.id,
    messageId: m.internetMessageId ?? m.id,
    subject: m.subject ?? null,
    senderName: m.from?.emailAddress?.name ?? null,
    senderEmail: m.from?.emailAddress?.address ?? null,
    toAddresses: [
      ...(m.toRecipients ?? []),
      ...(m.ccRecipients ?? []),
      ...(m.bccRecipients ?? []),
    ]
      .map((r) => r.emailAddress?.address ?? '')
      .filter(Boolean),
    bodyPreview: m.bodyPreview ?? null,
    receivedAt: m.receivedDateTime ? new Date(m.receivedDateTime) : new Date(),
    sentAt: m.sentDateTime ? new Date(m.sentDateTime) : null,
    conversationId: m.conversationId ?? null,
    isDraft: Boolean(m.isDraft),
  };
}

const SELECT =
  'id,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,' +
  'receivedDateTime,sentDateTime,conversationId,isDraft';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every Graph read goes through here. Microsoft limits how many requests an
// app may make to one mailbox at once, and answers 429 (or 503) with a
// Retry-After when it wants us to slow down: those are waited out and retried
// a few times rather than treated as failures.
async function graphGet(url, headers = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const token = await getAppToken();
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, ...headers } });
    if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < 5) {
      const wait = Math.min(60, Number(res.headers.get('retry-after')) || 2 ** (attempt + 1));
      await sleep(wait * 1000);
      continue;
    }
    if (res.status === 401 && attempt === 0) {
      cachedToken = null; // expired early: fetch a fresh one once
      continue;
    }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      const err = new Error(`Microsoft Graph refused (${res.status})${res.status === 403 ? ': the app isn’t allowed to read this mailbox' : ''}`);
      err.status = res.status;
      err.detail = detail.slice(0, 300);
      throw err;
    }
    return res.json();
  }
}

const messagesUrl = (mailbox) =>
  `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`;

// Messages in one mailbox received since a date (every folder, sent items
// included, drafts left out), paging across the whole window. `complete` says
// whether the window was read to the end — a watcher must not move its
// checkpoint past mail it didn't get to.
export async function fetchMailboxSince(mailbox, since, maxPages = 40) {
  if (!config.ms.enabled) return { items: [], complete: true };
  let url =
    `${messagesUrl(mailbox)}?$top=50&$orderby=receivedDateTime desc` +
    `&$filter=receivedDateTime ge ${new Date(since).toISOString()}` +
    `&$select=${SELECT}`;
  const items = [];
  for (let page = 0; page < maxPages && url; page += 1) {
    const json = await graphGet(url);
    for (const m of json.value ?? []) if (!m.isDraft) items.push(normalise(m));
    url = json['@odata.nextLink'] || null;
  }
  return { items, complete: !url };
}

// Search a mailbox (Outlook's own search) for words, within a date window.
// Microsoft returns at most 1,000 results per search, newest first, so a long
// history is searched a window at a time by the caller. The words are joined
// with AND (no quote characters reach the query, so an odd reference can't
// break it). If the date restriction is refused, the search is repeated
// without it and filtered here.
export async function searchMailbox(mailbox, phrase, { from = null, to = null, max = 1000 } = {}) {
  if (!config.ms.enabled) return [];
  const words = String(phrase || '').replace(/["\\()]/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const day = (d) => new Date(d).toISOString().slice(0, 10);
  const dated = [words.join(' AND '), from && `received>=${day(from)}`, to && `received<${day(to)}`]
    .filter(Boolean).join(' AND ');
  const run = async (q) => {
    let url = `${messagesUrl(mailbox)}?$search=${encodeURIComponent(`"${q}"`)}&$top=50&$select=${SELECT}`;
    const out = [];
    while (url && out.length < max) {
      const json = await graphGet(url);
      for (const m of json.value ?? []) if (!m.isDraft) out.push(normalise(m));
      url = json['@odata.nextLink'] || null;
    }
    return out;
  };
  try {
    return await run(dated);
  } catch (err) {
    if (err.status !== 400 || (!from && !to)) throw err;
    const all = await run(words.join(' AND '));
    return all.filter((m) => (!from || m.receivedAt >= new Date(from)) && (!to || m.receivedAt < new Date(to)));
  }
}

// Every message in one email thread in a mailbox, oldest first, with its text
// — all of it, however long the thread (every page is followed).
export async function fetchConversation(mailbox, conversationId) {
  if (!config.ms.enabled) return [];
  let url =
    `${messagesUrl(mailbox)}` +
    `?$filter=${encodeURIComponent(`conversationId eq '${conversationId.replace(/'/g, "''")}'`)}` +
    `&$top=50&$select=${SELECT},body`;
  const out = [];
  for (let page = 0; page < 20 && url; page += 1) {
    const json = await graphGet(url, { Prefer: 'outlook.body-content-type="text"' });
    for (const m of json.value ?? []) {
      if (!m.isDraft) out.push({ ...normalise(m), bodyText: (m.body?.content || '').slice(0, 100000) });
    }
    url = json['@odata.nextLink'] || null;
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt);
}

export async function fetchMailboxMessages() {
  if (!config.ms.enabled) return devEmails();
  // The catch-all is a firehose, so pull everything within a lookback window
  // and follow every page (capped), so nothing in the window is dropped.
  const since = new Date(Date.now() - (config.ms.lookbackDays || 14) * 86400000);
  return (await fetchMailboxSince(config.ms.mailbox, since)).items;
}

// The whole of one email: its text and its file attachments. Fetched only for
// the emails that belong to a complaint (never the rest of the catch-all), and
// asked for as plain text so no HTML reaches the database or the model.
// Inline images (logos and signatures) and attached emails are skipped;
// anything over the size cap is named but not downloaded. A failure (after
// the retries) is thrown, not swallowed: an email must not be treated as
// complete when its attachments never arrived.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;
const MAX_ATTACHMENTS = 10;

export async function fetchMessageDetail(graphId, fallback = {}, mailbox = config.ms.mailbox) {
  if (!config.ms.enabled || !graphId || String(graphId).startsWith('dev-') || String(graphId).startsWith('out-')) {
    return { bodyText: fallback.bodyPreview || null, attachments: [], skipped: [] };
  }
  const base = `${messagesUrl(mailbox || config.ms.mailbox)}/${encodeURIComponent(graphId)}`;
  const msg = await graphGet(`${base}?$select=body`, { Prefer: 'outlook.body-content-type="text"' });
  const bodyText = (msg.body?.content || '').slice(0, 100000);

  const attachments = [];
  const skipped = [];
  const list = await graphGet(`${base}/attachments`);
  for (const a of list.value ?? []) {
    if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || a.isInline) continue;
    if (attachments.length >= MAX_ATTACHMENTS || (a.size || 0) > MAX_ATTACHMENT_BYTES || !a.contentBytes) {
      skipped.push(a.name || 'attachment');
      continue;
    }
    attachments.push({
      filename: a.name || 'attachment',
      mimetype: a.contentType || 'application/octet-stream',
      buffer: Buffer.from(a.contentBytes, 'base64'),
    });
  }
  return { bodyText, attachments, skipped };
}

// Synthetic dev inbox (no MS credentials). One references a complaint ref code
// so ingestion can be verified end-to-end; one stays unmatched.
function devEmails() {
  return [
    {
      graphId: `dev-cemail-1-${process.env.DEV_EMAIL_ADDRESS || process.env.DEV_EMAIL_REFCODE || 'x'}`,
      messageId: '<dev-c1@local>',
      subject: `Re: Missed bin collection [${process.env.DEV_EMAIL_REFCODE || 'GC-C-DEMO01'}]`,
      senderName: 'Liverpool City Council',
      senderEmail: 'complaints@liverpool.gov.uk',
      toAddresses: [
        process.env.DEV_EMAIL_ADDRESS || 'complaint-demo@greenco.co.uk',
        'greenco-caseworker@greenco.co.uk',
      ],
      bodyPreview: 'Thank you for your complaint, we are looking into this and will respond.',
      receivedAt: new Date(),
    },
    {
      graphId: 'dev-cemail-2',
      messageId: '<dev-c2@local>',
      subject: 'Newsletter — March update',
      senderName: 'Some List',
      senderEmail: 'news@example.com',
      toAddresses: ['complaints@greenco.co.uk'],
      bodyPreview: 'Unrelated marketing email that should not match any complaint.',
      receivedAt: new Date(),
    },
  ];
}
