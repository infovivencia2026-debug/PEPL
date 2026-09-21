# PEPL — working notes

Environment gotchas learned the hard way. Add to this rather than rediscovering them.

## Gates

```
npm run verify     # the whole chain, in order — use this before claiming anything works
  npm run typecheck    tsc --noEmit
  npm run db:setup     roles + database + extensions (superuser, idempotent)
  npm run migrate      forward-only SQL migrations (owner role)
  npm run gate:rls     structural isolation gate — fails on an unprotected table
  npm run gate:config  registry invariants — labels, defaults, deps, cycles, risk classes,
                       AND that every setting is read by code somewhere
  npm run gate:permissions  every permission is asserted by a route and held by a role
  npm test             vitest: all suites
  npm run gate:launch  launch readiness — 22 checks against the live database
```

`npm run db:reset` drops the dev database so migrations re-apply from scratch. **Pre-launch only.**
Once PEPL has a deployment, migrations are forward-only and a schema change is a NEW numbered file.

`npm run verify` is what a CI job runs. Nothing is "done" until it is green **in one run after the final edit**.

## Local Postgres

Two servers are running on this machine — **16 and 18** — and `localhost:5432` resolves to **16.14**.
Credentials for local dev live in `.env` (gitignored); `.env.example` documents the shape.

Existing databases on this box belong to other projects (`onrol*`, `tourz*`, `unfold*`, …).
**PEPL only ever touches `pepl_test`.** Never run a migration or a TRUNCATE without checking
which database the connection points at.

```bash
# read-only poke at the dev database
PGPASSWORD=pepl_owner_dev psql -h localhost -U pepl_owner -d pepl_test -c '\dt'
```

## Three database roles, and why

| Role | Use | Note |
|---|---|---|
| `postgres` (superuser) | bootstrap, extensions, **control-plane provisioning** (creating tenants) | bypasses RLS by definition — never a runtime connection |
| `pepl_owner` | migrations / DDL only | owns the tables; `FORCE ROW LEVEL SECURITY` applies to it too |
| `pepl_app` | **every** runtime query | `NOBYPASSRLS`, owns nothing, holds DML only |

Creating a tenant row is a control-plane operation, so the test fixtures provision through the
superuser pool. Everything else — including seeding employees — goes through `withTenant` on the
app role, so the seed itself exercises the `WITH CHECK` path instead of bypassing it.

## Tenant context

`src/db/tenant-tx.ts` is the **only** way application code reaches Postgres. It cannot be called
without a tenant id. It uses `set_config('app.tenant_id', $1, true)` — `SET LOCAL`, per transaction —
because PgBouncer in transaction-pooling mode does not preserve session state between transactions.
A connection-scoped tenant would leak across tenants intermittently under load, which is the worst
possible failure mode: rare, load-dependent, and silent.

`current_tenant()` returns NULL when unset, so `tenant_id = NULL` fails the policy and a missing
context yields **zero rows, never all rows**. Do not invert that default.

## Windows gotchas

- **Main-module guard.** `import.meta.url === \`file://${process.argv[1]}\`` is always false here:
  argv[1] is a backslash path, import.meta.url is a percent-encoded file URL. Use
  `pathToFileURL(process.argv[1]).href`. Symptom is a script that runs and silently does nothing.
- **Heredocs in the Bash tool** choke on TypeScript containing nested quotes and template literals.
  Write source files with the Write tool; keep heredocs for short SQL and shell.
- `--experimental-strip-types` runs the `.ts` entrypoints directly on Node 24; no build step.
- **No TypeScript parameter properties** (`constructor(readonly code: string)`) in `src/`.
  Strip-only mode ERASES types, it does not transform, so a parameter property is a syntax
  error there — while vitest (esbuild) accepts it happily. The failure therefore appears
  only when a `scripts/` gate imports the module, long after the tests were green. Declare
  the field and assign it in the constructor body.

## Testing discipline

- `verify` loads the PT reference seed **after** tests and before the launch gate.
  Payroll suites deliberately truncate `pt_slabs`; seeding before them leaves the
  new PT coverage launch check with fixture data instead of the reference set.
  Keep `PEPL_DB=pepl_test` for this verification chain.

- `fileParallelism: false` in `vitest.config.ts` — the suites share one database and TRUNCATE in
  setup, so parallel files would race each other's fixtures.
- **Never run two `npm test` processes at once.** `fileParallelism: false` serialises files WITHIN a
  run; it does nothing across runs. A second run TRUNCATEs the first run's fixtures mid-test and the
  symptom is ~27 confusing auth failures in `api.test.ts` ("login failed for …"), which reads exactly
  like a real regression. Before believing a red suite, check no other run is in flight — including a
  backgrounded one you started yourself.
- **Two agents share this tree.** With Codex working in the same checkout, the
  overlapping-run hazard above is no longer hypothetical: it happened, and it
  presented as FK violations on `tenants` inside a suite's own `beforeAll`, on
  different tests each run. Before believing a red suite, LOOK:

  ```powershell
  Get-CimInstance Win32_Process |
    Where-Object { $_.CommandLine -match 'vitest|npm run verify|npm test' } |
    Select-Object ProcessId, CommandLine
  ```

  A `cmd.exe /c npm run typecheck && npm run db:setup && ...` row is a `verify` in
  flight. Wait for it. Do not "fix" the config — `fileParallelism: false` was never
  the problem, and `singleFork` made the symptoms worse without touching the cause.

- **Mutation-test the gates.** A green isolation suite proves nothing until you have watched it go
  red. Both gates were verified this way:

  ```bash
  # weaken the policy -> 11 of 16 tests must fail
  psql ... -c "DROP POLICY tenant_isolation ON employees;
               CREATE POLICY tenant_isolation ON employees USING (true) WITH CHECK (true);"
  npm test
  # restore
  psql ... -c "DROP POLICY tenant_isolation ON employees;
               CREATE POLICY tenant_isolation ON employees
                 USING (tenant_id = current_tenant()) WITH CHECK (tenant_id = current_tenant());"

  # add an unprotected table -> gate:rls must exit 1
  psql ... -c "CREATE TABLE forgotten_table (tenant_id uuid, id uuid PRIMARY KEY, note text);"
  npm run gate:rls
  psql ... -c "DROP TABLE forgotten_table;"
  ```

  The config layer was mutation-tested the same way: removing the entitlement check in
  `resolver.ts` fails exactly the two tests that assert a tenant setting cannot widen an
  entitlement.

  Re-run these whenever the isolation model changes.

## The test database is migrated separately

`npm run migrate` targets `PEPL_DB` from `.env` (`pepl_dev`). Vitest pins
`PEPL_DB=pepl_test` in `vitest.config.ts`, so a NEW migration must be applied twice:

```bash
npm run migrate                 # dev
PEPL_DB=pepl_test npm run migrate   # test
```

Skipping the second one fails as `relation x does not exist` in every suite that
touches the new table, which reads like a broken migration and is not.

## Bash heredocs and backslashes

A quoted heredoc (`<<'EOF'`) in this shell still COLLAPSES `` to ``, so a JS
regex written through one silently becomes a backspace character and matches nothing.
Symptom: a generator script that runs cleanly and produces empty output. Use the Write
tool for source containing regex escapes, or a character class instead of ``.
Large TypeScript files with nested quotes fail outright — CLAUDE.md already says this;
it applies to `src/http/routes/*.ts` too.

## Suites must not touch shared control-plane state (the old "intermittent" failure)

`realtime.test.ts` used to run `DELETE FROM control_plane.subscriptions` in its
setup. That table is shared by every suite's tenants, so the failure it caused
depended on file order — which is why it looked intermittent and went
unattributed for weeks. Adding one unrelated test file changed the order and made
it reproducible: 463 passed, 17 skipped, exit 1.

The rule: **a suite may truncate only what it owns.** `resetAndSeed()` in
fixtures.ts is the sanctioned reset; anything beyond it — especially the
`control_plane` schema — is somebody else's fixture.

A suite that provisions its own tenant should assert the tenant exists before
using it, so the failure names the cause instead of surfacing three statements
later as a foreign-key violation.

## Realtime

`src/realtime/bus.ts` is in-process pub/sub; `src/realtime/sse.ts` is the stream;
`src/realtime/relay.ts` forwards every publish through Postgres `LISTEN/NOTIFY`
so a second API instance (and the scheduler's jobs) reach the same browsers.
The bus never imports pg — the relay installs itself with `setRelay`, and
`server.ts` / `scheduler.ts` start it. Event ids are wall-clock milliseconds,
not a counter, so `Last-Event-ID` from one instance means the same thing on
another; tests must not hardcode `1, 2, 3`. `pg_notify` caps a payload at
8000 bytes — an event carries ids and badge counts, never a document.
Two rules hold the guarantees:

- **Publish AFTER commit.** Routes call `ctx.publish(event)`, which QUEUES it;
  `authed()` flushes the queue once `withTenant` returns, i.e. once the COMMIT
  has happened. Publishing inline would announce a message that a later error
  rolls back, and a browser cannot un-see it.
- **The bus is keyed by tenant**, with an optional user list inside it. An event
  cannot cross a company any more than a row can.

The SSE endpoint is mounted in `server.ts` BEFORE the JSON router, because the
router assumes one response and ends it. Tests must do the same when they build
their own server.

## Mail

`src/mail/smtp.ts` is a hand-rolled client. It REFUSES to send a password over a
connection with no TLS (`INSECURE_AUTH`) — tests that want authentication against
the local fake server must pass `allowInsecureAuth: true`, and production must
never set it. `PEPL_MAIL_KEY` decrypts stored mailbox passwords; without it the
outbox job does nothing and says so.

A 4xx SMTP reply is temporary and retried with backoff; a 5xx is permanent and
abandoned at once. Retrying a permanent rejection forever is how an outbox turns
into a spam incident.

## Web layout

Screens are directories with a barrel at the old path, so imports did not change:
`Workforce.tsx`, `People.tsx` and `Operations.tsx` re-export from
`workforce/`, `people/` and `operations/`. `App.tsx` keeps the shell; the nav
model is `app/nav.ts` and route-to-screen is `app/screen.tsx`.

**`styles.css` is seven files imported in cascade order and the order is
load-bearing** — later files deliberately override earlier ones. Add rules to
`styles/refinements.css` (or a new file imported last), never by reordering.

- `WidgetBoard` filters children with `Children.toArray`, which flattens ARRAYS
  but not fragments or components. A tile wrapped in a component vanishes with no
  error. Return `Widget` elements from plain functions.
- A `<button>` with no class slips through every class-based CSS rule. The
  inactive tab in `Tabs` is one, and it was the last 41px touch target.
- `npm run check:responsive` is green across eight devices. Keep it that way.

## A migration cannot write a tenant-scoped table

Migrations run as `pepl_owner`, and `FORCE ROW LEVEL SECURITY` applies to the
owner too. With no `app.tenant_id` set, `current_tenant()` is NULL, so an
UPDATE over a tenant table matches **zero rows and reports success** — the
migration looks applied and changed nothing.

027_plan_features_chat_mail.sql tried to re-project `tenant_entitlements` this
way and silently did nothing. Re-projection belongs in
`npm run job control.reproject_entitlements`, which uses the superuser control
connection, because entitlements are a control-plane write the app role is
explicitly denied.

## Entitlements must be sellable

A setting declaring `entitlement: 'chat'` is capped by the entitlement layer,
which is a projection of the PLAN. chat and mail shipped fully built, routed,
tested and documented while no plan granted either — so both resolved to false
for every tenant, permanently. `gate:launch` now fails when a declared
entitlement is sold by no plan.

## The smoke rig

`npm run smoke` drives the RUNNING server as the seeded users and checks the
wiring the unit tests cannot: routes registered, permissions asserted, module
flags respected. Two cautions learned writing it:

- An oversized body makes the server destroy the socket; Node reuses that
  socket from the keep-alive pool and the NEXT request fails with ECONNRESET.
  It reads as a server bug and is not. Keep payload-cap probes last.
- The demo tenant has chat, mail and helpdesk switched ON so the whole product
  is reachable; a real tenant gets them off by default.

## Config layer

`src/config-registry/` holds the DEFINITIONS (typed, in code). `tenant_settings` and
`tenant_setting_overrides` hold the VALUES (per tenant, RLS-isolated). Never invert that.

- **`effective_from` is nullable and NULL means "immediate".** The table uses
  `UNIQUE NULLS NOT DISTINCT` (PG15+) rather than a primary key, because a PK forces
  `NOT NULL` and would destroy that semantic. Caught by the test suite the hard way.
- Any key declaring `affects: ['payroll']` **must** be high risk and **must** carry an
  effective date; `gate:config` enforces the first, `setSetting` the second.
- `setSetting` bumps `tenant_config_versions` in the **caller's transaction**, so a new
  version can never be observed alongside stale values, and a rollback undoes both.
- Entitlements are written by the control plane only. The app role has SELECT and an
  explicit REVOKE on INSERT/UPDATE/DELETE — a tenant cannot grant itself a module.

## Adding a config setting

1. Add the definition to the right module block in `src/config-registry/index.ts`.
2. Give it a label, help text, a default correct for a standard Indian company, and a
   risk class. `gate:config` fails the build without them.
3. If it changes money, declare `affects: ['payroll']` and `risk: 'high'`.
4. If it varies by department/location/grade, declare `scopable`.
5. Add a resolver test for the precedence you expect.

## Payroll invariants

The engine reads **only `payroll_inputs`**. Never attendance, never leave, never live
compensation — those are resolved once, at freeze, and written as VALUES. `monthly_components`
holds resolved amounts, not a pointer to a structure that can later change.

- A **locked run is immutable in the database**, via triggers on `payroll_inputs`,
  `payroll_lines`, `payslips` and `payroll_runs`. Service checks are bypassed by jobs and
  consoles; the trigger is not. Test it with a RAW insert, not through the service, or the
  service guard fires first and the test proves nothing.
- **Rounding happens once per component**, to the nearest rupee, as the line is written.
  Gross is the SUM OF ROUNDED LINES so a payslip adds up on screen. Test expectations must
  round too — `40000 * 0.5/30` is `667`, not `666.67`.
- Employer contributions (`PF_ER`, `ESI_ER`) are `employer_contribution`, never deducted
  from the employee. `LOP` reduces gross rather than counting as a deduction.
- A correction to a locked run is a **revision**: a full recomputation with
  `supersedes_run_id` set. The delta is DERIVED by joining the two runs, never stored.
- Separation of duty: whoever ran the payroll cannot approve or lock the same run.

## Row-level security gotchas learned here

- **`INSERT ... RETURNING` needs the new row to be VISIBLE under the SELECT policy.**
  Where a policy can hide a row from its own creator — a confidential ticket filed on
  someone's behalf — `RETURNING` fails with "new row violates row-level security policy",
  which reads like a WITH CHECK failure and is not. Generate the id client-side and insert
  without `RETURNING`.
- **Never derive a sequence from `MAX()` over an RLS-filtered table.** A row the caller
  cannot see is a number handed out twice. Use a per-tenant counter table whose visibility
  is tenant-only.
- **Within-tenant confidentiality goes in the policy, not the service.** `tickets` uses
  `app.user_id` (pinned by `withTenant`) so a grievance is absent from every list, count,
  search and export by construction. A service-layer filter is one forgotten WHERE clause
  away from putting it in a manager's queue — and with no user context pinned, the rows
  correctly disappear entirely.

## HTTP API

`npm run api` (port 4010) · `npm run seed:demo` · `npm run openapi` · `npm run job <name>`

- `src/http/context.ts` `authed()` is the ONLY way a route reaches the database. It
  resolves the session, opens the tenant transaction, loads the authz context and
  asserts the verb permission. Scope is asserted inside the handler, where the target
  employee is known.
- **`server.ts` starts a listener at import time.** Tests must build their own server
  from `createHandler(buildRouter())` in `src/http/app.ts`, never import `server.ts`.
- Domain modules throw typed errors with a stable `code`; `STATUS_BY_CODE` in
  `router.ts` maps it to a status. An untyped `Error` becomes a 500 — if a client
  mistake is returning 500, the fix is to give that error a code, not to catch it.
- A single `PoolClient` runs ONE query at a time. `Promise.all` over the same `tx`
  only queues them behind a pg deprecation warning; write them sequentially.

## Gate allowlists live in ONE place

`src/db/table-classification.ts`. Both `gate:rls` and `gate:launch` import it. They
used to keep separate inline copies, which drifted the moment a table was added —
a real finding in one gate masked by a stale list in the other.

## Adding a table

1. New migration in `db/migrations/` (forward-only, numbered).
2. `tenant_id uuid NOT NULL`, composite PK `(tenant_id, id)`, composite FKs `(tenant_id, parent_id)`.
3. `ENABLE` **and** `FORCE ROW LEVEL SECURITY`, plus a policy with **both** `USING` and `WITH CHECK`.
4. Run `npm run gate:rls` — it fails the build if any of the above is missing, and it also fails on a
   table that is neither tenant-scoped nor deliberately listed in `GLOBAL_TABLES` /
   `TENANT_ROOT_TABLES` in `scripts/gate-rls.ts`. That listing is the review point.
5. Extend the cross-tenant suite: read, search, update, delete, insert-with-foreign-tenant, and the
   no-context case.

## Architecture

The design of record is in `docs/` — start at `docs/README.md`. `docs/architecture/tenancy-security.md`
is the specification this harness implements.

## Audit actions are a closed vocabulary

`emit()` rejects an action that is not in `ACTIONS` (src/audit/index.ts) with
`UNKNOWN_ACTION` — at request time. A route that emits a new action therefore
passes every unit test that never calls it and answers 422 to the first real
user. `gate:permissions` now scans `src/` for `action: '…'` literals and fails
on one the vocabulary lacks; the smoke rig found the first instance live.

## The router's verbs are `get`, `post`, `patch`, `del`

There is no `put` and no `delete` method. A "replace" route is a `PATCH` here.

## The production image, without Docker

Docker is not installed on this machine, so the image has never been built
here. The stage that CAN be simulated is the runtime one, and it found two
real bugs on its first run: copy `package*.json`, `src`, `db`, `scripts` into
a scratch directory, `npm ci --omit=dev --ignore-scripts`, run
`src/http/server.ts` and `src/jobs/scheduler.ts`, and call `/health/ready`
exactly as the HEALTHCHECK does. That is how `/health/ready` turned out to be
served by the static handler (404) and then denied `_migrations` (503) — while
every unit test was green because none of them called it.

## `node -e` and this shell

Backticks inside a `node -e "…"` string are eaten by bash, and a CRLF file
defeats a replacement written with `\n`. For anything beyond a one-line `sed`,
write a `.mjs` patch script to the scratchpad with the Write tool, detect the
file's line ending, and run it. Every silent "no change" this session was one
of those two.

## Jobs report errors nobody reads

`data.retention` failed on every tenant, every night, from the day it was
written: 007 revoked UPDATE on `attendance_punches` (correct — a punch is
evidence) and the job UPDATEs two columns of it. The job's own output said
`permission denied for table attendance_punches` and the scheduler logged it
at `warn`. Found while writing erasure, months later.

Two rules from it: a job that touches a table must have a test that RUNS the
statement as the app role (`test/privacy.test.ts` now does for this one), and
"immutable table" is refined with column-level grants
(`GRANT UPDATE (geo_lat, geo_lng)`) rather than abandoned when one column has
to age out.

## `node -e "…"` also eats `$1`, `$2`

Bash expands `$1`/`$2` inside a double-quoted `node -e` string to empty, so a
SQL placeholder written that way arrives as `SELECT , code …` and fails with
"syntax error at or near ','". Use the Edit tool (or a `.mjs` file) for any
replacement text that contains `$`.

## Module completeness is a gate

`npm run gate:modules` walks every `<module>.enabled` flag and requires it to be
sellable (`entitlement`) or declared `core: true`, to own permissions, a
`requireModule` guard, a test and a brief section. A module that is free on
every plan by accident is what this catches — four of them were.
