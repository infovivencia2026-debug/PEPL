/**
 * Launch readiness gate.
 *
 * Everything here is a claim PEPL makes to a customer it has never met. Each one
 * is checked against the live database rather than asserted in a document.
 *
 * Exit 1 means: do not open signup.
 */
import pg from 'pg'
import { PT_STATES } from '../db/reference/pt-slabs.ts'
import { config } from '../src/config.ts'
import { REGISTRY } from '../src/config-registry/index.ts'
import { ACTIONS } from '../src/audit/index.ts'
import { GLOBAL_TABLES } from '../src/db/table-classification.ts'

type Row = Record<string, unknown>

interface Check {
  name: string
  ok: boolean
  detail: string
}

const checks: Check[] = []
const record = (name: string, ok: boolean, detail: string): void => {
  checks.push({ name, ok, detail })
}

async function main(): Promise<void> {
  const db = new pg.Client({
    host: config.host, port: config.port, database: config.db,
    user: config.superUser, password: config.superPassword,
  })
  await db.connect()

  // 1. Isolation: every tenant table protected, runtime role unprivileged.
  const { rows: unprotected } = await db.query<Row>(`
    SELECT c.relname AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
       AND NOT (c.relname = ANY($1))
       AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity)`,
    [[...GLOBAL_TABLES]])
  record('tenant isolation: every table has RLS + FORCE', unprotected.length === 0,
    unprotected.length === 0 ? 'all tables protected' : `unprotected: ${unprotected.map((r) => r.name).join(', ')}`)

  const { rows: roleRows } = await db.query<Row>(
    `SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = $1`, [config.appUser])
  const role = roleRows[0]
  record('runtime role has no BYPASSRLS and is not a superuser',
    Boolean(role) && !role!.rolbypassrls && !role!.rolsuper,
    role ? `bypassrls=${role.rolbypassrls} super=${role.rolsuper}` : 'role missing')

  // 2. Payroll: a locked run must be unwritable from every direction.
  const { rows: triggers } = await db.query<Row>(`
    SELECT tgname FROM pg_trigger
     WHERE NOT tgisinternal
       AND tgname IN ('payroll_inputs_immutable','payroll_lines_immutable',
                      'payslips_immutable','payroll_run_locked')`)
  record('payroll immutability triggers installed', triggers.length === 4,
    `${triggers.length}/4 present`)

  // 3. Append-only tables: history cannot be rewritten by the application.
  const APPEND_ONLY = [
    'audit_events', 'config_change_log', 'leave_ledger', 'attendance_punches',
    'attendance_corrections', 'approval_actions', 'ticket_events',
  ]
  for (const table of APPEND_ONLY) {
    const { rows } = await db.query<Row>(
      `SELECT has_table_privilege($1, $2, 'UPDATE') AS u,
              has_table_privilege($1, $2, 'DELETE') AS d`,
      [config.appUser, table])
    const r = rows[0]!
    record(`${table} is append-only for the runtime role`, !r.u && !r.d,
      `update=${r.u} delete=${r.d}`)
  }

  // 4. Statutory data is reference data, not customer data.
  const { rows: statutory } = await db.query<Row>(
    `SELECT has_table_privilege($1, 'statutory_configs', 'UPDATE') AS u`, [config.appUser])
  record('statutory rates are read-only to the application', !statutory[0]!.u,
    `update=${statutory[0]!.u}`)

  // 5. Control plane is walled off.
  const { rows: cp } = await db.query<Row>(
    `SELECT has_schema_privilege($1, 'control_plane', 'USAGE') AS u`, [config.appUser])
  record('application role cannot reach the control plane', !cp[0]!.u, `usage=${cp[0]!.u}`)

  const { rows: ent } = await db.query<Row>(
    `SELECT has_table_privilege($1, 'tenant_entitlements', 'UPDATE') AS u`, [config.appUser])
  record('application role cannot write its own entitlements', !ent[0]!.u, `update=${ent[0]!.u}`)

  // 6. Confidential helpdesk categories are enforced in the policy.
  const { rows: pol } = await db.query<Row>(
    `SELECT qual FROM pg_policies WHERE tablename = 'tickets' AND policyname = 'tenant_isolation'`)
  const qual = String(pol[0]?.qual ?? '')
  record('confidential tickets are filtered by the RLS policy, not by application code',
    qual.includes('current_app_user'), qual ? 'policy references the acting user' : 'policy missing')

  // 7. Audit chain integrity across every tenant.
  const { rows: chain } = await db.query<Row>(`
    SELECT count(*) FILTER (
      WHERE prev_hash IS DISTINCT FROM lag_hash
    )::int AS broken
      FROM (
        SELECT prev_hash, lag(row_hash) OVER (PARTITION BY tenant_id ORDER BY id) AS lag_hash
          FROM audit_events
      ) x`)
  record('audit hash chain is unbroken', Number(chain[0]!.broken) === 0,
    `${chain[0]!.broken} broken link(s)`)

  // 8. Registry completeness — the admin UI is generated from it.
  const missing = Object.entries(REGISTRY).filter(([, d]) => !d.label || !d.help)
  record('every config setting has a label and help text', missing.length === 0,
    `${Object.keys(REGISTRY).length} settings, ${missing.length} incomplete`)

  const payrollKeys = Object.entries(REGISTRY).filter(([, d]) => d.affects.includes('payroll'))
  record('every payroll-affecting setting is high risk',
    payrollKeys.every(([, d]) => d.risk === 'high'),
    `${payrollKeys.length} payroll-affecting settings`)

  record('audit action registry is populated', Object.keys(ACTIONS).length >= 20,
    `${Object.keys(ACTIONS).length} actions declared`)

  // 9. A seeded tenant must be able to run payroll with no configuration.
  const { rows: seeded } = await db.query<Row>(`
    SELECT (SELECT count(*) FROM leave_types)      AS leave_types,
           (SELECT count(*) FROM ticket_categories) AS categories,
           (SELECT count(*) FROM control_plane.plans) AS plans`)
  record('plan catalogue is present', Number(seeded[0]!.plans) >= 3,
    `${seeded[0]!.plans} plans`)

  // Every entitlement a setting names must be SELLABLE. chat and mail shipped
  // fully built, routed and documented, and no plan granted either — so the
  // entitlement layer resolved both to false for every tenant, permanently.
  // A feature nobody can buy is a feature nobody has.
  const declared = [...new Set(
    Object.values(REGISTRY)
      .map((def) => def.entitlement)
      .filter((name): name is string => Boolean(name)),
  )]
  const { rows: planRows } = await db.query<{ features: Record<string, boolean> }>(
    'SELECT features FROM control_plane.plans')
  const grantable = new Set(
    planRows.flatMap((p) => Object.entries(p.features ?? {})
      .filter(([, on]) => on === true)
      .map(([name]) => name)),
  )
  const unsellable = declared.filter((name) => !grantable.has(name))
  record(
    'every entitlement a setting names is sold by some plan',
    unsellable.length === 0,
    unsellable.length ? `no plan grants: ${unsellable.join(', ')}` : `${declared.length} entitlement(s)`,
  )

  // Professional tax is state law: every state the reference file knows must
  // have slabs in force today, and every tenant's chosen PT state must be one of them.
  const { rows: ptRows } = await db.query<{ state_code: string }>(
    `SELECT DISTINCT state_code FROM pt_slabs WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)`)
  const loaded = new Set(ptRows.map((r) => r.state_code))
  const missingPt = PT_STATES.map((s) => s.code).filter((c) => !loaded.has(c))
  record(
    'professional-tax slabs loaded for every PT state (npm run seed:statutory)',
    missingPt.length === 0,
    missingPt.length ? `no slabs in force for: ${missingPt.join(', ')}` : `${loaded.size} state(s)`,
  )
  const fyStartYear = new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1
  const fyLabel = (y: number): string => `${y}-${String((y + 1) % 100).padStart(2, '0')}`
  const wanted = [fyLabel(fyStartYear), fyLabel(fyStartYear + 1)]
  const { rows: fyRows } = await db.query<{ fiscal_year: string; regimes: string }>(
    `SELECT fiscal_year, count(DISTINCT regime)::text AS regimes FROM tax_slabs WHERE fiscal_year = ANY($1) GROUP BY fiscal_year`, [wanted])
  const missingFy = wanted.filter((fy) => !fyRows.some((r) => r.fiscal_year === fy && Number(r.regimes) === 2))
  record(
    'income-tax tables loaded for this fiscal year and the next (npm run seed:statutory)',
    missingFy.length === 0,
    missingFy.length ? `no complete tables for: ${missingFy.join(', ')}` : wanted.join(', '),
  )
  const { rows: pfRows } = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM statutory_configs WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to > CURRENT_DATE)`)
  record('PF/ESI statutory configuration in force today', Number(pfRows[0]!.n) > 0, Number(pfRows[0]!.n) > 0 ? 'present' : 'none — every run would fail NO_STATUTORY_CONFIG')

  const { rows: tenantStates } = await db.query<{ v: string }>(
    `SELECT DISTINCT trim(both '"' from value::text) AS v FROM tenant_settings WHERE key = 'payroll.pt_state_code' AND value::text <> '""'`)
  const unknownStates = tenantStates.map((r) => r.v).filter((v) => v && !loaded.has(v))
  record(
    "every tenant's PT state has slabs (or levies no PT)",
    unknownStates.length === 0,
    unknownStates.length ? `configured but no slabs: ${unknownStates.join(', ')}` : `${tenantStates.length} tenant state(s)`,
  )

  await db.end()

  const failed = checks.filter((c) => !c.ok)
  const pad = Math.max(...checks.map((c) => c.name.length))
  console.log('\nPEPL launch readiness\n' + '='.repeat(pad + 12))
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(pad)}  ${c.detail}`)
  }
  console.log('='.repeat(pad + 12))

  if (failed.length) {
    console.error(`\n${failed.length} launch check(s) FAILED — do not open signup.\n`)
    process.exit(1)
  }
  console.log(`\nAll ${checks.length} launch checks passed.\n`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
