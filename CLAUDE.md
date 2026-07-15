# CLAUDE.md — working notes for the Accounts CRM

## Git workflow (IMPORTANT)

- **Work directly on `main`. Do not create feature branches.** Commit changes to
  `main` and push to `origin main`.
- Keep commits small and descriptive.

## What this is

Internal accounts-department CRM for Greenco, served at **accounts.greenco.co.uk**.
Built module-by-module. The first module tracks limited companies + their key
dates and tasks, with statutory dates from Companies House.

Stack: **Node + Express** (API) · **React + Vite** (UI) · **PostgreSQL**.
Hosted on **Hetzner** via Docker Compose (Postgres + app + Caddy/TLS).

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
