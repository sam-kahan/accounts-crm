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

async function getAppToken() {
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
  return json.access_token;
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
  };
}

export async function fetchMailboxMessages() {
  if (!config.ms.enabled) return devEmails();

  const token = await getAppToken();
  // The catch-all is a firehose, so a single $top=100 page can miss a complaint
  // email that's already been buried between cron runs. Instead pull everything
  // within a lookback window and follow @odata.nextLink across pages (capped),
  // so nothing in the window is dropped even on a busy mailbox.
  const since = new Date(
    Date.now() - (config.ms.lookbackDays || 14) * 86400000,
  ).toISOString();
  const select =
    'id,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,receivedDateTime';
  let url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.ms.mailbox)}/messages` +
    `?$top=50&$orderby=receivedDateTime desc` +
    `&$filter=receivedDateTime ge ${since}` +
    `&$select=${select}`;

  const out = [];
  for (let page = 0; page < 40 && url; page += 1) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Graph messages request failed: ${res.status}`);
    const json = await res.json();
    for (const m of json.value ?? []) out.push(normalise(m));
    url = json['@odata.nextLink'] || null;
  }
  return out;
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
