#!/usr/bin/env bash
set -euo pipefail
cd /home/frappe/frappe-bench
./env/bin/python -m doctest /acceptance/http-diagnostics.py
cp -a /opt/chainpay-app apps/crypto_payroll
./env/bin/pip install --no-deps --no-build-isolation -e apps/crypto_payroll
bash /opt/backend-site-setup.sh accounting-acceptance.localhost disposable-acceptance-only disposable-acceptance-only
cd sites
../env/bin/python /acceptance/users.py
