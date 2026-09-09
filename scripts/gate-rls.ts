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
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`)

  const { rows: policies } = await db.query<Row>(`
    SELECT tablename AS table_name, policyname AS name, qual, with_check
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
    for (const p of own) {
      if (!p.qual) fail(`policy "${p.name}" on "${name}" has no USING clause`)
      if (!p.with_check) fail(`policy "${p.name}" on "${name}" has no WITH CHECK clause - a tenant could write another tenant's row`)
      const expr = `${p.qual ?? ''} ${p.with_check ?? ''}`
      if (!expr.includes('current_tenant()')) {
        fail(`policy "${p.name}" on "${name}" does not reference current_tenant()`)
      }
    }
  }

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
