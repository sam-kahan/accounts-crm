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
  - `lib/dates.js` — `todayISO()` returns the **Europe/London** date as
    `YYYY-MM-DD`. Use it for "today"; never `new Date().toISOString().slice(0,10)`
    (that's UTC and reads a day ahead between 00:00–01:00 during BST).
  - `lib/sql.js` — `buildUpdateSet()` builds a partial UPDATE that skips omitted
    fields but lets an explicit `null` clear a nullable column. Use it for PUT
    handlers; don't reintroduce COALESCE-based updates — they can't tell "omitted"
    from "set to null", so a field can never be cleared.
  - **Security**: `index.js` applies `helmet` (CSP/HSTS/nosniff/frameguard) and a
    global per-IP rate limit; login has its own throttle. Attachment downloads are
    forced to `Content-Disposition: attachment` + `nosniff`, and the upload `:id`
    is validated as a UUID before multer writes to disk. `SESSION_SECRET` is a
    hard requirement in prod (the app refuses to start without it).
  - **AI prompts** (`services/complaintAssistant.js`, `orgResearch.js`): wrap any
    third-party text (inbound emails, uploaded docs, pasted notes, researched web
    content) in `<untrusted_content>` markers and treat it as data, never
    instructions; validate/clamp model output before persisting it.
- **Client** (`client/src/`)
  - `api.js` is the single fetch layer + shared date helpers.
  - Pages in `pages/`, shared UI in `components/`. Styling is plain CSS with the
    tokens in `index.css` — no CSS framework.
  - Dev proxies `/api` to `:4000` (see `vite.config.js`); in production the
    Express server serves the built SPA.
  - Date-input defaults use `todayISO()` from `api.js` (UK-local, same reason as
    the server helper). List/detail pages show explicit loading/error/empty
    states with a Retry — a failed fetch must never spin forever.
  - **PWA**: `manifest.webmanifest` + `sw.js` (network-first with an offline
    shell). Icons: `favicon-green-*` (`any`), `icon-maskable-{192,512}` (safe-zone
    padded on navy), `apple-touch-icon.png` (180×180 opaque). A new build's
    service worker triggers a "new version — Reload" toast (`main.jsx`).

## Auth

- Individual users in the `users` table (bcryptjs-hashed passwords). Sessions via
  express-session + connect-pg-simple (`session` table). `SESSION_SECRET` required
  in prod; `app.set('trust proxy', 1)` + secure cookies behind nginx TLS.
- All `/api/*` data routes are behind `requireAuth`. Public: `/api/health`,
  `/api/auth/*`. The unattended jobs (reminder digest, mailbox fetch) accept a
  session OR the cron key — sent as the `X-Cron-Key` header (preferred) or
  `?key=REMINDER_CRON_KEY` (legacy). Compared in constant time; see
  `middleware/auth.js` (`sessionOrCronKey`).
- **Trust model: single-tenant.** Every logged-in user is a Greenco accounts-team
  member and may see/edit every record; there is deliberately no per-user row
  scoping. `requireAuth` is the only authorization boundary. If external or
  role-limited users are ever added, per-record ownership checks must be added to
  every data route.
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

- `npm test` (unit tests in `server/test/`, Node's built-in `node:test` — no
  framework, no DB. Covers the deadline engine, email matching, AI-output
  sanitisation, the `buildUpdateSet` helper, and dates).
- `npm run build -w client` (client compiles)
- `npm run migrate` then exercise the API / UI against a local Postgres.
- CI (`.github/workflows/ci.yml`) re-runs the tests + client build on every push
  to `main`. It's a **signal, not a gate** — auto-pull deploys the moment you
  push, so run the checks locally first.

## Recent changes

### 2026-07-18 — security, correctness & robustness pass
- **Security**: fixed CORS credential reflection on an empty allowlist; added the
  `SESSION_SECRET` prod fail-fast; fixed a login-path process crash (error thrown
  in a `session.regenerate` callback); closed an attachment path-traversal +
  inline-XSS hole; moved the cron key to a constant-time `X-Cron-Key` header
  check; added `helmet` + rate limiting; hardened the AI prompt-injection surface
  (`<untrusted_content>` markers + output validation). Bumped nodemailer 6→9
  (`npm audit` clean).
- **Correctness**: imported-complaint response-due; ref-code collision retry;
  UK-local "today" (BST off-by-one); recurring key dates roll past today; org
  `researched_at` no longer re-stamped on edits; mailbox fetch pages the catch-all
  over a lookback window; nullable fields can be cleared on update.
- **Frontend**: error/retry states everywhere; accessible Modal + keyboard rows;
  surfaced write-action failures; proper PWA icons (from `greenco-site`
  brand-assets) + SW update toast.
- Added the `server/test/` suite and the CI workflow.
