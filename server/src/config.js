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
};
