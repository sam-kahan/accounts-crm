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
import { pool, query } from './db/pool.js';
import { requireAuth, requirePermission } from './middleware/auth.js';
import auth from './routes/auth.js';
import companies from './routes/companies.js';
import keyDates from './routes/keyDates.js';
import tasks from './routes/tasks.js';
import dashboard from './routes/dashboard.js';
import organisations from './routes/organisations.js';
import { resumeInterruptedScan, releaseStuckImports, runAutoImport } from './services/pastComplaints.js';
import { getSetting, setSetting } from './services/settings.js';
import { backfillAccountNumbers, searchAccountEmails } from './services/accountNumbers.js';
import complaints from './routes/complaints.js';
import contractors from './routes/contractors.js';
import contractorInvoices from './routes/contractorInvoices.js';
import commissionInvoices from './routes/commissionInvoices.js';
import bounceWebhook from './routes/bounceWebhook.js';
import invoicingWebhook from './routes/invoicingWebhook.js';
import users from './routes/users.js';
import aiUsage from './routes/aiUsage.js';
import search from './routes/search.js';

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
app.use('/api/companies', requireAuth, requirePermission('companies'), companies);
app.use('/api/key-dates', requireAuth, requirePermission('companies'), keyDates);
app.use('/api/tasks', requireAuth, requirePermission('tasks'), tasks);
app.use('/api/organisations', requireAuth, requirePermission('complaints'), organisations);
// Greenco Invoicing calls this when an invoice changes over there. Server to
// server, so it authenticates with the shared integration secret rather than a
// login session — mounted on its own path so no authed route is widened.
app.use('/api/webhooks/invoicing', invoicingWebhook);
// SMTP2GO reports emails the CRM sent that bounced (routes/bounceWebhook.js).
app.use('/api/webhooks/email-bounce', bounceWebhook);

app.use('/api/contractors', requireAuth, requirePermission('commission'), contractors);
app.use('/api/contractor-invoices', requireAuth, requirePermission('commission'), contractorInvoices);
app.use('/api/commission-invoices', requireAuth, requirePermission('commission'), commissionInvoices);
app.use('/api/users', requireAuth, requirePermission('admin'), users);
app.use('/api/ai-usage', requireAuth, requirePermission('admin'), aiUsage);
// Searches only the sections the viewer may see (checked per section inside).
app.use('/api/search', requireAuth, search);
app.use('/api/complaints', complaints); // email-fetch uses a cron key; rest gated in-router
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
  // An oversized or unexpected upload is the user's mistake, not a server
  // fault — multer's own error carries the reason, so say it plainly.
  if (err?.name === 'MulterError') {
    const message =
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large (15 MB maximum).'
        : `Upload rejected: ${err.message}`;
    return res.status(400).json({ error: message });
  }
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }
  // eslint-disable-next-line no-console
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(config.port, () => {
  // An import stopped by this restart is settled (back on the list if nothing
  // was created yet; otherwise the complaint it made is flagged to check), and
  // a past-complaints search stopped by it carries on.
  // Then automatic import, if it is on, carries on with what is waiting.
  // A deploy pauses imports before restarting (scripts/wait-for-imports.mjs),
  // so a pause still standing means this start-up follows a deploy; without
  // one, the server stopped unexpectedly, and an import it cut off counts as
  // a try.
  getSetting('imports_paused')
    .then(async (p) => {
      const deploy = Boolean(p?.until && new Date(p.until) > new Date());
      await setSetting('imports_paused', null, 'start-up'); // that deploy is done
      return releaseStuckImports({ deploy });
    })
    .catch((err) => console.error('  Stuck imports not released:', err.message))
    .then(() => backfillAccountNumbers().catch((err) => console.error('  Account numbers:', err.message)))
    .then(() => searchAccountEmails().catch((err) => console.error('  Account search:', err.message)))
    .then(() => runAutoImport())
    .catch((err) => console.error('  Automatic import could not carry on:', err.message));
  // Emails left as "new" that arrived before their complaint was made, and
  // account numbers kept beside the same number with a digit missing: both
  // tidied (no AI), with the timeline saying what was removed.
  import('./services/complaintEmailProcessor.js')
    .then(async ({ settleEarlierEmails, settleOwnCopies }) => {
      const n = await settleEarlierEmails();
      if (n) console.log(`  Earlier emails marked as background: ${n}`);
      const k = await settleOwnCopies();
      if (k) console.log(`  Copies of emails sent from here filed as ours: ${k}`);
    })
    .catch((err) => console.error('  Earlier emails:', err.message));
  // Complaints against more than one organisation: the email that raised it
  // with the second one is theirs, and each organisation gets its own next
  // step, so a review written before that is written again (once each).
  import('./services/trackContact.js')
    .then(({ linkSupplierEmails }) => linkSupplierEmails())
    .then((n) => n && console.log(`  Emails linked to the organisation they were sent to: ${n}`))
    .then(() => query(
      `SELECT c.id FROM complaints c
        WHERE c.state = 'open' AND EXISTS (SELECT 1 FROM complaint_parties p WHERE p.complaint_id = c.id)
          AND NOT (COALESCE(c.ai_review, '{}'::jsonb) ? 'by_org')`,
    ))
    .then(async ({ rows }) => {
      const { scheduleReview } = await import('./services/complaintReview.js');
      rows.forEach((r, i) => scheduleReview(r.id, 60000 + i * 20000));
      if (rows.length) console.log(`  Reviews to give each organisation its own step: ${rows.length}`);
    })
    .catch((err) => console.error('  Per-organisation steps:', err.message));
  // Organisations whose form filled in a standard figure: that figure was
  // wrongly treated as their own (a debt collector's 8 calendar weeks read
  // as 40 working days — a later deadline). Re-date their open complaints;
  // only those whose dates move are noted and reviewed. Harmless to repeat.
  query(`SELECT id FROM organisations WHERE procedure_sources::text LIKE '%"standard"%'`)
    .then(async ({ rows }) => {
      const { recomputeForOrganisation } = await import('./services/complaintDeadlines.js');
      for (const o of rows) {
        await recomputeForOrganisation(o.id, [], { by: 'Automatic (standard timescales corrected)', reviewAll: false });
      }
    })
    .catch((err) => console.error('  Standard timescales:', err.message));
  import('./services/accountNumbers.js')
    .then(({ removeDigitSlips }) => removeDigitSlips())
    .then((n) => n && console.log(`  Mistyped account numbers removed on ${n} complaint(s)`))
    .catch((err) => console.error('  Mistyped account numbers:', err.message));
  // Documents saved before hashes were kept: hashed so duplicates show once
  // (reading files only; no AI).
  import('./services/attachments.js')
    .then(({ backfillAttachmentHashes }) => backfillAttachmentHashes({ limit: 5000 }))
    .then((n) => n && console.log(`  Documents hashed: ${n}`))
    .catch((err) => console.error('  Document hashes:', err.message));
  resumeInterruptedScan()
    .then((resumed) => resumed && console.log('  Past-complaints search: carrying on after restart'))
    .catch((err) => console.error('  Past-complaints search could not resume:', err.message));
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
