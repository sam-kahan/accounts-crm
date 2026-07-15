import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import session from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { HttpError } from './lib/http.js';
import { pool } from './db/pool.js';
import { requireAuth } from './middleware/auth.js';
import auth from './routes/auth.js';
import companies from './routes/companies.js';
import keyDates from './routes/keyDates.js';
import tasks from './routes/tasks.js';
import dashboard from './routes/dashboard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind nginx (TLS terminates there) — trust the proxy so secure cookies and
// req.ip work correctly.
app.set('trust proxy', 1);

app.use(morgan('dev'));
app.use(express.json());
app.use(
  cors({
    origin(origin, cb) {
      // Allow same-origin / tools with no Origin, and any configured origin.
      if (!origin || config.corsOrigins.length === 0) return cb(null, true);
      return cb(null, config.corsOrigins.includes(origin));
    },
    credentials: true,
  }),
);

const PgSession = connectPgSimple(session);
app.use(
  session({
    store: new PgSession({ pool, tableName: 'session' }),
    name: 'accounts.sid',
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: config.session.secure,
      sameSite: 'lax',
      maxAge: config.session.maxAgeMs,
    },
  }),
);

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'accounts-crm',
    integrations: {
      companies_house: config.companiesHouse.enabled,
      smtp2go: config.smtp.enabled,
    },
  });
});

// Auth endpoints are public (login/logout/me).
app.use('/api/auth', auth);

// Everything else requires a login session.
app.use('/api/companies', requireAuth, companies);
app.use('/api/key-dates', requireAuth, keyDates);
app.use('/api/tasks', requireAuth, tasks);
app.use('/api/dashboard', dashboard); // send-reminders allows a cron key; see route

// 404 for unmatched API routes
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));

// In production, serve the built React SPA (client/dist) for everything else.
const clientDist = join(__dirname, '../../client/dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (_req, res) => res.sendFile(join(clientDist, 'index.html')));
}

// Central error handler
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Accounts CRM API listening on http://localhost:${config.port}`);
  // eslint-disable-next-line no-console
  console.log(
    `  Companies House: ${config.companiesHouse.enabled ? 'enabled' : 'disabled (set COMPANIES_HOUSE_API_KEY)'}`,
  );
  // eslint-disable-next-line no-console
  console.log(
    `  SMTP2GO email:   ${config.smtp.enabled ? 'enabled' : 'disabled (set SMTP_USER/SMTP_PASS)'}`,
  );
});
