import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildUiRouter } from '../src/http/ui-routes.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { appendEntry, balance } from '../src/leave/ledger.ts'
import type { Workspace, Profile } from '../web/src/types.ts'

type TestResponse = Workspace & Profile & {
  id: string
  net: string
  token?: string
  status: string
  changed: boolean
  error: { code: string }
  totalDays: number
  skipped: { date: string; reason: string; charged: boolean }[]
}

let server: Server,
  base: string,
  A: Tenant,
  B: Tenant,
  managerEmployee: string,
  leaveType: string
const tokens: Record<string, string> = {},
  password = 'ui-integration-password'
async function request(path: string, role?: string, body?: unknown) {
  const response = await fetch(base + '/api/ui' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(role ? { Authorization: `Bearer ${tokens[role]}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return {
    status: response.status,
    body: (await response.json()) as TestResponse,
    headers: response.headers,
  }
}
beforeAll(async () => {
  ;({ a: A, b: B } = await resetAndSeed())
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"payroll":true}','{"employees":100}')`,
    [A.id],
  )
  await withTenant(A.id, async (tx) => {
    managerEmployee = (
      await tx.query(
        "INSERT INTO employees(tenant_id,employee_number,first_name,date_of_joining) VALUES($1,'M-001','Manager','2026-01-01') RETURNING id",
        [A.id],
      )
    ).rows[0]!.id
    await tx.query(
      'UPDATE employee_assignments SET manager_employee_id=$1 WHERE employee_id=$2',
      [managerEmployee, A.employeeId],
    )
    for (const [role, employeeId] of [
      ['org_admin', undefined],
      ['hr_admin', undefined],
      ['payroll_admin', undefined],
      ['manager', managerEmployee],
      ['employee', A.employeeId],
    ] as const) {
      await createUser(tx, {
        tenantId: A.id,
        email: role + '@ui.test',
        fullName: role,
        password,
        roles: [role],
        employeeId,
      })
    }
    leaveType = (
      await tx.query(
        "INSERT INTO leave_types(tenant_id,code,name) VALUES($1,'EL','Earned leave') RETURNING id",
        [A.id],
      )
    ).rows[0]!.id
    await appendEntry(tx, {
      employeeId: A.employeeId,
      leaveTypeId: leaveType,
      entryType: 'opening',
      deltaDays: 20,
      effectiveDate: '2026-04-01',
      cycleYear: 2026,
    })
  })
  for (const role of [
    'org_admin',
    'hr_admin',
    'payroll_admin',
    'manager',
    'employee',
  ])
    tokens[role] = (await login({ email: role + '@ui.test', password })).token
  server = createServer(createHandler(buildUiRouter()))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
})
afterAll(async () => {
  server?.closeAllConnections()
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await closePools()
  await controlPool.end()
})
describe('browser workspace boundary', () => {
  it('requires authentication and returns an HttpOnly session at sign in', async () => {
    expect((await request('/workspace')).status).toBe(401)
    const result = await request('/auth/login', undefined, {
      email: 'employee@ui.test',
      password,
    })
    expect(result.status).toBe(200)
    expect(result.headers.get('set-cookie')).toContain(
      'HttpOnly; SameSite=Strict',
    )
    expect(result.body.token).toBeUndefined()
  })
  it('limits people to the employee scope and never includes another tenant', async () => {
    const own = await request('/workspace', 'employee')
    expect(own.status).toBe(200)
    expect(own.body.employees.map((e: { id: string }) => e.id)).toEqual([
      A.employeeId,
    ])
    expect(JSON.stringify(own.body)).not.toContain(B.employeeId)
    expect(own.body.payroll).toEqual([])
    expect(own.body.settings).toEqual([])
  })
  it('lets managers see reports but not compensation', async () => {
    const result = await request('/workspace', 'manager')
    expect(result.body.employees).toHaveLength(2)
    const profile = await request('/employees/' + A.employeeId, 'manager')
    expect(profile.status).toBe(200)
    expect(profile.body.compensation).toEqual([])
    expect(
      (await request('/employees/' + B.employeeId, 'manager')).status,
    ).toBe(404)
  })
  it('rejects impossible dates and unauthorized writes', async () => {
    expect(
      (await request('/workspace?date=2026-02-30', 'org_admin')).status,
    ).toBe(422)
    expect(
      (
        await request('/employees', 'employee', {
          firstName: 'No',
          employeeNumber: 'X',
          dateOfJoining: '2026-09-09',
          department: 'Ops',
          designation: 'Staff',
        })
      ).status,
    ).toBe(403)
  })
  it('creates identity and the first assignment together', async () => {
    const result = await request('/employees', 'hr_admin', {
      firstName: 'Maya',
      lastName: 'Menon',
      employeeNumber: 'UI-003',
      dateOfJoining: '2026-09-09',
      department: 'Design',
      designation: 'Designer',
    })
    expect(result.status).toBe(201)
    const profile = await request('/employees/' + result.body.id, 'hr_admin')
    expect(profile.body.employee.first_name).toBe('Maya')
    expect(profile.body.assignments[0]!.department).toBe('Design')
  })
  it('rolls back employee creation when the assignment is invalid', async () => {
    const result = await request('/employees', 'org_admin', {
      firstName: 'Incomplete',
      employeeNumber: 'UI-BAD',
      dateOfJoining: '2026-09-09',
      department: ' ',
      designation: 'Designer',
    })
    expect(result.status).toBe(422)
    const workspace = await request('/workspace', 'org_admin')
    expect(
      workspace.body.employees.some(
        (e: { employee_number: string }) => e.employee_number === 'UI-BAD',
      ),
    ).toBe(false)
  })
  it('allows leave submission, manager decision and one ledger debit', async () => {
    const result = await request('/leave/requests', 'employee', {
      leaveTypeId: leaveType,
      startDate: '2026-10-12',
      endDate: '2026-10-13',
      reason: 'Family time',
    })
    expect(result.status).toBe(201)
    const duplicate = await request('/leave/requests', 'employee', {
      leaveTypeId: leaveType,
      startDate: '2026-10-12',
      endDate: '2026-10-13',
      reason: 'Duplicate',
    })
    expect(duplicate.status).toBe(409)
    const workspace = await request('/workspace', 'manager'),
      approval = workspace.body.approvals.find(
        (a: { entity_id: string }) => a.entity_id === result.body.id,
      )
    expect(approval).toBeDefined()
    const action = await request(
      `/approvals/${approval!.request_id}/actions`,
      'manager',
      { action: 'approve' },
    )
    expect(action.status).toBe(200)
    expect(action.body.status).toBe('approved')
    expect(
      (
        await request(`/approvals/${approval!.request_id}/actions`, 'manager', {
          action: 'approve',
        })
      ).body.changed,
    ).toBe(false)
    await withTenant(A.id, async (tx) => {
      expect((await balance(tx, A.employeeId, leaveType, 2026)).available).toBe(
        18,
      )
      const days = await tx.query(
        "SELECT status FROM daily_attendance WHERE employee_id=$1 AND work_date='2026-10-12'",
        [A.employeeId],
      )
      expect(days.rows[0]?.status).toBe('on_leave')
    })
  })
  it('counts working days like the domain API: Fri–Mon on a six-day week costs 3 (Sunday off), the off day is neither charged nor marked, rejection is recorded', async () => {
    // 2026-10-16 is a Friday, 2026-10-19 a Monday
    const result = await request('/leave/requests', 'employee', {
      leaveTypeId: leaveType, startDate: '2026-10-16', endDate: '2026-10-19', reason: 'Long weekend',
    })
    expect(result.status).toBe(201)
    expect(result.body.totalDays).toBe(3)                     // default week pattern is six_day: only Sunday is off
    expect(result.body.skipped.map((d: { date: string; reason: string }) => [d.date, d.reason])).toEqual([['2026-10-18', 'weekly_off']])
    // the client's own count is checked, never trusted
    const mismatch = await request('/leave/requests', 'employee', {
      leaveTypeId: leaveType, startDate: '2026-11-06', endDate: '2026-11-09', reason: 'x', totalDays: 4,   // Fri–Mon is 3 here
    })
    expect(mismatch.status).toBe(422)
    expect(mismatch.body.error.code).toBe('LEAVE_DAYS_MISMATCH')

    const workspace = await request('/workspace', 'manager'),
      approval = workspace.body.approvals.find((a: { entity_id: string }) => a.entity_id === result.body.id)
    const before = await withTenant(A.id, (tx) => balance(tx, A.employeeId, leaveType, 2026))
    const action = await request(`/approvals/${approval!.request_id}/actions`, 'manager', { action: 'approve' })
    expect(action.body.status).toBe('approved')
    await withTenant(A.id, async (tx) => {
      expect((await balance(tx, A.employeeId, leaveType, 2026)).available).toBe(before.available - 3)
      const days = await tx.query<{ work_date: string; status: string }>(
        "SELECT work_date::text, status FROM daily_attendance WHERE employee_id=$1 AND work_date BETWEEN '2026-10-16' AND '2026-10-19' ORDER BY work_date",
        [A.employeeId])
      expect(days.rows).toEqual([{ work_date: '2026-10-16', status: 'on_leave' }, { work_date: '2026-10-17', status: 'on_leave' }, { work_date: '2026-10-19', status: 'on_leave' }])
    })

    // a rejection is written back to the request, and the balance is untouched
    const second = await request('/leave/requests', 'employee', {
      leaveTypeId: leaveType, startDate: '2026-11-02', endDate: '2026-11-02', reason: 'Errand',
    })
    const ws2 = await request('/workspace', 'manager'),
      ap2 = ws2.body.approvals.find((a: { entity_id: string }) => a.entity_id === second.body.id)
    const rejected = await request(`/approvals/${ap2!.request_id}/actions`, 'manager', { action: 'reject', comment: 'month end' })
    expect(rejected.body.status).toBe('rejected')
    await withTenant(A.id, async (tx) => {
      const r = await tx.query<{ status: string }>('SELECT status FROM leave_requests WHERE id=$1', [second.body.id])
      expect(r.rows[0]!.status).toBe('rejected')
      expect((await balance(tx, A.employeeId, leaveType, 2026)).available).toBe(before.available - 3)
    })
  })
  it('rejects unsupported approval actions before they can approve anything', async () => {
    const result = await request(
      '/approvals/' + crypto.randomUUID() + '/actions',
      'manager',
      { action: 'typo' },
    )
    expect(result.status).toBe(422)
  })
  it('validates correction actions and respects data scope', async () => {
    expect(
      (
        await request('/attendance/corrections', 'manager', {
          employeeId: A.employeeId,
          workDate: '2026-09-09',
          action: 'typo',
          reason: 'test',
        })
      ).status,
    ).toBe(422)
    expect(
      (
        await request('/attendance/corrections', 'manager', {
          employeeId: B.employeeId,
          workDate: '2026-09-09',
          action: 'mark_present',
          reason: 'test',
        })
      ).status,
    ).toBe(404)
  })
  it('runs payroll through frozen inputs, calculation, validation and separate approval', async () => {
    await controlPool.query(
      `INSERT INTO statutory_configs(effective_from,pf_employee_rate,pf_employer_rate,pf_wage_ceiling_paise,esi_employee_rate,esi_employer_rate,esi_gross_threshold_paise) VALUES('2026-04-01',0.12,0.12,1500000,0.0075,0.0325,2100000) ON CONFLICT(effective_from) DO NOTHING`,
    )
    const period = await withTenant(
      A.id,
      async (tx) =>
        (
          await tx.query(
            "INSERT INTO payroll_periods(tenant_id,label,period_start,period_end,pay_date) VALUES($1,'2026-10','2026-10-01','2026-10-31','2026-11-01') RETURNING id",
            [A.id],
          )
        ).rows[0]!.id,
    )
    const created = await request('/payroll/runs', 'payroll_admin', {
      periodId: period,
    })
    expect(created.status).toBe(201)
    const path = '/payroll/' + created.body.id + '/actions'
    expect(
      (await request(path, 'employee', { action: 'freeze', rows: [] })).status,
    ).toBe(403)
    expect(
      (await request(path, 'payroll_admin', { action: 'calculate' })).status,
    ).toBeGreaterThanOrEqual(400)
    const frozen = await request(path, 'payroll_admin', {
      action: 'freeze',
      rows: [
        {
          employeeId: A.employeeId,
          calendarDays: 31,
          payableDays: 31,
          lopDays: 0,
          monthlyComponents: { basic: 5000000 },
          annualCtcPaise: 60000000,
          stateCode: 'TS',
          pfApplicable: true,
          esiApplicable: false,
        },
      ],
    })
    expect(frozen.status).toBe(200)
    const calculated = await request(path, 'payroll_admin', {
      action: 'calculate',
    })
    expect(calculated.status).toBe(200)
    expect(Number(calculated.body.net)).toBeGreaterThan(0)
    expect(
      (await request(path, 'payroll_admin', { action: 'validate' })).status,
    ).toBe(200)
    const sameActor = await request(path, 'payroll_admin', {
      action: 'approve',
    })
    expect(sameActor.body.error.code).toBe('SEPARATION_OF_DUTY')
    expect(
      (await request(path, 'org_admin', { action: 'approve' })).status,
    ).toBe(200)
    expect((await request(path, 'org_admin', { action: 'lock' })).status).toBe(
      200,
    )
    expect(
      (await request(path, 'org_admin', { action: 'unfreeze' })).status,
    ).toBeGreaterThanOrEqual(400)
    expect((await request('/workspace', 'hr_admin')).body.payroll).toEqual([])
    expect((await request('/workspace', 'employee')).body.payslips).toEqual([])
    const revision = await request(path, 'org_admin', {
      action: 'revise',
      reason: 'Approved correction',
    })
    expect(revision.status).toBe(201)
  })
})

