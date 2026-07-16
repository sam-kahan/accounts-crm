import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Microsoft Graph transport for reading a shared mailbox (app-only / client
// credentials), mirroring the refurb-manager setup. When MS_* env is not set,
// returns a couple of synthetic dev emails so the ingestion pipeline can be
// exercised without live credentials. Production sets the env and reads real
// mail. Requires the Azure app to have Mail.Read application permission.
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
  const url =
    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(config.ms.mailbox)}/messages` +
    '?$top=40&$orderby=receivedDateTime desc' +
    '&$select=id,internetMessageId,subject,from,toRecipients,ccRecipients,bccRecipients,bodyPreview,receivedDateTime';
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Graph messages request failed: ${res.status}`);
  const json = await res.json();
  return (json.value ?? []).map(normalise);
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
