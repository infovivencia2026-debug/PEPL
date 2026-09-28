#!/bin/bash
# PEPL — nightly backup. Runs ON the VPS from cron.
#
# This database holds payroll: salaries, bank accounts, PF and ESI numbers, and
# an audit log that is supposed to be evidence. Losing it is not an outage, it
# is an incident with a statutory dimension, so the backup is verified rather
# than assumed.
#
# 🚨 The default /usr/bin/pg_dump on this box is PG13 and CANNOT dump the PG18
# server — it aborts with "server version mismatch". `sudo -u postgres pg_dump`
# hits the same wall, because sudo's secure_path resolves to /usr/bin. The full
# PG18 path is not optional here.
set -euo pipefail

PGBIN=/usr/pgsql-18/bin
DB="${PEPL_DB:-pepl}"
OUT="${PEPL_BACKUP_DIR:-/var/backups/pepl}"
KEEP_DAYS="${PEPL_BACKUP_KEEP_DAYS:-30}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$OUT/${DB}-${STAMP}.dump"

mkdir -p "$OUT"

echo "==> dumping $DB with $($PGBIN/pg_dump --version)"
# Custom format: compressed, and restorable table-by-table with pg_restore,
# which is what you want at 3am when one table was truncated by mistake.
sudo -u postgres "$PGBIN/pg_dump" --format=custom --file="$FILE" "$DB"

echo "==> verifying the dump is readable"
# A backup nobody has restored is a hope, not a backup. Listing the table of
# contents proves the file is not truncated and pg_restore can parse it —
# cheap enough to run nightly, unlike a full restore.
TABLES="$($PGBIN/pg_restore --list "$FILE" | grep -c 'TABLE DATA' || true)"
if [ "$TABLES" -lt 50 ]; then
  echo "SUSPECT: only $TABLES tables in the dump — PEPL has 150+. Not pruning old backups."
  exit 1
fi
echo "    $TABLES tables, $(du -h "$FILE" | cut -f1)"

echo "==> pruning backups older than ${KEEP_DAYS} days"
# Only after a verified dump: pruning on a night the dump failed would delete
# the good ones and keep nothing.
find "$OUT" -name "${DB}-*.dump" -mtime "+${KEEP_DAYS}" -print -delete

echo "OK: $FILE"

# NOTE: this leaves the backup ON THE SAME DISK as the database. That survives
# a bad migration or a dropped table; it does not survive the disk or the
# provider. Copy it off the box — see docs/deployment.md.
