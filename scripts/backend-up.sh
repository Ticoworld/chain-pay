#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/backend-common.sh"

log "Pulling image and starting stack"
dc pull
dc up -d

log "Waiting for MariaDB to be healthy"
status=starting
for i in $(seq 1 30); do
  status="$(docker inspect --format '{{.State.Health.Status}}' chainpay-db 2>/dev/null || echo starting)"
  [ "$status" = "healthy" ] && break
  sleep 3
done
[ "$status" = "healthy" ] || { echo "DB did not become healthy"; exit 1; }

log "Ensuring crypto_payroll editable install is registered in venv (idempotent)"
dc exec -T -u root backend bash -lc 'cd /home/frappe/frappe-bench && ./env/bin/pip install -q -e apps/crypto_payroll'
# bench serve (PID 1) starts before the bind-mount is pip-installed; restart it
# so the fresh .pth is picked up before any bench commands run.
dc restart backend
sleep 3

log "Preparing accounting site"
dc exec -T backend bash -s -- "$SITE_NAME" "$ADMIN_PASSWORD" "$MARIADB_ROOT_PASSWORD" \
  < "$REPO_ROOT/scripts/lib/backend-site-setup.sh"

log "Running smoke checks"
"$REPO_ROOT/scripts/backend-smoke.sh"
