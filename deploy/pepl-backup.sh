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
# Payroll dumps: salaries, bank accounts, PF and ESI numbers. On a box shared
# with thirteen other applications they are not world-readable.
chmod 700 "$OUT"
umask 077

echo "==> dumping $DB with $($PGBIN/pg_dump --version)"
# Custom format: compressed, and restorable table-by-table with pg_restore,
# which is what you want at 3am when one table was truncated by mistake.
# Streamed to stdout and written by US, not by postgres. --file= would have
# postgres open the path itself, and it cannot write into a root-owned backup
# directory: "could not open output file ... Permission denied". Granting
# postgres write access to the backup directory would fix it the wrong way --
# the dumps are better off owned by root and readable by nobody else.
sudo -u postgres "$PGBIN/pg_dump" --format=custom "$DB" > "$FILE"

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

# ── off the box ──────────────────────────────────────────────────────────────
# A dump on the same disk as the database survives a bad migration and does not
# survive the disk. This step is what turns a backup into disaster recovery.
#
# Configure ONE of these in .env and it starts working; leave them unset and the
# script says so rather than pretending. Deliberately AFTER the verification
# above, so a corrupt dump is never the one that gets copied away.
if [ -n "${PEPL_BACKUP_S3_BUCKET:-}" ]; then
  # Any S3-compatible store: AWS, Backblaze B2, Wasabi, DigitalOcean Spaces.
  # Needs the aws CLI and AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in .env.
  echo "==> copying off the box to s3://${PEPL_BACKUP_S3_BUCKET}"
  aws s3 cp "$FILE" "s3://${PEPL_BACKUP_S3_BUCKET}/$(basename "$FILE")"       ${PEPL_BACKUP_S3_ENDPOINT:+--endpoint-url "$PEPL_BACKUP_S3_ENDPOINT"}       --only-show-errors
  echo "    copied"
elif [ -n "${PEPL_BACKUP_RSYNC_TARGET:-}" ]; then
  # Anything you can ssh to: user@host:/path/to/backups
  echo "==> copying off the box to ${PEPL_BACKUP_RSYNC_TARGET}"
  rsync -a --chmod=600 "$FILE" "${PEPL_BACKUP_RSYNC_TARGET}/"
  echo "    copied"
else
  # Loud on purpose. This is the difference between "we have backups" and
  # "we have backups on the machine we are worried about losing".
  echo "WARNING: no off-box copy configured. This dump lives on the SAME DISK"
  echo "         as the database. Set PEPL_BACKUP_S3_BUCKET or"
  echo "         PEPL_BACKUP_RSYNC_TARGET in .env to fix that."
fi

echo "OK: $FILE"

# NOTE: this leaves the backup ON THE SAME DISK as the database. That survives
# a bad migration or a dropped table; it does not survive the disk or the
# provider. Copy it off the box — see docs/deployment.md.
