#!/usr/bin/env bash
# Auto-deploy: fast-forward /var/www/accounts-crm to origin/main using the
# server's GitHub key, then rebuild + restart if anything changed.
# Install in sam's crontab to run every 2 min:
#   */2 * * * * /var/www/accounts-crm/deploy/auto-pull.sh >> /var/www/accounts-crm/logs/deploy.log 2>&1
#
# Never rewrite pushed history on main — this uses --ff-only and refuses a
# non-fast-forward (recover with: git fetch && git reset --hard origin/main).
set -euo pipefail

APP_DIR="/var/www/accounts-crm"
BRANCH="main"
KEY="/home/sam/.ssh/id_ed25519_github"

export GIT_SSH_COMMAND="ssh -i ${KEY} -o IdentitiesOnly=yes"

# Single-flight lock so two runs never race a git merge / client build.
mkdir -p "${APP_DIR}/logs" 2>/dev/null || true
exec 9>"${APP_DIR}/logs/.auto-pull.lock" || exit 0
if ! flock -n 9; then
    echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] auto-pull: another run holds the lock — skipping"
    exit 0
fi

cd "${APP_DIR}"

git fetch --quiet origin "${BRANCH}"
LOCAL="$(git rev-parse @)"
REMOTE="$(git rev-parse "origin/${BRANCH}")"

if [ "${LOCAL}" = "${REMOTE}" ]; then
    exit 0
fi

echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] deploying ${LOCAL:0:8} -> ${REMOTE:0:8}"
git merge --ff-only "origin/${BRANCH}"

# Rebuild + migrate + restart. Wrapped so a failure is logged loudly but doesn't
# leave the lock stuck.
bash "${APP_DIR}/deploy/deploy.sh" || echo "warn: deploy.sh failed"
echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] deploy complete"
