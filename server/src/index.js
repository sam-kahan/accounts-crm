import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
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
import organisations from './routes/organisations.js';
import complaints from './routes/complaints.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Behind nginx (TLS terminates there) — trust the proxy so secure cookies and
// req.ip work correctly.
app.set('trust proxy', 1);

// Security headers. The SPA loads only same-origin, hashed JS/CSS (no inline
// scripts), so a strict script-src is safe; inline styles come from React
// `style={}` props, hence 'unsafe-inline' for styles only.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'self'"],
        baseUri: ["'self'"],
      },
    },
    // TLS terminates at nginx; the browser still gets the app over HTTPS.
    crossOriginEmbedderPolicy: false,
  }),
);

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));

// A generous global rate limit as a blunt abuse backstop (per IP). Real login
// throttling is finer-grained in routes/auth.js. Health check is exempt.
app.use(
  '/api',
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
  }),
);
app.use(
  cors({
    origin(origin, cb) {
      // No Origin header = same-origin request or a non-browser tool; allow.
      if (!origin) return cb(null, true);
      // Otherwise only allow explicitly configured origins. Never reflect an
      // arbitrary origin back while credentials are enabled — an empty
      // allowlist means "same-origin only", not "allow everyone".
      if (config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
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
app.use('/api/organisations', requireAuth, organisations);
app.use('/api/complaints', complaints); // email-fetch uses a cron key; rest requireAuth in-router
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
