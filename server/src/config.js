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

  // Microsoft Graph (app-only) — polls the catch-all log mailbox that receives
  // every per-complaint address, and logs each message against its complaint.
  ms: {
    tenantId: process.env.MS_TENANT_ID || '',
    clientId: process.env.MS_CLIENT_ID || '',
    clientSecret: process.env.MS_CLIENT_SECRET || '',
    // The single mailbox the catch-all delivers to (NOT your real complaints@).
    mailbox: process.env.MS_MAILBOX || '',
    get enabled() {
      return Boolean(this.tenantId && this.clientId && this.clientSecret && this.mailbox);
    },
  },

  // Per-complaint catch-all address: <prefix><code>@<domain>, e.g.
  // complaint-71923e@greenco.co.uk. A catch-all rule routes complaint-*@domain
  // into ms.mailbox. Matching is by this exact recipient address (like refurb).
  complaintEmail: {
    prefix: process.env.COMPLAINT_EMAIL_PREFIX || 'complaint-',
    domain: process.env.COMPLAINT_EMAIL_DOMAIN || 'greenco.co.uk',
  },
};

// Build a complaint's unique CC address from its ref code.
export function complaintEmailAddress(refCode) {
  if (!refCode) return null;
  const code = refCode.split('-').pop().toLowerCase(); // GC-C-71923E -> 71923e
  return `${config.complaintEmail.prefix}${code}@${config.complaintEmail.domain}`;
}
