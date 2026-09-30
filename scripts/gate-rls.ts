/**
 * CI structural gate: tenant isolation cannot regress silently.
 *
 * This is the check that stops the twentieth table from being the one that
 * forgot a policy. It fails the build on any of:
 *   1. a table that is neither tenant-scoped nor explicitly allowlisted as global
 *   2. a tenant-scoped table without ENABLE + FORCE row level security
 *   3. a policy missing USING or WITH CHECK (a WITH CHECK gap lets a tenant
 *      WRITE another tenant's row even though it cannot read one back)
 *   4. a tenant-owned table whose tenant_id is missing or nullable
 *   5. the runtime role holding BYPASSRLS, owning tables, or being a superuser
 *
 * Adding a table is therefore a deliberate isolation decision, not an oversight.
 */
import pg from 'pg'
import { config } from '../src/config.ts'

import { GLOBAL_TABLES, TENANT_ROOT_TABLES } from '../src/db/table-classification.ts'
import { lintPolicy } from '../src/db/policy-lint.ts'

type Row = Record<string, unknown>
const failures: string[] = []
const fail = (msg: string): number => failures.push(msg)

async function main(): Promise<void> {
  const db = new pg.Client({
    host: config.host,
    port: config.port,
    database: config.db,
    user: config.superUser,
    password: config.superPassword,
  })
  await db.connect()

  const { rows: tables } = await db.query<Row>(`
    SELECT c.relname            AS name,
           c.relrowsecurity     AS rls_enabled,
           c.relforcerowsecurity AS rls_forced
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
     ORDER BY c.relname`)

  const { rows: policies } = await db.query<Row>(`
    SELECT tablename AS table_name, policyname AS name, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'public'`)

  const { rows: columns } = await db.query<Row>(`
    SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'tenant_id'`)

  const tenantIdCols = new Map(columns.map((c) => [c.table_name as string, c.is_nullable as string]))

  let checked = 0
  for (const t of tables) {
    const name = t.name as string
    if (GLOBAL_TABLES.has(name)) continue

    const isRoot = TENANT_ROOT_TABLES.has(name)
    const nullable = tenantIdCols.get(name)

    if (!isRoot && nullable === undefined) {
      fail(`table "${name}" has no tenant_id and is not in GLOBAL_TABLES or TENANT_ROOT_TABLES`)
      continue
    }
    if (!isRoot && nullable === 'YES') {
      fail(`table "${name}".tenant_id is nullable; it must be NOT NULL`)
    }

    checked++
    if (!t.rls_enabled) fail(`table "${name}" does not have ROW LEVEL SECURITY enabled`)
    if (!t.rls_forced) fail(`table "${name}" is missing FORCE ROW LEVEL SECURITY (the owner would bypass its own policies)`)

    const own = policies.filter((p) => p.table_name === name)
    if (own.length === 0) {
      fail(`table "${name}" has RLS but no policy - it is unreadable AND unwritable, which is a bug, not safety`)
      continue
    }
    // Each clause is judged on its own, by the structure of the expression: a substring
    // search over USING and WITH CHECK joined together accepted `WITH CHECK (true)` and
    // `... OR true` (see src/db/policy-lint.ts).
    for (const p of own) {
      for (const problem of lintPolicy({
        table: name, name: p.name as string, cmd: p.cmd as string,
        qual: (p.qual as string | null) ?? null, withCheck: (p.with_check as string | null) ?? null,
      })) fail(problem)
    }
  }

  // Row-level security does not apply through a view unless the view runs as its CALLER.
  // A plain view runs as its owner -- which FORCE binds too, but a view over a tenant table
  // owned by anything else would read every tenant. Require security_invoker.
  const { rows: views } = await db.query<Row>(`
    SELECT c.relname AS name, c.relkind AS kind, c.reloptions AS opts
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind IN ('v','m')`)
  for (const v of views) {
    const opts = (v.opts as string[] | null) ?? []
    if (v.kind === 'm') fail(`materialized view "${v.name}" cannot be row-level secured; it would hold every tenant's rows`)
    else if (!opts.includes('security_invoker=true')) {
      fail(`view "${v.name}" is not security_invoker=true, so it would read tables as its owner and bypass their policies`)
    }
  }

  // A schema nobody classified is a place tenant data can sit with no policy at all.
  const { rows: schemas } = await db.query<Row>(`
    SELECT DISTINCT n.nspname AS name
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r','p','v','m','f')
       AND n.nspname NOT IN ('public','control_plane','pg_catalog','information_schema')
       AND n.nspname NOT LIKE 'pg\_%'`)
  for (const sc of schemas) fail(`schema "${sc.name}" holds tables but is neither public nor control_plane; classify it before it holds data`)

  const { rows: roleRows } = await db.query<Row>(
    'SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1',
    [config.appUser],
  )
  const role = roleRows[0]
  if (!role) {
    fail(`runtime role "${config.appUser}" does not exist`)
  } else {
    if (role.rolbypassrls) fail(`runtime role "${config.appUser}" has BYPASSRLS`)
    if (role.rolsuper) fail(`runtime role "${config.appUser}" is a superuser`)
  }

  const { rows: owned } = await db.query<Row>(`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND r.rolname = $1`,
    [config.appUser])
  for (const o of owned) {
    fail(`runtime role "${config.appUser}" owns table "${o.name}" - an owner bypasses RLS unless FORCE is set`)
  }

  await db.end()

  if (failures.length) {
    console.error(`\nRLS structural gate FAILED (${failures.length} problem(s)):\n`)
    for (const f of failures) console.error(`  x ${f}`)
    console.error('')
    process.exit(1)
  }
  console.log(`RLS structural gate passed: ${checked} tenant-scoped table(s) verified, runtime role clean.`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
