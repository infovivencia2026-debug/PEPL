# Running PEPL

What has to be true for a deployment to work, and what to do when it is not.

---

## The three processes

| Process | Command | What breaks without it |
|---|---|---|
| **API** | `node --experimental-strip-types src/http/server.ts` | everything |
| **Scheduler** | `npm run scheduler` | outbound mail never sends, inbound never arrives, SLA breaches go unmarked, the audit chain is never sealed, retention never runs |
| **Postgres** | 16 or later | everything |

The scheduler is a separate process on purpose. A job that takes a minute must
not compete with a request that has to answer in fifty milliseconds, and — more
importantly — **run exactly one of it.** The jobs are idempotent, so a second
copy corrupts nothing, but it doubles the load on every tenant's mail server for
no benefit. If you scale the API to three instances, the scheduler stays at one.

## Environment

| Variable | Required | Notes |
|---|---|---|
| `PGHOST`, `PGPORT` | yes | |
| `SUPER_USER`, `SUPER_PASSWORD` | bootstrap only | creates roles and the database; not a runtime connection |
| `OWNER_USER`, `OWNER_PASSWORD` | migrations only | owns the tables |
| `APP_USER`, `APP_PASSWORD` | yes | **every** runtime query; `NOBYPASSRLS` |
| `PEPL_DB` | yes | the database name |
| `PEPL_MAIL_KEY` | for mail | decrypts stored mailbox passwords |
| `PORT` | no | defaults to 3100 locally, 4010 in the image |

**`PEPL_MAIL_KEY` is a data key, not a password.** Rotating it strands every
stored mailbox credential — the ciphertext becomes undecryptable and every
person has to reconnect their mailbox. Treat it like the database password:
back it up somewhere a lost server does not take with it. The mail jobs check
for it and report its absence rather than failing quietly, so "mail does
nothing" is diagnosable from the job output.

## Probes

| Endpoint | Question | Use for |
|---|---|---|
| `GET /health` | is the process alive? | container restart policy |
| `GET /health/ready` | can it actually serve? | load balancer membership |

Route traffic on **readiness**. Liveness only says the process is running; an
instance whose database is unreachable is running and cannot serve, and a
balancer that cannot tell the difference sends requests into a hole. Readiness
returns `503 NOT_READY` with the reason, and reports the migration count rather
than comparing it against a number baked into the image — during a rolling
deploy the old and new images disagree about what "current" means, and an
instance refusing traffic over that is an outage of its own making.

## Deploying

Migrations run on boot, before the listener starts, so the schema and the code
that expects it arrive together.

```bash
docker compose up -d --build
docker compose logs -f api        # watch the migrations apply
curl -fsS localhost:4010/health/ready
```

**Migrations are forward-only.** Once there is a deployment, a schema change is
a new numbered file in `db/migrations/` — never an edit to an applied one. The
`_migrations` table is the record of what ran; editing an applied file makes
that record a lie.

A migration that would take a long lock on a large table is the one thing to
review by hand before deploying: `ALTER TABLE ... ADD COLUMN` with a default is
fine on PG11+, but an index build is not. Use `CREATE INDEX CONCURRENTLY` in its
own migration, outside a transaction.

## Backups

Nothing here is clever, and that is the point: `pg_dump` output restores into any
Postgres of the same major version, with no tooling of ours in the path.

```bash
# nightly, retained per the customer contract
pg_dump --format=custom --no-owner --dbname="$DATABASE_URL" \
  --file="pepl-$(date -u +%Y%m%dT%H%M%SZ).dump"

# verify it — a backup nobody has restored is a hope, not a backup
createdb pepl_restore_test
pg_restore --no-owner --dbname=pepl_restore_test pepl-*.dump
psql -d pepl_restore_test -c 'SELECT count(*) FROM _migrations'
dropdb pepl_restore_test
```

Restore drill, in full, at least once before launch and once a quarter after:

1. Restore last night's dump into a scratch database.
2. Point a staging API at it with the same `PEPL_MAIL_KEY`.
3. Log in as a seeded account and open a payslip.
4. Check `GET /api/v1/activity/verify` reports an unbroken audit chain.

Step 4 is the one people skip. The audit chain is per tenant and hash-linked; a
restore that silently lost rows shows up there and nowhere else.

**What a database backup does not cover:** `PEPL_MAIL_KEY`. Without it the
restored database has mailbox credentials it cannot read.

## When something is wrong

**Mail is not sending.** Check the scheduler is running and `PEPL_MAIL_KEY` is
set — the job logs `PEPL_MAIL_KEY is not set` and does nothing. Then look at
`mail_commands`: `queued` means waiting, `abandoned` means the server refused it
permanently and the row's `last_error` says why.

```sql
SELECT status, count(*), max(last_error) FROM mail_commands GROUP BY status;
```

**Mail is not arriving.** `mail_accounts.status` and `quarantined_until`. Three
consecutive failures quarantine an account for an hour; an authentication
failure quarantines it immediately and sets `status = 'auth_failed'`, which the
person needs to be told about — they must reconnect.

**A tenant reports data they should not see.** Stop and treat it as an incident.
`npm run gate:rls` verifies the structural guarantee, and the cross-tenant suite
in `test/isolation.test.ts` verifies the behavioural one. If both pass and the
report is real, the leak is in application code that bypassed `withTenant` —
which is why that is the only path to Postgres.

**The process keeps restarting.** `process-guards.ts` deliberately keeps the
process alive for mail and network faults and exits on anything else. An exit
loop therefore means a real bug in our own code, and the log line before it
carries the stack.

## What is not here yet

- **No object storage.** Document bytes live in Postgres behind a `storage`
  column, so a dump contains them and grows accordingly. Moving to S3 is a new
  value in that column and a reader branch, not a migration.
- **No rate limiting** beyond the login attempt lockout.
- **No metrics endpoint.** Logs are structured JSON on stdout; there is no
  Prometheus surface.
- **No multi-region anything.** One database, one scheduler.
