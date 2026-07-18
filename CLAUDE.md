# CLAUDE.md — working notes for the Accounts CRM

## Git workflow (IMPORTANT)

- **Always work directly on `main`.** Commit changes straight to `main` and push
  to `origin main`. Do **not** create feature branches and do **not** open pull
  requests — no branches, no PRs, ever. Just commit to `main` and push.
- Keep commits small and descriptive.

## What this is

Internal accounts-department CRM for Greenco, served at **accounts.greenco.co.uk**.
Built module-by-module. The first module tracks limited companies + their key
dates and tasks, with statutory dates from Companies House.

Stack: **Node + Express** (API) · **React + Vite** (UI) · **PostgreSQL**.
Hosted on **Hetzner** (`greenco-web-1`, 178.105.235.25) next to the existing
greenco.co.uk sites — **systemd service** `accounts-crm` on 127.0.0.1:4000 +
**nginx** vhost + **certbot** TLS + **git auto-pull** deploy. NOT Docker (the box
uses bare-metal nginx/systemd/certbot; Docker/Caddy would clash on 80/443). Full
runbook: `deploy/DEPLOY.md`.

## Brand

From the Greenco logo — use these, don't invent colours:
- Green `#a2c533` · Navy `#1e2235`
- Logo/favicon assets live in `client/public/brand/` and `client/public/`.
- CSS design tokens are defined at the top of `client/src/index.css`.

## Architecture & conventions

- **Server** (`server/src/`)
  - ES modules (`"type": "module"`).
  - `config.js` reads env once; integrations expose an `enabled` flag so the app
    degrades gracefully when a key/credential is missing.
  - `db/pool.js` — single `pg` pool; DATE columns come back as `YYYY-MM-DD`
    strings (don't reintroduce Date parsing — it causes timezone drift on due
    dates).
  - `db/migrate.js` runs `db/migrations/*.sql` in order, tracked in
    `schema_migrations`. Add new migrations as `NNN_name.sql`; never edit an
    applied migration.
  - `routes/` — thin Express routers, validated with `zod` via `lib/http.js`
    (`asyncHandler`, `HttpError`, `parse`).
  - `services/` — external integrations (`companiesHouse.js`, `mailer.js`).
- **Client** (`client/src/`)
  - `api.js` is the single fetch layer + shared date helpers.
  - Pages in `pages/`, shared UI in `components/`. Styling is plain CSS with the
    tokens in `index.css` — no CSS framework.
  - Dev proxies `/api` to `:4000` (see `vite.config.js`); in production the
    Express server serves the built SPA.

## Auth

- Individual users in the `users` table (bcryptjs-hashed passwords). Sessions via
  express-session + connect-pg-simple (`session` table). `SESSION_SECRET` required
  in prod; `app.set('trust proxy', 1)` + secure cookies behind nginx TLS.
- All `/api/*` data routes are behind `requireAuth`. Public: `/api/health`,
  `/api/auth/*`. The reminder cron endpoint accepts a session OR
  `?key=REMINDER_CRON_KEY`.
- Manage users: `node server/src/scripts/create-user.mjs <email> [name]`
  (re-run to reset a password). Scripts that hit the API (bulk-import) log in
  with `CRM_EMAIL` / `CRM_PASSWORD`.

## Integrations

- **Companies House** (`COMPANIES_HOUSE_API_KEY`) — company profile + statutory
  dates. Synced dates are stored with `source = 'companies_house'` and upserted
  in place (unique per company+category) so re-syncing never duplicates.
- **SMTP2GO** (`SMTP_USER` / `SMTP_PASS`) — reminder digests via nodemailer.
- Roadmap: Outlook calendar sync (Microsoft Graph), HMRC MTD.
  (No Sage / accounting-package integration planned.)

## Adding a module

1. `server/src/db/migrations/NNN_*.sql`
2. `server/src/routes/<thing>.js` + mount in `server/src/index.js`
3. `client/src/api.js` methods
4. `client/src/pages/<Thing>.jsx` + nav entry in `client/src/App.jsx`

## Verify before committing

- `npm run build -w client` (client compiles)
- `npm run migrate` then exercise the API / UI against a local Postgres.
