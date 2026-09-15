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
| `PEPL_OBJECT_STORE_ENDPOINT`, `_BUCKET`, `_ACCESS_KEY`, `_SECRET_KEY`, `_REGION` | no | S3-compatible bucket for NEW document bytes (S3, R2, MinIO; path-style, SigV4). All four or none — half is refused at the first upload. Region defaults to `us-east-1`. |
| `PEPL_MAIL_IDLE_MAX` | no | IMAP IDLE sockets the scheduler holds open across all tenants (default 50, 0 = off). Mailboxes over the cap are polled every five minutes instead |
| `PEPL_VAPID_PUBLIC_KEY`, `PEPL_VAPID_PRIVATE_KEY`, `PEPL_VAPID_SUBJECT` | for push | Web Push identity. `npm run job push.keygen` prints a pair; subject is a `mailto:` the push services may contact. All three or none. The private key lets anyone push as PEPL — treat it like `PEPL_MAIL_KEY` |
| `PEPL_PUBLIC_URL` | recommended | The address employees open, e.g. `https://hr.yourcompany.com`. Used to build password-reset links; without it the request's Host header is used, which a proxy can get wrong |
| `PEPL_RATE_LIMIT_STORE` | with 2+ API instances | `postgres` shares rate-limit counters across instances (one UPSERT per request on an UNLOGGED table, fails open). Default `memory` is exact for one instance and wrong for two: the limit doubles and lockouts depend on which instance answers |
| `PEPL_METRICS_TOKEN` | no | bearer token for `GET /metrics`; without it the endpoint answers loopback only |
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
| `GET /metrics` | how is it doing? | Prometheus scrape — requests by route pattern and status class, latency histogram, rate-limit rejections, job outcomes, SSE connections, memory |

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

**A data-subject request (DPDP Act).** A copy: `GET /api/v1/employees/:id/data-export`
— the person can pull their own from their profile; payroll can pull anyone's,
and either is logged as `data.export.completed`. Erasure:
`POST /api/v1/employees/:id/erase` anonymises the person (name, login, bank,
statutory ids, declarations, documents, coordinates, devices) and KEEPS the
payroll ledger, which the Income-tax Act requires for eight years. It is
refused until `privacy.erasure_after_days` after the last working day;
`GET …/erasure-eligibility` says when.

**Someone forgot their password.** `POST /api/v1/auth/forgot-password` emails a
30-minute single-use link — through the company's notification sender mailbox,
so a company that has not connected one gets nothing. For those, an admin with
`roles.write` issues a link from the person's user record
(`POST /api/v1/users/:id/password-reset-link`) and hands it over; issuing one is
logged as a security event. A reset signs the person out everywhere.

**Mail arrives late.** IDLE is running in the scheduler when the start-up log
says `imap idle watchers started`; each push logs `idle sync`. A mailbox over
`PEPL_MAIL_IDLE_MAX` or on a server without IDLE waits for the five-minute poll,
which is slow, not broken. A watcher that drops logs `idle reconnecting` with
the backoff; one that logs `idle gave up` hit a permanent auth failure and the
person has to reconnect.

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

## Object storage

Documents carry their own `storage` (`db` or `object`) and `storage_key`, so
turning the bucket on is a deploy, not a migration: rows written before keep
reading from Postgres, rows written after read from the bucket. Keys are
`tenants/<tenant_id>/documents/<id>`. Every read re-checks the SHA-256 recorded
in the database, whichever backend served the bytes — the bucket is a different
trust boundary. Turning the bucket OFF while object rows exist makes those
documents fail to open with `OBJECT_STORE_MISCONFIGURED`; migrate them back
first or leave it on.

The client is hand-rolled SigV4 over fetch and is proven against a fake bucket
that re-derives the signature; it has not yet been run against a real S3
endpoint from this machine.

## Professional tax by state

`npm run seed:statutory` loads `db/reference/pt-slabs.ts` — slabs for the 22
states that levy professional tax, and a list of the 14 that do not — into
`pt_slabs`, effective from the current fiscal year (or a date you pass). It is
REFERENCE DATA: the commonly published slabs as of the `verifiedOn` date on
each state. States amend by notification, often around April; before paying
anyone in a state, reconcile its entry against the current notification, edit
the file, and re-run the seed — it replaces that effective date and closes the
previous set the day before. `GET /api/v1/statutory/pt-states` shows what is
loaded and when each state was last checked; `gate:launch` fails when a PT
state has no slabs in force or a tenant has chosen a state without any.

Two states need care the model does not give them: Maharashtra exempts women
up to ₹25,000 (PEPL applies the general slab), and Tamil Nadu / Kerala assess
half-yearly by local body (PEPL deducts the monthly equivalent).

## Push notifications

Web Push (RFC 8030/8291/8292), no APNs or FCM account: the browser vendor's push
service relays ciphertext it cannot read, and PEPL proves itself with the VAPID
keypair. Works in Chrome, Edge, Firefox and Safari 16+ (iOS needs the site
added to the home screen). A person opts in per device; nothing is sent to a
device that did not.

The `notifications.push` job runs every minute in the scheduler when the keys
are set, and is left out (logged once at start-up) when they are not. A
subscription that answers 404/410, or fails five passes in a row, is deleted.
`notifications.pushed_at` is the delivery fact, as `emailed_at` is for email.

**Push is quiet.** Check the scheduler log for `push off`; check the company
has `notifications.push_enabled` on; check the person has a row in
`push_subscriptions`. Browsers rotate subscriptions — the UI must re-POST on
`pushsubscriptionchange`.

## What is not here yet

- **No multi-region anything.** One database, one scheduler. Two or more API
  instances behind a balancer are fine with `PEPL_RATE_LIMIT_STORE=postgres`; the
  SSE bus is still per instance, so a browser sees events from the instance it is
  connected to — run the scheduler as one copy and pin event streams if you scale out.
