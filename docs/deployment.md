# Hosting PEPL on the ONROL VPS

Written for whoever deploys it, including the version of you that has to fix it
at 2am. Read `../CLAUDE.md` for how the application behaves and
`onrol crm/VPS-OPERATIONS.md` for how this particular box behaves — this file
is only the overlap.

**The box is shared.** Thirteen other applications run on it. Everything below
is scoped so that PEPL cannot take them down.

---

## 1. What was checked before choosing this

| | |
|---|---|
| Node | **v22.22.2** — verified it runs PEPL's `.ts` entrypoints with `--experimental-strip-types`. The Dockerfile says 24 and the VPS has 22; 22.6+ is enough, and it was tested on the box rather than assumed. |
| PostgreSQL | **18.4** on 5432. PEPL is developed against 16 and uses `UNIQUE NULLS NOT DISTINCT` (PG15+), so 18 is fine. |
| Port | **4010 is free.** In use on this box: 3000-3003, 3005, 3010, 3015, 3017, 3020, 3030, 3040, 3051, 3200, 3202, 3400, 3939, 4000, 4100, 4200. |
| Disk | 38 GB free of 199 GB. Enough, not roomy — see storage below. |
| Memory | 15 GB total, ~8.6 GB available, plus a 6 GB swapfile added for other apps' builds. PEPL's Vite build is far smaller than the Next builds that caused the OOM. |

**Not Docker.** PEPL has a Dockerfile and a compose file, and this box runs
everything on pm2 behind OpenLiteSpeed. Following the house pattern beats
introducing a second one on a shared server.

---

## 2. First deploy

### 2.1 Database and roles

PEPL uses three roles on purpose, and the runtime one can neither create tables
nor bypass row-level security. `bootstrap.ts` creates the roles, the database
AND the extensions, and is idempotent — you do not create the database by hand.

**One deviation from `bootstrap.ts` on this box.** PEPL's control-plane pool
wants a "superuser": it needs `BYPASSRLS` to read across tenants and
`CREATEROLE`/`CREATEDB` to provision them. The obvious move is to hand it the
cluster `postgres` password — and on a server running thirteen other
applications, that makes a PEPL compromise reach every one of their databases.

So PEPL gets its own role instead, created once as `postgres`:

```bash
sudo -u postgres /usr/pgsql-18/bin/psql <<'SQL'
CREATE ROLE pepl_control LOGIN PASSWORD '<generated>' CREATEROLE CREATEDB BYPASSRLS;
SQL
```

`SUPER_USER=pepl_control` in `.env`. It can do everything PEPL needs inside the
`pepl` database and nothing at all outside it.

The single thing that genuinely needs a cluster superuser is `CREATE EXTENSION`
(`pgcrypto`, `btree_gist`), run once by hand as `postgres`. `bootstrap.ts`
re-runs those as `IF NOT EXISTS` and passes.

Generated secrets for this box live in `/root/.pepl-secrets` (0600) and the
`.env` beside the app directory. Neither is in the repository.

### 2.2 The app directory

PEPL has no GitHub remote yet, so the box carries a bare repo and is its own
origin. When a real repository exists, add it as a second remote and nothing
else here changes.

```bash
# once, on the VPS
git init --bare -b main /srv/git/pepl.git
mkdir -p /home/pepl.onrol.in
git clone /srv/git/pepl.git /home/pepl.onrol.in/pepl
```

```bash
# once, on the machine that has the code
git remote add vps ssh://root@76.13.242.93/srv/git/pepl.git
git push vps main
```

Anything fixed directly on the box is reverted by the next `git reset --hard`
deploy, so commit it and push it rather than leaving it on the server.

### 2.3 Environment

`.env` in the app directory, mode 600, never committed.

```bash
PGHOST=localhost
PGPORT=5432
PEPL_DB=pepl
SUPER_USER=postgres
SUPER_PASSWORD=...          # the box's postgres password
OWNER_USER=pepl_owner
OWNER_PASSWORD=...          # generate; NOT the .env.example value
APP_USER=pepl_app
APP_PASSWORD=...            # generate; NOT the .env.example value
NODE_ENV=production
PORT=4010
PEPL_PUBLIC_URL=https://pepl.onrol.in
PEPL_MAIL_KEY=...           # openssl rand -hex 32
```

**The server refuses to start in production** if `OWNER_PASSWORD`,
`APP_PASSWORD` or `SUPER_PASSWORD` is still the development value from
`.env.example`, or if `PEPL_DB` points at `pepl_test`. It warns, and starts,
when the mail key, public URL, object store, GSTIN or bank details are missing
— each of those breaks a feature rather than endangering data. See
`src/http/preflight.ts` for exactly what it checks and why.

Invoicing also wants `PEPL_GSTIN`, `PEPL_LEGAL_NAME`, `PEPL_ADDRESS`,
`PEPL_STATE_CODE` and the four `PEPL_BANK_*` variables. Without them every
invoice prints "not a tax invoice" and names no account to pay into.

### 2.4 Start both processes

Two, because a job that takes a minute must not compete with a request that has
to answer in fifty milliseconds.

```bash
cd /home/pepl.onrol.in/pepl
npm ci --no-audit --no-fund
npm run build

pm2 start node --name pepl-api -- --env-file=.env --experimental-strip-types src/http/server.ts
pm2 start node --name pepl-scheduler -i 1 -- --env-file=.env --experimental-strip-types src/jobs/scheduler.ts
pm2 save
```

**Exactly one scheduler.** The jobs are idempotent, but a second copy doubles
every tenant's outbound mail and hammers their IMAP servers for nothing.

### 2.5 Reverse proxy

The front is **OpenLiteSpeed**, not nginx. (`nginx.service` shows "failed" on
this box — it is disabled and harmless.) Add a vhost for `pepl.onrol.in`
proxying to `127.0.0.1:4010`, and let CyberPanel issue the certificate.

The server binds to **127.0.0.1 only**, so it is unreachable from the internet
except through the proxy. That is deliberate; do not change it to 0.0.0.0.

---

## 3. Every deploy after the first

```bash
cd /home/pepl.onrol.in/pepl
git fetch origin && git reset --hard origin/main
bash deploy/pepl-deploy.sh
```

The script builds first and restarts last, so a failed build costs nothing and
a successful one costs about two seconds of downtime. It runs migrations
between the two, and fails loudly rather than starting code whose tables do not
exist.

**Migrations are forward-only.** A schema change is a new numbered file in
`db/migrations/`. Never edit one that has been applied.

---

## 4. Backups

```bash
# crontab -e  — 02:30 IST, before the scheduler's heavier nightly jobs
30 2 * * * /home/pepl.onrol.in/pepl/deploy/pepl-backup.sh >> /var/log/pepl-backup.log 2>&1
```

The script dumps with the **PG18** binaries, verifies the dump is readable and
contains a plausible number of tables, and only then prunes anything older than
30 days. Pruning on a night the dump failed would delete the good ones.

**This is not yet disaster recovery.** The dump lands on the same disk as the
database, which survives a bad migration and does not survive the disk or the
provider. Copy it off the box — object storage, or `rsync` to somewhere else —
before treating this as done.

**Restoring needs root, and that is deliberate.** The dumps are `0600` in a
`0700` directory because they contain salaries, bank accounts and PF/ESI
numbers on a box shared with thirteen other applications. `postgres` therefore
cannot read them, and `sudo -u postgres pg_restore /var/backups/...` fails with
"Permission denied" in a way that reads like a broken backup. Stream it:

```bash
cat /var/backups/pepl/pepl-<stamp>.dump |
  sudo -u postgres /usr/pgsql-18/bin/pg_restore --dbname=<target> --no-owner
```

`--jobs` is not available on a stream. That is the price of the dumps not
being world-readable, and it is worth paying.

A drill was run against a real production dump: every table restored, the
audit hash chain verified with zero broken links, and 157 tables came back
with `FORCE ROW LEVEL SECURITY` still on. Row counts differed from live by
exactly the rows deleted after the dump was taken, which is what a
point-in-time snapshot is supposed to do.

There is a restore drill in the test suite (`test/restore-drill.test.ts`) that
dumps, restores into a scratch database, compares every row count, re-checks
RLS and re-verifies the audit chain. Run the same exercise against a real
backup at least once, or you do not know that you can restore.

---

## 5. Is it healthy?

```bash
curl -s http://127.0.0.1:4010/health/ready    # database reachable, migrations applied
pm2 logs pepl-api --lines 50
pm2 logs pepl-scheduler --lines 50
npm run ops tenants                            # who is on the platform
```

`/health` answers whenever the process is up. `/health/ready` answers only when
it can actually serve — that is the one to point a monitor at.

`deploy/pepl-healthcheck.sh` runs from cron every five minutes and does exactly
that. It is SILENT while healthy, restarts `pepl-api` only after two
consecutive failures, and refuses to restart more than once every 15 minutes —
a blip during a deploy is not a reason to restart, and a restart loop against a
real fault (a full disk, a dead database) turns one incident into a louder one
while hiding the cause. When it gives up it says so in `/var/log/pepl-health.log`.

It was tested by stopping the API on purpose: one failure logged and did not
restart, the second restarted and recovered. A watchdog nobody has watched fire
is an assumption.

**There is still no ALERTING.** The watchdog heals a stuck process and writes a
log; nothing tells a human. Point an uptime service at `https://pepl.onrol.in/health/ready`,
or scrape `/metrics` with the bearer token in `PEPL_METRICS_TOKEN`.

Jobs report failures into their own output and the scheduler logs them at
`warn`. That is how `data.retention` failed silently every night for months, so
read them occasionally, or point something at `/metrics` (bearer token from
`PEPL_METRICS_TOKEN`; loopback-only without one).

---

## 6. Storage

Documents go to Postgres unless an S3-compatible object store is configured.
With 38 GB free on a shared disk, that is a slow leak: every uploaded payslip
attachment and ID proof lands in the database and therefore in every backup.

Set `PEPL_OBJECT_STORE_ENDPOINT / BUCKET / REGION / ACCESS_KEY / SECRET_KEY`
before real customers start uploading. Existing rows keep working — the storage
backend is recorded per document, so old rows read from the database and new
ones from the bucket.

---

## 7. Things that will bite

- **The default `pg_dump`/`psql` are PG13** and cannot talk to the PG18 server.
  Always `/usr/pgsql-18/bin/…`, including under `sudo`, whose `secure_path`
  resolves to `/usr/bin`.
- **`git reset --hard` discards anything edited on the box.** A hotfix applied
  on the server is silently reverted by the next deploy unless it is committed
  to `origin/main`.
- **The deploy key cannot push.** Push from a machine with write credentials.
- **Codex also edits this tree.** Stage only your own paths; never `git add -A`.
- **`npm ci`, not `npm install`** — install rewrites the lockfile on the server
  and the dirty file blocks the next deploy.
