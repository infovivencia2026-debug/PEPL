# PEPL — working notes

Environment gotchas learned the hard way. Add to this rather than rediscovering them.

## Gates

```
npm run verify     # the whole chain, in order — use this before claiming anything works
  npm run typecheck    tsc --noEmit
  npm run db:setup     roles + database + extensions (superuser, idempotent)
  npm run migrate      forward-only SQL migrations (owner role)
  npm run gate:rls     structural isolation gate — fails the build on an unprotected table
  npm test             vitest: cross-tenant behavioural suite
```

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

## Testing discipline

- `fileParallelism: false` in `vitest.config.ts` — the suites share one database and TRUNCATE in
  setup, so parallel files would race each other's fixtures.
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

  Re-run these whenever the isolation model changes.

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
