# Greenco Accounts CRM

Internal tool for the Greenco accounts department, served at
**accounts.greenco.co.uk**. Built to grow module-by-module — the first module
tracks our **limited companies and their key dates & tasks**, with statutory
dates pulled automatically from **Companies House**.

- **Stack:** Node + Express (API) · React + Vite (UI) · PostgreSQL
- **Integrations:** Companies House (statutory dates), SMTP2GO (email reminders)
- **Hosting:** Hetzner (`greenco-web-1`) — systemd service + nginx + certbot,
  alongside the existing greenco.co.uk sites. See [`deploy/DEPLOY.md`](./deploy/DEPLOY.md).

---

## What's in it today

| Area | What it does |
|------|--------------|
| **Login** | Individual user accounts (email + password, hashed with bcrypt), server-side sessions. All data is behind login. Manage users with `server/src/scripts/create-user.mjs`. |
| **Dashboard** | The "remind me" view — overdue and upcoming key dates & tasks (next 90 days), plus a one-click email digest. |
| **Companies** | Register of limited companies. Add by searching **Companies House** (auto-imports name, status, **financial year end**, accounts due date, confirmation statement due date) or enter manually. |
| **Key dates** | Statutory / important dates per company (year end, accounts, confirmation statement, VAT, PAYE, corporation tax, custom). Recurring dates roll forward automatically when marked done. |
| **Tasks** | Ad-hoc to-dos, optionally linked to a company, with due date & priority. |
| **Complaints** | Track complaints against councils/suppliers. Auto-computes statutory response deadlines (working days + UK bank holidays), flags ignored/overdue complaints, tells you the next legal step, tracks the ombudsman referral window, and keeps a timeline/evidence trail. Escalation Stage 1 → Stage 2 → Ombudsman. |
| **Organisations** | The bodies you complain to, each with a complaints-procedure profile (ombudsman, timescales, legal basis). Can be **AI-researched** per organisation (Claude + web search) and edited. |
| **PWA** | Installable on phone/desktop (standalone window, Greenco icon, offline app shell). |

## Integrations

| Integration | Status | Notes |
|-------------|--------|-------|
| **Companies House** | ✅ Built | Free API key from the [developer hub](https://developer.company-information.service.gov.uk/). Set `COMPANIES_HOUSE_API_KEY`. Without it the app still works — you just enter dates manually. |
| **SMTP2GO email reminders** | ✅ Built | Set `SMTP_USER` / `SMTP_PASS`. The dashboard "Email me reminders" button (and the `POST /api/dashboard/send-reminders` endpoint) send a digest. |
| **Outlook calendar sync** | ⏳ Roadmap | Push key dates into Outlook via Microsoft Graph (needs an Azure app registration). |
| **HMRC MTD (VAT / Corp Tax)** | ⏳ Roadmap | Pull tax obligations/deadlines. |

---

## Running locally

Prerequisites: Node 20+ and a PostgreSQL 16 server.

```bash
# 1. Install
npm install

# 2. Configure the server
cp server/.env.example server/.env
#   -> set DATABASE_URL, and optionally COMPANIES_HOUSE_API_KEY / SMTP_* 

# 3. Create the schema
npm run migrate

# 4. Run API (:4000) + client (:5173) together
npm run dev
```

Open http://localhost:5173. The Vite dev server proxies `/api` to the API on
:4000.

### Handy scripts

| Command | Does |
|---------|------|
| `npm run dev` | API + client with hot reload |
| `npm run migrate` | Apply pending SQL migrations |
| `npm run build` | Build the client for production |
| `npm start` | Run the API in production (also serves the built client) |

---

## Deployment (Hetzner)

Runs on `greenco-web-1` next to the existing greenco.co.uk sites, using the same
proven pattern as the Next.js app: a **systemd service** (`accounts-crm`) on
`127.0.0.1:4000`, an **nginx** reverse-proxy vhost for `accounts.greenco.co.uk`,
**certbot** for TLS, and **git auto-pull** deploys (push to `main` → rebuild +
migrate + restart within ~2 min). PostgreSQL runs locally.

Full step-by-step (phone-friendly, git-delivered one-liners) is in
**[`deploy/DEPLOY.md`](./deploy/DEPLOY.md)**. Deploy files:
- [`deploy/accounts-crm.service`](./deploy/accounts-crm.service) — systemd unit
- [`deploy/nginx-accounts.conf`](./deploy/nginx-accounts.conf) — nginx vhost
- [`deploy/deploy.sh`](./deploy/deploy.sh) — build + migrate + restart
- [`deploy/auto-pull.sh`](./deploy/auto-pull.sh) — cron-driven git deploy

The reminder digest is sent by a morning cron hitting
`POST /api/dashboard/send-reminders` (see the runbook, Phase 9).

---

## Project layout

```
accounts-crm/
├── server/               Express API + PostgreSQL
│   └── src/
│       ├── db/           pool, migration runner, SQL migrations
│       ├── routes/       companies, key-dates, tasks, dashboard
│       └── services/     companiesHouse, mailer (SMTP2GO)
├── client/               React + Vite SPA (Greenco-branded)
│   └── src/
│       ├── pages/        Dashboard, Companies, CompanyDetail, Tasks
│       └── components/
└── deploy/               systemd unit, nginx vhost, deploy + auto-pull scripts,
                          and DEPLOY.md (the server runbook)
```

## Adding the next module

This is designed to grow. The pattern for a new area (e.g. invoices):
1. Add a migration in `server/src/db/migrations/NNN_*.sql`.
2. Add a route module in `server/src/routes/` and mount it in `index.js`.
3. Add API methods in `client/src/api.js`.
4. Add a page in `client/src/pages/` and a nav entry in `client/src/App.jsx`.

See [`CLAUDE.md`](./CLAUDE.md) for conventions.
