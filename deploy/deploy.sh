#!/usr/bin/env bash
# Build + migrate + restart the Accounts CRM after a deploy.
# Called by deploy/auto-pull.sh, and safe to run by hand.
#
# Requires: Node 20+, a local PostgreSQL, server/.env filled in, and
# passwordless restart of the unit, e.g. in /etc/sudoers.d/accounts-crm:
#   sam ALL=(root) NOPASSWD: /usr/bin/systemctl restart accounts-crm, /usr/bin/systemctl reload accounts-crm
set -euo pipefail

APP_DIR="/var/www/accounts-crm"
cd "${APP_DIR}"

ts() { date -u '+%Y-%m-%dT%H:%M:%SZ'; }

echo "[$(ts)] accounts-crm: install deps"
# Clean, lockfile-exact install. Falls back to `npm install` if no lockfile.
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund; else npm install --no-audit --no-fund; fi

echo "[$(ts)] accounts-crm: build client (memory-capped + de-prioritised)"
# Cap heap + nice the build so a deploy can never exhaust RAM on the shared box
# (see the 2026-06-29 OOM incident in the greenco-site runbook).
NODE_OPTIONS="--max-old-space-size=1024" nice -n 10 npm run build -w client

echo "[$(ts)] accounts-crm: run migrations"
npm run migrate

echo "[$(ts)] accounts-crm: restart service"
sudo systemctl restart accounts-crm

# Self-heal the auto-deploy cron. Preferred home is /etc/cron.d/accounts-crm
# (immune to sibling sites' user-crontab rebuilds); if that's present we do
# nothing. Otherwise, as a bootstrap, ensure a line in the user crontab — though
# a sibling deploy can still strip it, so run `sudo deploy/install-crons.sh`
# once to move to /etc/cron.d permanently.
if [ -f /etc/cron.d/accounts-crm ]; then
  : # managed centrally in /etc/cron.d — nothing to do
elif ! crontab -l 2>/dev/null | grep -q "${APP_DIR}/deploy/auto-pull.sh"; then
  echo "[$(ts)] accounts-crm: auto-pull cron missing — bootstrapping user crontab"
  echo "[$(ts)]   (run 'sudo ${APP_DIR}/deploy/install-crons.sh' to move it to /etc/cron.d)"
  ( crontab -l 2>/dev/null; \
    echo "*/2 * * * * ${APP_DIR}/deploy/auto-pull.sh >> ${APP_DIR}/logs/deploy.log 2>&1" ) | crontab -
fi

echo "[$(ts)] accounts-crm: done"
