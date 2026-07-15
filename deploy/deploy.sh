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

echo "[$(ts)] accounts-crm: done"
