# Accounts CRM — Deployment Runbook (Hetzner `greenco-web-1`)

Same model as the greenco-site Next.js app: **systemd service on 127.0.0.1:4000
+ nginx reverse-proxy + certbot TLS + git auto-pull**. Runs alongside the
existing PHP site and Next.js app on the same box, on its own subdomain.

- Server: `ssh sam@178.105.235.25` (`greenco-web-1`, Ubuntu 24.04)
- App path: `/var/www/accounts-crm` · Subdomain: `accounts.greenco.co.uk`
- Service: `accounts-crm` on `127.0.0.1:4000` · nginx site: `accounts-crm`
- Database: **PostgreSQL** (local), db `accounts_crm`, user `accounts`
- Deploy: push to `main` → auto-pull every 2 min → build + migrate + restart

> **Phone-friendly:** Claude writes files into the repo and pushes; you pull them
> onto the box and run the one-liners. Don't paste multi-line blocks into SSH —
> deliver files via `git show origin/main:<path> | sudo tee <dest>`.

---

## Phase 0 — Prerequisites (once)

Node is already on the box (used by greenco-web). Confirm, and check Postgres:
```
node -v; which node; psql --version 2>/dev/null || echo "postgres not installed yet"
```

Install PostgreSQL if missing (Ubuntu 24.04 ships PG 16):
```
sudo apt-get update && sudo apt-get install -y postgresql
```

## Phase 1 — Clone the repo

The box needs read access to the private `sam-kahan/accounts-crm` repo. If the
existing GitHub key (`/home/sam/.ssh/id_ed25519_github`) is your account key it
already works; otherwise add the box's public key as a **Deploy key** on the repo
(GitHub → accounts-crm → Settings → Deploy keys → Add, read-only).

```
sudo mkdir -p /var/www && sudo chown sam:sam /var/www/accounts-crm 2>/dev/null; \
GIT_SSH_COMMAND='ssh -i /home/sam/.ssh/id_ed25519_github -o IdentitiesOnly=yes' \
  git clone -b main git@github.com:sam-kahan/accounts-crm.git /var/www/accounts-crm
```
```
git -C /var/www/accounts-crm config core.sshCommand 'ssh -i /home/sam/.ssh/id_ed25519_github -o IdentitiesOnly=yes'
```

## Phase 2 — Database

Create the DB + user (save the password!):
```
DBPASS="$(openssl rand -hex 20)Aa9_"; echo "SAVE THIS ACCOUNTS-CRM DB PASS: $DBPASS"
```
```
sudo -u postgres psql -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE accounts LOGIN PASSWORD '$DBPASS';" \
  -c "CREATE DATABASE accounts_crm OWNER accounts;"
```
(No superuser/extension needed — the schema uses core `gen_random_uuid()`.)

**Confirm the port.** This box already runs another Postgres on 5432, so the
cluster with our DB is on **5434**. Always use the port from `pg_lsclusters`:
```
pg_lsclusters      # note the PORT column (5434 on greenco-web-1)
```

## Phase 3 — Server env / secrets (gitignored)

```
cp /var/www/accounts-crm/server/.env.example /var/www/accounts-crm/server/.env && chmod 640 /var/www/accounts-crm/server/.env && nano /var/www/accounts-crm/server/.env
```
Set:
- `DATABASE_URL=postgres://accounts:THE-DBPASS@localhost:5434/accounts_crm`
  (use the `$DBPASS` from Phase 2 and the **port from `pg_lsclusters`** — 5434 on
  this box, not the usual 5432; URL-encode any special characters)
- `CORS_ORIGIN=https://accounts.greenco.co.uk`
- `COMPANIES_HOUSE_API_KEY=` your key (or leave blank to add later)
- `SMTP_USER` / `SMTP_PASS` — SMTP2GO (leave blank to add later)
- `REMINDER_TO=sam.kahan@greenco.co.uk`
- `SESSION_SECRET=` — **required for login.** Generate one: `openssl rand -hex 32`
- `REMINDER_CRON_KEY=` — for the nightly reminder cron: `openssl rand -hex 24`

## Phase 4 — First build + migrate

```
cd /var/www/accounts-crm && npm ci && npm run build -w client && npm run migrate
```

## Phase 5 — systemd service

```
git -C /var/www/accounts-crm show origin/main:deploy/accounts-crm.service | sudo tee /etc/systemd/system/accounts-crm.service >/dev/null
```
```
sudo systemctl daemon-reload && sudo systemctl enable --now accounts-crm && systemctl status accounts-crm --no-pager
```
Allow the deploy script to restart it without a password:
```
echo 'sam ALL=(root) NOPASSWD: /usr/bin/systemctl restart accounts-crm, /usr/bin/systemctl reload accounts-crm' | sudo tee /etc/sudoers.d/accounts-crm >/dev/null && sudo chmod 440 /etc/sudoers.d/accounts-crm
```
Local check (before DNS/TLS):
```
curl -s localhost:4000/api/health; echo
```

## Phase 6 — nginx vhost

```
git -C /var/www/accounts-crm show origin/main:deploy/nginx-accounts.conf | sudo tee /etc/nginx/sites-available/accounts-crm >/dev/null
```
```
sudo ln -sf /etc/nginx/sites-available/accounts-crm /etc/nginx/sites-enabled/accounts-crm && sudo nginx -t && sudo systemctl reload nginx
```

## Phase 7 — DNS + TLS

Add a DNS **A record**: `accounts.greenco.co.uk` → `178.105.235.25` (low TTL).
Leave all other greenco.co.uk records untouched. Confirm it resolves:
```
dig +short accounts.greenco.co.uk @1.1.1.1
```
Then issue the certificate (adds the 443 block + redirect automatically):
```
sudo certbot --nginx -d accounts.greenco.co.uk --redirect && sudo nginx -t
```

## Phase 7.5 — Create your login

The app requires a login. Create your user (generates a password and prints it
once; or set your own with `USER_PASSWORD=...`):
```
node /var/www/accounts-crm/server/src/scripts/create-user.mjs sam.kahan@greenco.co.uk "Sam Kahan"
```
Log in at https://accounts.greenco.co.uk with that email + password. Add
colleagues later by re-running with their email; re-running an existing email
resets that user's password.

## Phase 8 — Auto-deploy cron

```
( crontab -l 2>/dev/null | grep -v '/var/www/accounts-crm/deploy/auto-pull.sh'; echo '*/2 * * * * /var/www/accounts-crm/deploy/auto-pull.sh >> /var/www/accounts-crm/logs/deploy.log 2>&1' ) | crontab -
```
(Preserves your existing greenco auto-pull entry; adds this one.)

## Phase 9 — Reminder digest cron (optional)

Emails the upcoming/overdue digest each morning via SMTP2GO. It authenticates
with the `REMINDER_CRON_KEY` you set in `server/.env` (replace `THEKEY`):
```
( crontab -l 2>/dev/null; echo 'CRON_TZ=Europe/London' ; echo '0 8 * * * curl -fsS -X POST "https://accounts.greenco.co.uk/api/dashboard/send-reminders?key=THEKEY" >/dev/null' ) | crontab -
```

## Phase 9b — Complaint email logging (Microsoft Graph) — optional

Logs any email you CC/BCC onto a complaint. Each complaint has its own address,
`complaint-<code>@greenco.co.uk` (shown on the complaint page). A catch-all
routes `complaint-*@greenco.co.uk` into ONE mailbox the app polls; it files each
message against its complaint by matching the exact address (ref code in the
subject is a fallback). This is the same pattern refurb uses for `job-*`.

1. **Mailbox + routing** (Microsoft 365 admin). Two options:
   - *Reuse refurb's setup (fastest):* point `MS_MAILBOX` at the SAME mailbox
     refurb polls. The catch-all already delivers `*@greenco.co.uk` prefixes
     there; the complaints app only files `complaint-*` and ignores the rest.
   - *Separate mailbox (cleaner):* create a shared mailbox e.g.
     `complaints-log@greenco.co.uk` (NOT the real `complaints@`), and have the
     catch-all / mail-flow rule that already handles `job-*` also route
     `complaint-*@greenco.co.uk` into it.
2. **Azure app** — reuse refurb's app registration; it needs the **Mail.Read**
   *application* permission (admin-consented). Note its tenant + client IDs and
   a client secret.
3. **Server env** (`server/.env`, then `sudo systemctl restart accounts-crm`):
   ```
   MS_TENANT_ID=...
   MS_CLIENT_ID=...
   MS_CLIENT_SECRET=...
   MS_MAILBOX=complaints-log@greenco.co.uk   # or refurb's mailbox
   COMPLAINT_EMAIL_PREFIX=complaint-
   COMPLAINT_EMAIL_DOMAIN=greenco.co.uk
   ```
4. **Fetch cron** — poll the mailbox every 5 min (uses `REMINDER_CRON_KEY`):
   ```
   ( crontab -l 2>/dev/null; echo '*/5 * * * * curl -fsS -X POST "https://accounts.greenco.co.uk/api/complaints/email/fetch?key=THEKEY" >/dev/null' ) | crontab -
   ```
   Until this is set, use the **Sync inbox** button on a complaint to poll on
   demand. With no `MS_*` set the app uses a synthetic dev inbox.

## Phase 10 — Verify

- `https://accounts.greenco.co.uk` loads the dashboard over HTTPS.
- Add a company via **Companies House lookup** (needs `COMPANIES_HOUSE_API_KEY`).
- `systemctl status accounts-crm` is active; `journalctl -u accounts-crm -n 50`
  is clean.
- Push a trivial change to `main` and confirm auto-pull redeploys within ~2 min
  (`tail -f /var/www/accounts-crm/logs/deploy.log`).

---

## Day-to-day

- **Deploy:** just push to `main`. Auto-pull builds + migrates + restarts.
- **Logs:** `journalctl -u accounts-crm -f` (app) · `logs/deploy.log` (deploys).
- **Restart:** `sudo systemctl restart accounts-crm`.
- **Change a secret / API key:** edit `server/.env`, then
  `sudo systemctl restart accounts-crm` (no commit, no code change).
- **DB backup:** `pg_dump -U accounts accounts_crm > backup.sql` (add to your
  existing backup routine).
