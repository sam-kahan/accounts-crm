import 'dotenv/config';

const bool = (v) => v === 'true' || v === '1';
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  port: Number(process.env.PORT) || 4000,
  corsOrigins: list(process.env.CORS_ORIGIN) || [],
  databaseUrl:
    process.env.DATABASE_URL ||
    'postgres://postgres:postgres@localhost:5432/accounts_crm',

  companiesHouse: {
    apiKey: process.env.COMPANIES_HOUSE_API_KEY || '',
    baseUrl:
      process.env.COMPANIES_HOUSE_BASE_URL ||
      'https://api.company-information.service.gov.uk',
    get enabled() {
      return Boolean(this.apiKey);
    },
  },

  smtp: {
    host: process.env.SMTP_HOST || 'mail.smtp2go.com',
    port: Number(process.env.SMTP_PORT) || 2525,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.REMINDER_FROM || 'Greenco Accounts <accounts@greenco.co.uk>',
    to: list(process.env.REMINDER_TO),
    get enabled() {
      return Boolean(this.user && this.pass);
    },
  },

  session: {
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    // Secure cookies once behind TLS (production). Off locally so login works
    // over plain http://localhost.
    secure: process.env.NODE_ENV === 'production',
    maxAgeMs: 1000 * 60 * 60 * 12, // 12 hours
  },

  // Lets the nightly reminder cron call /api/dashboard/send-reminders without a
  // login session: POST ...?key=<REMINDER_CRON_KEY>.
  reminderCronKey: process.env.REMINDER_CRON_KEY || '',

  // Public base URL, used to build password-reset links in emails.
  appUrl: process.env.APP_BASE_URL || 'https://accounts.greenco.co.uk',

  // Anthropic API — used to research an organisation's complaints procedure.
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    get enabled() {
      return Boolean(this.apiKey);
    },
  },

  // Microsoft Graph (app-only) — polls the domain's shared catch-all mailbox
  // (the same one refurb reads) and logs the messages addressed to a complaint.
  ms: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    // The domain-wide catch-all mailbox where complaint-*@domain lands. This is
    // the existing refurb catch-all — there's only one catch-all per domain.
    mailbox: process.env.MS_MAILBOX || '',
    // How far back to scan the catch-all each poll (days). A window comfortably
    // wider than the gap between cron runs so nothing is missed.
    lookbackDays: Number(process.env.MS_LOOKBACK_DAYS) || 14,
    get enabled() {
      return Boolean(this.tenantId && this.clientId && this.clientSecret && this.mailbox);
    },
  },

  // Where uploaded complaint evidence is stored on disk. Defaults to an
  // `uploads/` dir next to the server (gitignored); override with UPLOAD_DIR.
  uploadDir: process.env.UPLOAD_DIR || 'uploads',

  // Per-complaint address: <prefix><code>@<domain>, e.g.
  // complaint-71923e@greenco.co.uk. It isn't a real mailbox — it falls through
  // to the domain catch-all (ms.mailbox), where we match it by exact recipient.
  complaintEmail: {
    prefix: process.env.COMPLAINT_EMAIL_PREFIX || 'complaint-',
    domain: process.env.COMPLAINT_EMAIL_DOMAIN || 'greenco.co.uk',
  },
};

// Fail fast in production on missing security-critical secrets rather than
// silently falling back to insecure defaults (a forgeable session secret would
// let anyone mint a valid login cookie).
if (process.env.NODE_ENV === 'production') {
  const missing = [];
  if (!process.env.SESSION_SECRET) missing.push('SESSION_SECRET');
  if (missing.length) {
    throw new Error(
      `Refusing to start: ${missing.join(', ')} must be set in production.`,
    );
  }
}

// Build a complaint's unique CC address from its ref code.
export function complaintEmailAddress(refCode) {
  if (!refCode) return null;
  const code = refCode.split('-').pop().toLowerCase(); // GC-C-71923E -> 71923e
  return `${config.complaintEmail.prefix}${code}@${config.complaintEmail.domain}`;
}
