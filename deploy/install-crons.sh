#!/usr/bin/env bash
# Idempotently install the Accounts CRM cron jobs into the current user's
# crontab, WITHOUT disturbing any other app's entries (e.g. greenco-site).
# Safe to re-run; each entry is replaced in place.
#
#   bash /var/www/accounts-crm/deploy/install-crons.sh
#
# Installs:
#   1. auto-deploy   — every 2 min, fast-forward + rebuild + restart on push
#   2. email fetch   — every 5 min, poll the catch-all and log complaint emails
#   3. reminder mail — 08:00 Europe/London daily digest (only if REMINDER_CRON_KEY set)
set -euo pipefail

APP_DIR="/var/www/accounts-crm"
BASE_URL="${APP_BASE_URL:-https://accounts.greenco.co.uk}"
ENV_FILE="${APP_DIR}/server/.env"

# Pull the cron key from the server env (used to authenticate the HTTP crons).
KEY=""
if [ -f "${ENV_FILE}" ]; then
  KEY="$(grep -E '^REMINDER_CRON_KEY=' "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
fi

AUTO_PULL_LINE="*/2 * * * * ${APP_DIR}/deploy/auto-pull.sh >> ${APP_DIR}/logs/deploy.log 2>&1"
FETCH_LINE="*/5 * * * * curl -fsS -X POST \"${BASE_URL}/api/complaints/email/fetch?key=${KEY}\" >/dev/null"
REMIND_LINE="0 8 * * * curl -fsS -X POST \"${BASE_URL}/api/dashboard/send-reminders?key=${KEY}\" >/dev/null"

# Start from the existing crontab minus any of OUR lines (match by unique path).
current="$(crontab -l 2>/dev/null || true)"
filtered="$(printf '%s\n' "${current}" \
  | grep -v "${APP_DIR}/deploy/auto-pull.sh" \
  | grep -v '/api/complaints/email/fetch' \
  | grep -v '/api/dashboard/send-reminders' \
  | grep -v '^CRON_TZ=Europe/London # accounts-crm' || true)"

{
  printf '%s\n' "${filtered}" | sed '/^$/d'
  echo "${AUTO_PULL_LINE}"
  echo "${FETCH_LINE}"
  if [ -n "${KEY}" ]; then
    echo 'CRON_TZ=Europe/London # accounts-crm'
    echo "${REMIND_LINE}"
  fi
} | crontab -

echo "Installed accounts-crm cron jobs:"
crontab -l | grep -E "${APP_DIR}/deploy/auto-pull.sh|/api/complaints/email/fetch|/api/dashboard/send-reminders" || true
[ -z "${KEY}" ] && echo "NOTE: REMINDER_CRON_KEY is blank in ${ENV_FILE} — HTTP crons won't authenticate. Set it and re-run."
exit 0
