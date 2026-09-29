#!/bin/bash
# PEPL — watchdog. Runs from cron every few minutes.
#
# /health/ready, not /health: a process that is up but cannot reach its
# database is running and unable to serve, and a check that cannot tell the
# difference reports success into a hole.
#
# It restarts only after TWO consecutive failures, and at most once every
# RESTART_COOLDOWN seconds. A single blip during a deploy is not a reason to
# restart, and a restart loop against a real fault (a full disk, a dead
# database) turns one incident into a louder one while hiding the cause.
set -uo pipefail

# cron has almost no environment. Without this the alert settings are invisible
# here even though they are set for the app.
APP_ENV="${PEPL_DIR:-/home/pepl.onrol.in/pepl}/.env"
# shellcheck disable=SC1090
[ -r "$APP_ENV" ] && set -a && . "$APP_ENV" && set +a

# Tell a human. The watchdog can heal a stuck process; it cannot decide that a
# full disk needs someone. Until this is configured the only record is a log
# nobody reads, which is how data.retention failed nightly for months.
#
# Set ONE of these in .env:
#   PEPL_ALERT_WEBHOOK  a Slack/Discord/Teams incoming webhook URL
#   PEPL_ALERT_EMAIL    an address, delivered with the system mailer
notify() {
  local message="$1"
  if [ -n "${PEPL_ALERT_WEBHOOK:-}" ]; then
    curl -sf -m 10 -X POST "$PEPL_ALERT_WEBHOOK"       -H 'Content-Type: application/json'       -d "$(printf '{"text":"%s"}' "$message")" > /dev/null || true
  fi
  if [ -n "${PEPL_ALERT_EMAIL:-}" ] && command -v mail > /dev/null 2>&1; then
    printf '%s
' "$message" | mail -s "PEPL alert" "$PEPL_ALERT_EMAIL" || true
  fi
}

PORT="${PORT:-4010}"
STATE=/var/lib/pepl-health
COOLDOWN="${RESTART_COOLDOWN:-900}"
mkdir -p "$STATE"
FAILS="$STATE/consecutive-failures"
LAST="$STATE/last-restart"
now=$(date +%s)
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

if curl -sf --max-time 10 "http://127.0.0.1:${PORT}/health/ready" > /dev/null; then
  # The VALUE, not whether the file exists: the file holds "0" after every
  # healthy run, so a -s test announced a recovery every few minutes for ever.
  prior=$(cat "$FAILS" 2>/dev/null || echo 0)
  [ "${prior:-0}" -gt 0 ] 2>/dev/null && echo "$stamp RECOVERED after $prior failure(s)"
  echo 0 > "$FAILS"
  exit 0
fi

n=$(( $(cat "$FAILS" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAILS"
echo "$stamp UNHEALTHY (consecutive failure $n): $(curl -s --max-time 10 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/health/ready")"

[ "$n" -lt 2 ] && exit 1

since=$(( now - $(cat "$LAST" 2>/dev/null || echo 0) ))
if [ "$since" -lt "$COOLDOWN" ]; then
  echo "$stamp NOT restarting: last restart was ${since}s ago (cooldown ${COOLDOWN}s). Something is actually wrong — look at it."
  exit 1
fi

echo "$stamp restarting pepl-api"
echo "$now" > "$LAST"
pm2 restart pepl-api --update-env 2>&1 | tail -2
sleep 10
if curl -sf --max-time 10 "http://127.0.0.1:${PORT}/health/ready" > /dev/null; then
  echo "$stamp restart worked"
  echo 0 > "$FAILS"
else
  echo "$stamp STILL UNHEALTHY after a restart — this needs a human: pm2 logs pepl-api --lines 80"
  notify "PEPL is down and a restart did not fix it. pm2 logs pepl-api --lines 80"
fi
