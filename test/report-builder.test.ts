/**
 * Report builder (C7). Only whitelisted models/fields reach the SQL; values
 * are bound; a manager's report is cut to their scope; a model's permission
 * gates it (a manager cannot build on payroll lines); grouped measures and
 * row reports both work; saved reports are the owner's or shared; a
 * schedule runs as its owner and pauses itself when the owner loses the
 * right or leaves.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { buildContext } from '../src/authz/permissions.ts'
import { compile, runReport, catalogue } from '../src/reports/builder.ts'
import { saveReport, listReports, getReport, createSchedule, listSchedules, nextRunOn, runDueSchedules } from '../src/reports/saved.ts'

let A: Tenant; let hrUser: string; let mgrUser: string; let mgr: string
const others: string[] = []
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'rbhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin', 'payroll_admin'] })
    mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-M','Mgr',DATE '2022-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Sales','Manager',DATE '2022-01-01')`, [A.id, mgr])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'rbmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    for (let i = 1; i <= 3; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,$3,DATE '2024-01-01') RETURNING id`, [A.id, `A-R${i}`, `R${i}`])).rows[0]!.id
      await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from, manager_employee_id) VALUES ($1,$2,$3,'Exec',DATE '2024-01-01',$4)`, [A.id, id, i <= 2 ? 'Sales' : 'Ops', i <= 2 ? mgr : null])
      others.push(id)
      for (let d = 1; d <= 3; d++) await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status, late_minutes) VALUES ($1,$2,$3::date,$4,$5)`, [A.id, id, `2026-10-0${d}`, d === 3 ? 'absent' : 'present', d * 10 * i])
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('compile', () => {
  it('whitelists models and fields, binds values, gates by permission and scope', () => {
    const hr = buildContext({ tenantId: A.id, userId: hrUser, roles: ['hr_admin', 'payroll_admin'] })
    const man = buildContext({ tenantId: A.id, userId: mgrUser, employeeId: mgr, roles: ['manager'], reportIds: [others[0]!, others[1]!] })
    expect(() => compile({ model: 'nope' }, hr)).toThrow(expect.objectContaining({ code: 'UNKNOWN_MODEL' }))
    expect(() => compile({ model: 'employees', columns: ['password'] }, hr)).toThrow(expect.objectContaining({ code: 'UNKNOWN_FIELD' }))
    expect(() => compile({ model: 'payroll' }, man)).toThrow(expect.objectContaining({ code: 'PERMISSION_DENIED' }))
    expect(() => compile({ model: 'employees', groupBy: ['employee_name'] }, hr)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))   // not a dimension
    expect(() => compile({ model: 'employees', filters: [{ field: 'status', op: 'drop' as never, value: 'x' }] }, hr)).toThrow(expect.objectContaining({ code: 'VALIDATION_FAILED' }))
    const c = compile({ model: 'attendance', filters: [{ field: 'status', op: 'eq', value: "present'; DROP TABLE employees; --" }, { field: 'work_date', op: 'gte', value: '2026-10-01' }], sort: [{ field: 'work_date', dir: 'desc' }] }, man)
    expect(c.sql).not.toContain('DROP')
    expect(c.params[0]).toEqual([mgr, others[0], others[1]])          // scope cut comes first
    expect(c.params[1]).toBe("present'; DROP TABLE employees; --")    // bound, not interpolated
    expect(c.sql).toContain('a.employee_id = ANY($1::uuid[])')
    expect(catalogue(man).map((m) => m.key)).not.toContain('payroll')
    expect(catalogue(hr).map((m) => m.key)).toContain('payroll')
  })
})

describe('run', () => {
  it('rows for HR, scope-cut rows for the manager, grouped measures, CSV', async () => {
    const hr = buildContext({ tenantId: A.id, userId: hrUser, roles: ['hr_admin', 'payroll_admin'] })
    const man = buildContext({ tenantId: A.id, userId: mgrUser, employeeId: mgr, roles: ['manager'], reportIds: [others[0]!, others[1]!] })
    await withTenant(A.id, async (tx) => {
      const all = await runReport(tx, { model: 'attendance', columns: ['work_date', 'employee_name', 'status', 'late_minutes'] }, hr)
      expect(all.total).toBe(9)
      expect(all.columns.map((c) => c.label)).toEqual(['Date', 'Name', 'Status', 'Late (min)'])
      expect(all.rows[0]).toMatchObject({ work_date: '2026-10-01' })
      expect(all.csv.split('\n')[0]).toBe('Date,Name,Status,Late (min)')
      const mine = await runReport(tx, { model: 'attendance' }, man)
      expect(mine.total).toBe(6)                                                  // R3 is not their report
      const grouped = await runReport(tx, { model: 'attendance', groupBy: ['department', 'status'], measures: [{ field: '*', fn: 'count' }, { field: 'late_minutes', fn: 'sum' }], sort: [{ field: 'department' }, { field: 'status' }] }, hr)
      expect(grouped.rows).toEqual([
        { department: 'Ops', status: 'absent', count: 1, sum_late_minutes: 90 },
        { department: 'Ops', status: 'present', count: 2, sum_late_minutes: 90 },
        { department: 'Sales', status: 'absent', count: 2, sum_late_minutes: 90 },
        { department: 'Sales', status: 'present', count: 4, sum_late_minutes: 90 },
      ])
      const filtered = await runReport(tx, { model: 'employees', filters: [{ field: 'department', op: 'in', value: ['Sales'] }, { field: 'employee_name', op: 'contains', value: 'r' }], columns: ['employee_name'] }, hr)
      expect(filtered.rows.map((r) => r.employee_name).sort()).toEqual(['Mgr', 'R1', 'R2'])
      const limited = await runReport(tx, { model: 'attendance', limit: 2 }, hr)
      expect(limited).toMatchObject({ total: 2, truncated: true })
    })
  })
})

describe('saved reports and schedules', () => {
  it('mine or shared; a schedule runs as its owner and pauses when the owner cannot read the model', async () => {
    const hr = buildContext({ tenantId: A.id, userId: hrUser, roles: ['hr_admin', 'payroll_admin'] })
    const man = buildContext({ tenantId: A.id, userId: mgrUser, employeeId: mgr, roles: ['manager'], reportIds: [others[0]!, others[1]!] })
    await withTenant(A.id, async (tx) => {
      const priv = await saveReport(tx, hr, { name: 'Payroll by component', spec: { model: 'payroll', groupBy: ['component'], measures: [{ field: 'amount', fn: 'sum' }] } })
      const shared = await saveReport(tx, hr, { name: 'Late by dept', spec: { model: 'attendance', groupBy: ['department'], measures: [{ field: 'late_minutes', fn: 'sum' }] }, shared: true })
      await expect(saveReport(tx, hr, { name: 'Late by dept', spec: { model: 'attendance' } })).rejects.toMatchObject({ code: 'REPORT_EXISTS' })
      await expect(saveReport(tx, man, { name: 'x', spec: { model: 'payroll' } })).rejects.toMatchObject({ code: 'PERMISSION_DENIED' })
      expect((await listReports(tx, hr)).map((r) => r.name).sort()).toEqual(['Late by dept', 'Payroll by component'])
      expect((await listReports(tx, man)).map((r) => r.name)).toEqual(['Late by dept'])                  // shared AND readable
      expect(await getReport(tx, man, priv.id)).toBeNull()
      await expect(saveReport(tx, man, { id: shared.id, name: 'hijack', spec: { model: 'attendance' } })).rejects.toMatchObject({ code: 'NOT_FOUND' })   // not theirs
      // schedules
      expect(nextRunOn({ frequency: 'weekly', day_of_week: 1, day_of_month: null }, '2026-10-07')).toBe('2026-10-12')   // Wed → next Mon
      expect(nextRunOn({ frequency: 'monthly', day_of_week: null, day_of_month: 5 }, '2026-10-07')).toBe('2026-11-05')
      expect(nextRunOn({ frequency: 'monthly', day_of_week: null, day_of_month: 5 }, '2026-10-03')).toBe('2026-10-05')
      await expect(createSchedule(tx, man, { reportId: shared.id, frequency: 'daily', recipients: ['a@b.co'] })).rejects.toMatchObject({ code: 'NOT_FOUND' })   // not the owner
      await expect(createSchedule(tx, hr, { reportId: shared.id, frequency: 'daily', recipients: ['not-an-email'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const s = await createSchedule(tx, hr, { reportId: shared.id, frequency: 'daily', hour: 0, recipients: ['CFO@Example.com', 'cfo@example.com'], today: '2026-10-07' })
      expect(s).toMatchObject({ recipients: ['cfo@example.com'], next_run_on: '2026-10-07', status: 'active' })
      expect((await listSchedules(tx, hr)).length).toBe(1)
      // no sender mailbox configured → the run fails, records the error, moves on to tomorrow
      expect(await runDueSchedules(tx, { tenantId: A.id, senderEmail: null, companyName: 'Alpha', now: new Date('2026-10-07T03:00:00Z') })).toBe(0)
      let after = (await listSchedules(tx, hr))[0]!
      expect(after.last_error).toMatch(/sender/)
      expect(after).toMatchObject({ status: 'active', next_run_on: '2026-10-08' })
      // the owner loses the right (roles removed) → the schedule pauses itself with the reason
      await tx.query(`DELETE FROM user_roles WHERE user_id = $1`, [hrUser])
      await tx.query(`UPDATE report_schedules SET next_run_on = '2026-10-08'`)
      expect(await runDueSchedules(tx, { tenantId: A.id, senderEmail: null, companyName: 'Alpha', now: new Date('2026-10-08T03:00:00Z') })).toBe(0)
      const paused = (await tx.query<{ status: string; last_error: string }>(`SELECT status, last_error FROM report_schedules WHERE id = $1`, [s.id])).rows[0]!
      expect(paused.status).toBe('paused')
      expect(paused.last_error).toMatch(/attendance.read|Attendance/)
    })
  })
})

describe('every read model runs against the real schema', () => {
  it('rows and a grouped count for each model, every field selected', async () => {
    const admin = buildContext({ tenantId: A.id, userId: hrUser, roles: ['org_admin'] })
    await withTenant(A.id, async (tx) => {
      for (const m of catalogue(admin)) {
        const r = await runReport(tx, { model: m.key, columns: m.fields.map((f) => f.key), limit: 5 }, admin)
        expect(r.columns.length).toBe(m.fields.length)
        const dims = m.fields.filter((f) => f.dimension).map((f) => f.key)
        const g = await runReport(tx, { model: m.key, groupBy: dims.slice(0, 2), measures: [{ field: '*', fn: 'count' }] }, admin)
        expect(Array.isArray(g.rows)).toBe(true)
      }
    })
  })
})
