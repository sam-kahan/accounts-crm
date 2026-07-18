#!/usr/bin/env bash
# Install the Accounts CRM cron jobs into /etc/cron.d/accounts-crm (NOT sam's
# personal crontab). This matters because several sites on this box share sam's
# user crontab, and some sites' deploy scripts "repair" that crontab by deleting
# every line matching `deploy/auto-pull.sh` — which silently removes OTHER
# sites' auto-deploy jobs. A file in /etc/cron.d is owned by root, read directly
# by cron, and untouched by those user-crontab rebuilds, so it can't disappear.
#
#   sudo bash /var/www/accounts-crm/deploy/install-crons.sh
#
# Idempotent: safe to re-run. Requires root (writes /etc/cron.d).
set -euo pipefail

APP_DIR="/var/www/accounts-crm"
BASE_URL="${APP_BASE_URL:-https://accounts.greenco.co.uk}"
CRON_FILE="/etc/cron.d/accounts-crm"
RUN_USER="${CRON_USER:-sam}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Please run with sudo: sudo bash $0" >&2
  exit 1
fi

# The HTTP crons read REMINDER_CRON_KEY from server/.env at run time, so no
# secret is stored in this (root-owned) file.
KEYCMD="\$(grep -m1 '^REMINDER_CRON_KEY=' ${APP_DIR}/server/.env | cut -d= -f2-)"

cat > "${CRON_FILE}" <<EOF
# Accounts CRM scheduled jobs — managed by ${APP_DIR}/deploy/install-crons.sh
# In /etc/cron.d (not a user crontab) so sibling sites' crontab rebuilds can't
# delete these. Each field-6 value is the user to run as.
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CRON_TZ=Europe/London
# Auto-deploy: fast-forward + rebuild + migrate + restart on any push to main.
*/2 * * * * ${RUN_USER} ${APP_DIR}/deploy/auto-pull.sh >> ${APP_DIR}/logs/deploy.log 2>&1
# Poll the shared catch-all mailbox and log complaint emails (every 5 min).
# The key goes in a header (not the URL) so it doesn't land in access logs.
*/5 * * * * ${RUN_USER} curl -fsS -X POST -H "X-Cron-Key: ${KEYCMD}" "${BASE_URL}/api/complaints/email/fetch" >/dev/null
# Daily reminder digest at 08:00 Europe/London (key dates, tasks, complaints).
0 8 * * * ${RUN_USER} curl -fsS -X POST -H "X-Cron-Key: ${KEYCMD}" "${BASE_URL}/api/dashboard/send-reminders" >/dev/null
EOF
chmod 644 "${CRON_FILE}"

# Remove any accounts-crm lines from ${RUN_USER}'s PERSONAL crontab so the two
# schedulers don't double up now that /etc/cron.d owns them.
sudo -u "${RUN_USER}" bash -c "crontab -l 2>/dev/null \
  | grep -v '${APP_DIR}/deploy/auto-pull.sh' \
  | grep -v '/api/complaints/email/fetch' \
  | grep -v '/api/dashboard/send-reminders' \
  | crontab -" || true

echo "Installed ${CRON_FILE}:"
cat "${CRON_FILE}"
echo
echo "Removed any duplicate accounts-crm lines from ${RUN_USER}'s personal crontab."
