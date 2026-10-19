#!/usr/bin/env bash
set -euo pipefail
cd /home/frappe/frappe-bench
site_name="${1:?site name required}"
admin_password="${2:?admin password required}"
db_password="${3:?database password required}"
bench set-config -g db_host db
bench set-config -gp db_port 3306
bench set-config -g redis_cache redis://redis-cache:6379
bench set-config -g redis_queue redis://redis-queue:6379
bench set-config -g redis_socketio redis://redis-queue:6379
if [ ! -d "sites/$site_name" ]; then
  bench new-site "$site_name" --mariadb-user-host-login-scope=% \
    --db-root-password "$db_password" --admin-password "$admin_password" --install-app erpnext
fi
bench use "$site_name"
if ! bench --site "$site_name" list-apps | grep -qw crypto_payroll; then
  grep -qxF crypto_payroll sites/apps.txt || printf '\ncrypto_payroll\n' >> sites/apps.txt
  bench --site "$site_name" install-app crypto_payroll
fi
bench --site "$site_name" migrate
bench --site "$site_name" execute crypto_payroll.setup.seed.run
bench --site "$site_name" execute crypto_payroll.setup.custom_fields.ensure_custom_fields
