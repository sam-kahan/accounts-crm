# Greenco Accounts CRM

Internal tool for the Greenco accounts department, served at
**accounts.greenco.co.uk**. Built to grow module-by-module — the first module
tracks our **limited companies and their key dates & tasks**, with statutory
dates pulled automatically from **Companies House**.

- **Stack:** Node + Express (API) · React + Vite (UI) · PostgreSQL
- **Integrations:** Companies House (statutory dates), SMTP2GO (email reminders)
- **Hosting:** Docker Compose on Hetzner, TLS via Caddy

---

## What's in it today

| Area | What it does |
|------|--------------|
| **Dashboard** | The "remind me" view — overdue and upcoming key dates & tasks (next 90 days), plus a one-click email digest. |
| **Companies** | Register of limited companies. Add by searching **Companies House** (auto-imports name, status, accounts due date, confirmation statement due date) or enter manually. |
| **Key dates** | Statutory / important dates per company (accounts, confirmation statement, VAT, PAYE, corporation tax, custom). Recurring dates roll forward automatically when marked done. |
| **Tasks** | Ad-hoc to-dos, optionally linked to a company, with due date & priority. |

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

The whole stack runs via Docker Compose: Postgres + the app (API + built SPA) +
Caddy for automatic HTTPS.

```bash
# On the Hetzner box, with DNS accounts.greenco.co.uk -> this server's IP:
cp .env.production.example .env.production   # then fill it in
docker compose --env-file .env.production up -d --build
```

Caddy provisions and renews the Let's Encrypt certificate automatically. See
[`docker-compose.yml`](./docker-compose.yml) and
[`deploy/Caddyfile`](./deploy/Caddyfile).

To send the reminder digest on a schedule, add a cron entry on the host:

```
0 8 * * *  curl -fsS -X POST https://accounts.greenco.co.uk/api/dashboard/send-reminders
```

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
├── deploy/               Caddyfile
├── Dockerfile            multi-stage build (client) + runtime (server)
└── docker-compose.yml    db + app + caddy
```

## Adding the next module

This is designed to grow. The pattern for a new area (e.g. invoices):
1. Add a migration in `server/src/db/migrations/NNN_*.sql`.
2. Add a route module in `server/src/routes/` and mount it in `index.js`.
3. Add API methods in `client/src/api.js`.
4. Add a page in `client/src/pages/` and a nav entry in `client/src/App.jsx`.

See [`CLAUDE.md`](./CLAUDE.md) for conventions.
