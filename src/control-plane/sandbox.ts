/**
 * Sandbox tenants: a real company gets a throwaway twin with sample data,
 * dated to expire. It is a full tenant (every module works), linked by
 * `sandbox_of`, and the outbound jobs (email, WhatsApp, webhooks) skip it so
 * nothing invented ever reaches a real inbox. Expiry purges it; reset is a
 * purge followed by a fresh one.
 */
import type { PoolClient } from 'pg'
import { controlDb, provisionTenant } from './index.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { createUser } from '../auth/index.ts'
import { setSetting } from '../config/write.ts'
import { changeCompensation } from '../people/history.ts'
import { recordPunch, recomputeDay } from '../attendance/index.ts'

export class SandboxError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'SandboxError' }
}
export const SANDBOX_PASSWORD = 'sandbox-pass-1234'
const L = (r: number): number => r * 100

export interface Sandbox { id: string; display_name: string; organisation_type: string | null; sandbox_expires_on: string; created_at: string; admin_email: string; headcount: number }

export async function sandboxOf(parentTenantId: string): Promise<Sandbox | null> {
  return (await controlDb.query<Sandbox>(`SELECT t.id, t.display_name, t.organisation_type, t.sandbox_expires_on::text, t.created_at::text,
      (SELECT email FROM app_users u JOIN user_roles r ON (r.tenant_id, r.user_id) = (u.tenant_id, u.id) WHERE u.tenant_id = t.id AND r.role = 'org_admin' ORDER BY u.created_at LIMIT 1) AS admin_email,
      (SELECT count(*)::int FROM employees e WHERE e.tenant_id = t.id) AS headcount
    FROM tenants t WHERE t.sandbox_of = $1 AND t.is_sandbox AND t.status = 'active' ORDER BY t.created_at DESC LIMIT 1`, [parentTenantId])).rows[0] ?? null
}
export async function isSandboxTenant(tenantId: string): Promise<boolean> {
  return Boolean((await controlDb.query<{ s: boolean }>(`SELECT is_sandbox AS s FROM tenants WHERE id = $1`, [tenantId])).rows[0]?.s)
}

/** Create the company's sandbox. One at a time: reset it rather than pile them up. */
export async function createSandbox(args: { parentTenantId: string; adminEmail: string; adminName: string; organisationType?: string; days?: number; requestedByUserId: string }): Promise<Sandbox> {
  if (await isSandboxTenant(args.parentTenantId)) throw new SandboxError('SANDBOX_OF_SANDBOX', 'a sandbox cannot own a sandbox')
  if (await sandboxOf(args.parentTenantId)) throw new SandboxError('SANDBOX_EXISTS', 'this company already has a sandbox; reset or delete it')
  const days = Math.min(90, Math.max(1, args.days ?? 14))
  const parent = (await controlDb.query<{ display_name: string; legal_name: string; organisation_type: string | null }>(`SELECT display_name, legal_name, organisation_type FROM tenants WHERE id = $1`, [args.parentTenantId])).rows[0]
  if (!parent) throw new SandboxError('NOT_FOUND', 'no such company')
  const orgType = args.organisationType ?? parent.organisation_type ?? 'office'
  const r = await provisionTenant({ legalName: `${parent.legal_name} (Sandbox)`, displayName: `${parent.display_name} — Sandbox`, planCode: 'enterprise', adminEmail: args.adminEmail, adminName: args.adminName, organisationType: orgType })
  await controlDb.query(`UPDATE tenants SET is_sandbox = true, sandbox_of = $2, sandbox_expires_on = current_date + $3::int WHERE id = $1`, [r.tenantId, args.parentTenantId, days])
  await controlDb.query(`INSERT INTO control_plane.platform_audit (tenant_id, action, detail) VALUES ($1,'sandbox.created',$2::jsonb)`, [r.tenantId, JSON.stringify({ parent: args.parentTenantId, byUserId: args.requestedByUserId, days })])
  await withTenant(r.tenantId, (tx) => seedSandbox(tx, r.tenantId, args.adminEmail, args.adminName))
  return (await sandboxOf(args.parentTenantId))!
}

const SAMPLE = [
  ['Asha', 'Rao', 'Engineering', 'Engineering Manager', 1_800_000, true], ['Vikram', 'Nair', 'Engineering', 'Senior Developer', 1_400_000, false], ['Meera', 'Pillai', 'Engineering', 'Developer', 900_000, false],
  ['Rohan', 'Das', 'Engineering', 'Developer', 850_000, false], ['Sunita', 'Kaur', 'Sales', 'Sales Manager', 1_500_000, true], ['Arjun', 'Mehta', 'Sales', 'Account Executive', 800_000, false],
  ['Priya', 'Iyer', 'Sales', 'Account Executive', 780_000, false], ['Karan', 'Shah', 'Operations', 'Operations Lead', 1_200_000, true], ['Fatima', 'Sheikh', 'Operations', 'Executive', 520_000, false],
  ['Deepak', 'Verma', 'Operations', 'Executive', 500_000, false], ['Lakshmi', 'Menon', 'Finance', 'Accountant', 700_000, false], ['Imran', 'Khan', 'Operations', 'Executive', 480_000, false],
] as const

/** Deterministic sample data: 12 people in 4 departments, compensation, two weeks of punches, one leave, one ticket. */
async function seedSandbox(tx: PoolClient, tenantId: string, adminEmail: string, adminName: string): Promise<void> {
  // provisioning left a placeholder admin row with no password and no role; replace it with a real login
  await tx.query(`DELETE FROM app_users WHERE email = $1 AND NOT EXISTS (SELECT 1 FROM user_roles r WHERE (r.tenant_id, r.user_id) = (app_users.tenant_id, app_users.id))`, [adminEmail])
  const adminId = await createUser(tx, { tenantId, email: adminEmail, fullName: adminName, password: SANDBOX_PASSWORD, roles: ['org_admin'] })
  for (const key of ['chat.enabled', 'mail.enabled', 'helpdesk.enabled']) await setSetting(tx, { key, value: true, actorUserId: adminId, reason: 'sandbox shows every module' })
  const ids: string[] = []
  const managers: Record<string, string> = {}
  for (const [i, [first, last, dept, desig, ctc, isMgr]] of SAMPLE.entries()) {
    const num = `SBX-${String(i + 1).padStart(3, '0')}`
    const { rows } = await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining, date_of_birth, gender) VALUES ($1,$2,$3,$4,$5::date,$6::date,$7) RETURNING id`,
      [tenantId, num, first, last, `202${3 + (i % 3)}-0${1 + (i % 9)}-15`, `199${i % 10}-0${1 + (i % 9)}-0${1 + (i % 9)}`, i % 2 ? 'male' : 'female'])
    ids.push(rows[0]!.id)
    if (isMgr) managers[dept] = rows[0]!.id
    await createUser(tx, { tenantId, email: `${first.toLowerCase()}.${last.toLowerCase()}@sandbox.test`, fullName: `${first} ${last}`, password: SANDBOX_PASSWORD, roles: [isMgr ? 'manager' : 'employee'], employeeId: rows[0]!.id })
  }
  for (const [i, [, , dept, desig, ctc, isMgr]] of SAMPLE.entries()) {
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, manager_employee_id, location_code, effective_from, change_reason) VALUES ($1,$2,$3,$4,$5,'HQ',DATE '2024-04-01','sandbox seed')`,
      [tenantId, ids[i], dept, desig, isMgr ? null : managers[dept] ?? null])
    const basic = Math.round(ctc / 12 * 0.5), hra = Math.round(basic * 0.4), special = Math.round(ctc / 12) - basic - hra
    await changeCompensation(tx, { employeeId: ids[i]!, annualCtcPaise: L(ctc), components: { basic: L(basic), hra: L(hra), special: L(special) }, effectiveFrom: '2024-04-01', reason: 'sandbox seed' })
  }
  // a fortnight of punches, Sundays off, one person absent one day
  const today = new Date(); today.setUTCHours(0, 0, 0, 0)
  for (let back = 14; back >= 1; back--) {
    const d = new Date(today.getTime() - back * 86_400_000)
    if (d.getUTCDay() === 0) continue
    const date = d.toISOString().slice(0, 10)
    for (const [i, id] of ids.entries()) {
      if (back === 5 && i === 9) continue
      await recordPunch(tx, { employeeId: id, punchedAt: `${date}T0${3 + (i % 2)}:${25 + (i % 30)}:00Z`, localDate: date, direction: 'in', source: 'mobile', clientPunchId: `sbx-${id}-${date}-in` })
      await recordPunch(tx, { employeeId: id, punchedAt: `${date}T12:${30 + (i % 25)}:00Z`, localDate: date, direction: 'out', source: 'mobile', clientPunchId: `sbx-${id}-${date}-out` })
      await recomputeDay(tx, id, date)
    }
  }
}

/** Purge every row of a tenant, in every tenant-scoped table, then the tenant. Control connection; replica mode so triggers stay quiet. */
export async function purgeTenant(tenantId: string): Promise<void> {
  const client = await controlDb.connect()
  try {
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attname = 'tenant_id' AND NOT a.attisdropped`)
    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = replica`)
    for (const t of tables) await client.query(`DELETE FROM "${t.table_name}" WHERE tenant_id = $1`, [tenantId])
    // Every control-plane table that names the tenant, found rather than listed: a hand-kept list missed the
    // invoice and credit-note tables, leaving orphans that stop a later backup from restoring. platform_audit
    // stays -- it is the record that the tenant existed and was purged.
    const { rows: cp } = await client.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
        WHERE table_schema = 'control_plane' AND column_name = 'tenant_id' AND table_name <> 'platform_audit'`)
    for (const t of cp) await client.query(`DELETE FROM control_plane."${t.table_name}" WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM control_plane.group_admins WHERE group_id IN (SELECT id FROM control_plane.groups WHERE owner_tenant_id = $1)`, [tenantId])
    await client.query(`DELETE FROM control_plane.groups WHERE owner_tenant_id = $1`, [tenantId])
    await client.query(`UPDATE tenants SET sandbox_of = NULL WHERE sandbox_of = $1`, [tenantId])
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId])
    await client.query(`INSERT INTO control_plane.platform_audit (tenant_id, action, detail) VALUES ($1,'tenant.purged','{}'::jsonb)`, [tenantId])
    await client.query('COMMIT')
  } catch (err) { await client.query('ROLLBACK'); throw err } finally { client.release() }
}

export async function deleteSandbox(parentTenantId: string): Promise<void> {
  const s = await sandboxOf(parentTenantId)
  if (!s) throw new SandboxError('NOT_FOUND', 'this company has no sandbox')
  await purgeTenant(s.id)
}
export async function resetSandbox(args: { parentTenantId: string; requestedByUserId: string }): Promise<Sandbox> {
  const s = await sandboxOf(args.parentTenantId)
  if (!s) throw new SandboxError('NOT_FOUND', 'this company has no sandbox')
  // the expiry is a DATE (midnight); rounding the remaining milliseconds loses a day, so a reset quietly shortened the sandbox
  const today = new Date().toISOString().slice(0, 10)
  const days = Math.max(1, Math.round((Date.parse(s.sandbox_expires_on) - Date.parse(today)) / 86_400_000))
  await purgeTenant(s.id)
  return createSandbox({ parentTenantId: args.parentTenantId, adminEmail: s.admin_email, adminName: 'Sandbox Admin', organisationType: s.organisation_type ?? undefined, days, requestedByUserId: args.requestedByUserId })
}
/** Nightly: purge expired sandboxes. */
export async function purgeExpiredSandboxes(today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const { rows } = await controlDb.query<{ id: string }>(`SELECT id FROM tenants WHERE is_sandbox AND sandbox_expires_on < $1::date`, [today])
  for (const r of rows) await purgeTenant(r.id)
  return rows.length
}
