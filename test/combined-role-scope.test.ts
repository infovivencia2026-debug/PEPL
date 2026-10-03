/**
 * A manager who is also an employee reads their OWN pay, not their team's.
 *
 * buildContext() kept ONE data scope for the whole user: the widest of any role they hold. `manager`
 * has scope `reports` and `employee` holds payroll.read / document.read at `self`, so a user with
 * both got payroll.read at `reports` -- they could read every direct report's payslip, documents and
 * statutory IDs although no role they hold grants payroll.read over a team. Scope must belong to the
 * PERMISSION, not to the user.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { putDocument } from '../src/documents/index.ts'
import { seedTaxTables } from '../scripts/seed-statutory.ts'
import { buildContext, scopeFor, assertScope } from '../src/authz/permissions.ts'

const PASSWORD = 'combined-role-test-password'
let server: Server, base: string, A: Tenant, mgrEmp: string, runId: string
let reportSlip: string, ownSlip: string, reportDoc: string
const token: Record<string, string> = {}

const call = async (path: string, who: string) => {
  const r = await fetch(base + path, { headers: { authorization: `Bearer ${token[who]}` } })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> & { payslips?: unknown[]; documents?: { id: string }[] } }
}

describe('scope belongs to the permission (pure)', () => {
  const ctx = buildContext({ tenantId: 't', userId: 'u', employeeId: 'me', roles: ['manager', 'employee'], reportIds: ['r1'] })
  it('keeps the team scope for what the manager role grants', () => {
    expect(scopeFor(ctx, 'leave.approve')).toBe('reports')
    expect(scopeFor(ctx, 'attendance.correct')).toBe('reports')
  })
  it('keeps self scope for what only the employee role grants', () => {
    for (const p of ['payroll.read', 'document.read', 'document.write'] as const) expect(scopeFor(ctx, p), p).toBe('self')
  })
  it('assertScope with a permission uses that permission\'s scope', () => {
    expect(() => assertScope(ctx, 'r1', 'leave.approve')).not.toThrow()
    expect(() => assertScope(ctx, 'r1', 'payroll.read')).toThrow()
    expect(() => assertScope(ctx, 'me', 'payroll.read')).not.toThrow()
  })
  it('a role that grants the permission more widely still wins for it', () => {
    const both = buildContext({ tenantId: 't', userId: 'u', employeeId: 'me', roles: ['employee', 'payroll_admin'] })
    expect(scopeFor(both, 'payroll.read')).toBe('all')
  })
})

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await seedTaxTables()
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"payroll":true,"documents":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])
  mgrEmp = await withTenant(A.id, async (tx) => {
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'M-1','Mira',DATE '2025-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Eng','Manager',DATE '2025-01-01')`, [A.id, id])
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $1 WHERE employee_id = $2`, [id, A.employeeId])   // A.employee reports to Mira
    return id
  })
  for (const [name, roles, employeeId] of [
    ['payroll', ['payroll_admin'], undefined],
    ['mgr', ['manager', 'employee'], mgrEmp],
  ] as const) {
    await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: `${name}@scope2.test`, fullName: name, password: PASSWORD, roles: [...roles], employeeId }))
    const s = await login({ email: `${name}@scope2.test`, password: PASSWORD })
    if ('choose' in s) throw new Error('fixture address is in more than one company')
    token[name] = s.token
  }
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  const post = (path: string, who: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` }, body: JSON.stringify(body) }).then((r) => r.json() as Promise<{ id?: string }>)
  const period = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods(tenant_id,label,period_start,period_end,pay_date) VALUES($1,'2026-10','2026-10-01','2026-10-31','2026-11-01') RETURNING id`, [A.id])).rows[0]!.id)
  runId = (await post('/api/v1/payroll/runs', 'payroll', { periodId: period })).id!
  const row = (employeeId: string) => ({ employeeId, calendarDays: 31, payableDays: 31, lopDays: 0, monthlyComponents: { basic: 5_000_000 }, annualCtcPaise: 60_000_000, stateCode: 'TS', pfApplicable: true })
  await post(`/api/v1/payroll/runs/${runId}/freeze`, 'payroll', { rows: [row(A.employeeId), row(mgrEmp)] })
  await post(`/api/v1/payroll/runs/${runId}/calculate`, 'payroll', {})
  await controlPool.query(`UPDATE payroll_runs SET status = 'locked' WHERE id = $1`, [runId])
  const slips = await withTenant(A.id, async (tx) => (await tx.query<{ id: string; employee_id: string }>(`SELECT id, employee_id FROM payslips WHERE run_id = $1`, [runId])).rows)
  reportSlip = slips.find((s) => s.employee_id === A.employeeId)!.id
  ownSlip = slips.find((s) => s.employee_id === mgrEmp)!.id
  reportDoc = await withTenant(A.id, (tx) => putDocument(tx, { ownerType: 'employee', ownerId: A.employeeId, fileName: 'id.txt', contentType: 'text/plain', bytes: Buffer.from('x'), category: 'identity' })).then((m) => m.id)
  await withTenant(A.id, (tx) => tx.query(`INSERT INTO employee_statutory_ids (tenant_id, employee_id, uan, pan) VALUES ($1,$2,'100123456789','ABCDE1234F')`, [A.id, A.employeeId]))
})
afterAll(async () => { server?.closeAllConnections(); server?.close(); await closePools(); await controlPool.end() })

describe('a manager who is also an employee', () => {
  it('reads their own payslip', async () => {
    expect((await call(`/api/v1/payslips/${ownSlip}/lines`, 'mgr')).status).toBe(200)
    expect((await call(`/api/v1/payslips/${ownSlip}/pdf`, 'mgr')).status).toBe(200)
  })
  it('cannot read a direct report\'s payslip', async () => {
    expect((await call(`/api/v1/payslips/${reportSlip}/lines`, 'mgr')).status).toBe(404)
    expect((await call(`/api/v1/payslips/${reportSlip}/pdf`, 'mgr')).status).toBe(404)
    expect((await call(`/api/v1/payslips?employeeId=${A.employeeId}`, 'mgr')).status).toBe(404)
  })
  it('cannot read a direct report\'s documents or statutory IDs', async () => {
    expect((await call(`/api/v1/documents?ownerType=employee&ownerId=${A.employeeId}`, 'mgr')).status).toBe(404)
    expect((await call(`/api/v1/documents/${reportDoc}/content`, 'mgr')).status).toBe(404)
    expect((await call(`/api/v1/employees/${A.employeeId}/statutory-ids`, 'mgr')).status).toBe(404)
  })
  it('still has the team scope the manager role grants', async () => {
    // leave/attendance for a report remain visible to their manager
    expect((await call(`/api/v1/attendance?from=2026-10-01&to=2026-10-02&employeeId=${A.employeeId}`, 'mgr')).status).toBe(200)
  })
  it('payroll admin still reads everything', async () => {
    expect((await call(`/api/v1/payslips/${reportSlip}/lines`, 'payroll')).status).toBe(200)
  })
})
