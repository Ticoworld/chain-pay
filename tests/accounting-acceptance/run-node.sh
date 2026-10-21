#!/usr/bin/env bash
set -euo pipefail
mkdir -p /workspace
cd /workspace
if [ "${1:-}" = install ]; then
  tar -C /source --exclude=node_modules --exclude=target --exclude=dist --exclude='.env*' --exclude='*.log' \
    -cf - package.json package-lock.json apps/desktop/package.json apps/desktop/tsconfig.json apps/desktop/eslint.config.js \
    apps/desktop/src apps/desktop/electron apps/mobile/package.json packages tests/accounting-acceptance \
    | tar -xf -
  installed=false
  for attempt in 1 2; do
    if npm ci --workspace apps/desktop --workspace packages/shared --ignore-scripts --no-audit --no-fund --maxsockets=5; then
      installed=true
      break
    fi
    printf "Locked install attempt %s failed; retaining npm diagnostics.\n" "$attempt"
    tail -n 40 /root/.npm/_logs/*debug-0.log || true
  done
  [ "$installed" = true ] || exit 1
  exit 0
fi
if [ "${1:-}" != replay ]; then
  node node_modules/typescript/bin/tsc -p tests/accounting-acceptance/tsconfig.json
  node node_modules/eslint/bin/eslint.js --config apps/desktop/eslint.config.js 'tests/accounting-acceptance/*.ts'
fi
node node_modules/vitest/vitest.mjs run --config tests/accounting-acceptance/vitest.config.ts
