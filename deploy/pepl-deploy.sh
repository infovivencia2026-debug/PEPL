#!/bin/bash
# PEPL — production deploy step. Runs ON the VPS, after new code is in place.
#
# Order is the whole point: build, then migrate, then restart. A failed build
# means you simply do not restart, so downtime is the restart itself (~2s) and
# never a broken tree. Migrations run BEFORE the restart because the new code
# expects the new schema; the other order ships code whose tables do not exist.
#
# House rules this box has learned the hard way (see VPS-OPERATIONS.md):
#   - `npm ci`, never `npm install`. install rewrites package-lock.json on the
#     server, leaving a dirty file that blocks the next deploy's checkout.
#   - Build as the directory owner, or .next-style root-owned artefacts appear.
#   - The default pg_dump/psql on this box are PG13 and CANNOT talk to the
#     PG18 server. Always the full /usr/pgsql-18/bin path.
set -euo pipefail

APP_DIR="${PEPL_DIR:-/home/pepl.onrol.in/pepl}"
API_APP="pepl-api"
SCHEDULER_APP="pepl-scheduler"
PORT="${PORT:-4010}"

cd "$APP_DIR"

echo "==> [1/7] npm ci (lockfile-strict, reproducible)"
npm ci --no-audit --no-fund

echo "==> [2/7] typecheck and build the web app"
# The server needs no build — Node runs the .ts entrypoints directly via
# strip-types — but the React app does, and its output is what server.ts
# serves. Without dist/, the API answers fine and every human sees a blank page.
npm run typecheck
npm run typecheck:web
npm run build
test -f dist/index.html || { echo "BUILD FAILED — no dist/index.html, aborting before any restart"; exit 1; }

echo "==> [3/7] snapshot before touching the schema"
# Migrations are forward-only: there is no down script, so the way back from a
# bad one is this file. Taken AFTER the build succeeds (no point dumping for a
# deploy that was never going to land) and BEFORE migrate touches anything.
# A failed dump stops the deploy -- migrating with no way back is the thing
# this is here to prevent.
bash "${APP_DIR}/deploy/pepl-backup.sh"

echo "==> [4/7] database roles, extensions and migrations"
# bootstrap is idempotent and creates the two non-superuser roles. migrate is
# forward-only: a schema change is a NEW numbered file, never an edit to an
# applied one. This is the guardrail — the deploy fails here rather than
# shipping code whose tables do not exist.
node --env-file=.env --experimental-strip-types scripts/bootstrap.ts
node --env-file=.env --experimental-strip-types src/db/migrate.ts

echo "==> [5/7] restart the API"
# --update-env so a changed .env is actually picked up; pm2 caches the
# environment from when the process was first started otherwise.
pm2 restart "$API_APP" --update-env

echo "==> [6/7] restart the scheduler"
# Exactly one instance, always. The jobs are idempotent, but a second copy
# doubles every tenant's outbound mail and hammers their IMAP servers for no
# benefit.
pm2 restart "$SCHEDULER_APP" --update-env

echo "==> [7/7] readiness check"
# /health/ready, not /health: an instance whose database is unreachable is
# running but cannot serve, and a check that cannot tell the difference
# reports success into a hole.
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${PORT}/health/ready" > /dev/null; then
    echo "READY: $(curl -s http://127.0.0.1:${PORT}/health/ready)"
    pm2 save
    exit 0
  fi
  sleep 2
done

echo "NOT READY after 60s — check: pm2 logs ${API_APP} --lines 50"
exit 1
