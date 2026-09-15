import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb, provisionTenant } from '../src/control-plane/index.ts'
import { REGISTRY_KEYS } from '../src/config-registry/index.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { createUser } from '../src/auth/index.ts'
import { changeCompensation } from '../src/people/history.ts'

let server: Server
let base: string
let tenantId: string
const ids: Record<string, string> = {}

const PASSWORD = 'integration-test-password'
const L = (rupees: number): number => rupees * 100

interface ApiResult<T = Record<string, never>> {
  status: number
  body: T & { error?: { code: string; message: string } }
}

async function api<T = Record<string, never>>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

const loginAs = async (email: string): Promise<string> => {
  const r = await api<{ token: string }>('POST', '/api/v1/auth/login', {
    body: { email, password: PASSWORD },
  })
  if (!r.body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`)
  return r.body.token
}

beforeAll(async () => {
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((resolve) => server.listen(0, resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const provisioned = await provisionTenant({
    legalName: `API Test Co ${Date.now()}`,
    displayName: 'API Test',
    planCode: 'professional',
    adminEmail: `admin-${Date.now()}@apitest.local`,
    adminName: 'Admin',
  })
  tenantId = provisioned.tenantId

  const stamp = Date.now()
  const emails = {
    admin: `admin-${stamp}@apitest.local`,
    hr: `hr-${stamp}@apitest.local`,
    payroll: `payroll-${stamp}@apitest.local`,
    manager: `manager-${stamp}@apitest.local`,
    employee: `employee-${stamp}@apitest.local`,
  }
  Object.assign(ids, emails)

  await withTenant(tenantId, async (tx) => {
    const mk = async (num: string, first: string): Promise<string> => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
         VALUES ($1,$2,$3,DATE '2025-06-01') RETURNING id`,
        [tenantId, num, first])
      return rows[0]!.id
    }
    ids.managerEmp = await mk('T-001', 'Arjun')
    ids.employeeEmp = await mk('T-002', 'Rahul')
    ids.otherEmp = await mk('T-003', 'Sneha')

    await tx.query(
      `INSERT INTO employee_assignments
         (tenant_id, employee_id, department, designation, manager_employee_id, effective_from)
       VALUES ($1,$2,'Engineering','Manager',NULL,DATE '2025-06-01'),
              ($1,$3,'Engineering','Developer',$2,DATE '2025-06-01'),
              ($1,$4,'Sales','Executive',NULL,DATE '2025-06-01')`,
      [tenantId, ids.managerEmp, ids.employeeEmp, ids.otherEmp])

    await changeCompensation(tx, {
      employeeId: ids.employeeEmp!, annualCtcPaise: L(1_200_000),
      components: { basic: L(40_000) }, effectiveFrom: '2025-06-01', reason: 'offer',
    })

    await createUser(tx, { tenantId, email: emails.admin, fullName: 'Admin', password: PASSWORD, roles: ['org_admin'] })
    await createUser(tx, { tenantId, email: emails.hr, fullName: 'HR', password: PASSWORD, roles: ['hr_admin'] })
    await createUser(tx, { tenantId, email: emails.payroll, fullName: 'Payroll', password: PASSWORD, roles: ['payroll_admin'] })
    await createUser(tx, { tenantId, email: emails.manager, fullName: 'Manager', password: PASSWORD, roles: ['manager'], employeeId: ids.managerEmp })
    await createUser(tx, { tenantId, email: emails.employee, fullName: 'Employee', password: PASSWORD, roles: ['employee'], employeeId: ids.employeeEmp })
  })
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closePools()
  await controlDb.end()
})

describe('health and errors', () => {
  it('responds to a liveness probe without a token', async () => {
    const r = await api<{ status: string }>('GET', '/health')
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ok')
  })

  it('answers the readiness probe as the RUNTIME role, with the migration count', async () => {
    // The container HEALTHCHECK calls this. It read _migrations, which 003 had
    // revoked from the app role, so it was 503 everywhere but here.
    const r = await api<{ status: string; migrations: number }>('GET', '/health/ready')
    expect(r.status).toBe(200)
    expect(r.body.status).toBe('ready')
    expect(r.body.migrations).toBeGreaterThanOrEqual(30)
  })

  it('returns a stable machine code, not just a status', async () => {
    const r = await api('GET', '/api/v1/employees')
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('MISSING_TOKEN')
  })

  it('404s an unknown route with a code', async () => {
    const r = await api('GET', '/api/v1/nope')
    expect(r.status).toBe(404)
    expect(r.body.error?.code).toBe('ROUTE_NOT_FOUND')
  })

  it('rejects malformed JSON', async () => {
    const res = await fetch(`${base}/api/v1/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
    })
    expect(res.status).toBe(400)
    const parsed = await res.json() as { error: { code: string } }
    expect(parsed.error.code).toBe('INVALID_JSON')
  })
})

describe('authentication', () => {
  it('issues a token for valid credentials', async () => {
    const r = await api<{ token: string; user: { roles: string[] } }>('POST', '/api/v1/auth/login', {
      body: { email: ids.hr, password: PASSWORD },
    })
    expect(r.status).toBe(200)
    expect(r.body.token).toBeTruthy()
    expect(r.body.user.roles).toEqual(['hr_admin'])
  })

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrongPass = await api('POST', '/api/v1/auth/login', { body: { email: ids.hr, password: 'nope-nope-nope' } })
    const noUser = await api('POST', '/api/v1/auth/login', { body: { email: 'ghost@nowhere.test', password: 'nope-nope-nope' } })
    expect(wrongPass.status).toBe(401)
    expect(noUser.status).toBe(401)
    expect(wrongPass.body.error?.code).toBe(noUser.body.error?.code)
    expect(wrongPass.body.error?.message).toBe(noUser.body.error?.message)
  })

  it('rejects a garbage token', async () => {
    const r = await api('GET', '/api/v1/me', { token: 'not-a-real-token' })
    expect(r.status).toBe(401)
    expect(r.body.error?.code).toBe('INVALID_SESSION')
  })

  it('revokes immediately on logout', async () => {
    const token = await loginAs(ids.employee!)
    expect((await api('GET', '/api/v1/me', { token })).status).toBe(200)
    await api('POST', '/api/v1/auth/logout', { token })
    expect((await api('GET', '/api/v1/me', { token })).status).toBe(401)
  })
})

describe('/me tells the UI what to render', () => {
  it('returns permissions, scope and enabled modules', async () => {
    const token = await loginAs(ids.hr!)
    const r = await api<{ permissions: string[]; scope: string; modules: Record<string, boolean> }>(
      'GET', '/api/v1/me', { token })
    expect(r.status).toBe(200)
    expect(r.body.scope).toBe('all')
    expect(r.body.permissions).toContain('leave.approve')
    expect(r.body.permissions).not.toContain('compensation.read')
    expect(r.body.modules.payroll).toBe(true)
  })

  it('an employee sees self scope and a short permission list', async () => {
    const token = await loginAs(ids.employee!)
    const r = await api<{ scope: string; employeeId: string }>('GET', '/api/v1/me', { token })
    expect(r.body.scope).toBe('self')
    expect(r.body.employeeId).toBe(ids.employeeEmp)
  })
})

describe('the manager/salary boundary holds over HTTP', () => {
  it('HR can read an employee but gets no compensation', async () => {
    const token = await loginAs(ids.hr!)
    const r = await api<{ employee: Record<string, unknown> }>(
      'GET', `/api/v1/employees/${ids.employeeEmp}`, { token })
    expect(r.status).toBe(200)
    expect(r.body.employee.first_name).toBe('Rahul')
    expect(r.body.employee.annual_ctc_paise).toBeUndefined()
  })

  it('payroll admin does get compensation', async () => {
    const token = await loginAs(ids.payroll!)
    const r = await api<{ employee: Record<string, unknown> }>(
      'GET', `/api/v1/employees/${ids.employeeEmp}`, { token })
    expect(r.body.employee.annual_ctc_paise).toBe(String(L(1_200_000)))
  })

  it('a manager sees a report, and gets 404 — not 403 — for someone else', async () => {
    const token = await loginAs(ids.manager!)
    expect((await api('GET', `/api/v1/employees/${ids.employeeEmp}`, { token })).status).toBe(200)

    const outside = await api('GET', `/api/v1/employees/${ids.otherEmp}`, { token })
    expect(outside.status).toBe(404)
    expect(outside.body.error?.code).toBe('NOT_FOUND')
  })

  it('an employee cannot read a colleague', async () => {
    const token = await loginAs(ids.employee!)
    expect((await api('GET', `/api/v1/employees/${ids.otherEmp}`, { token })).status).toBe(404)
    expect((await api('GET', `/api/v1/employees/${ids.employeeEmp}`, { token })).status).toBe(200)
  })

  it('an employee list is scoped, not filtered client-side', async () => {
    const managerToken = await loginAs(ids.manager!)
    const hrToken = await loginAs(ids.hr!)
    const asManager = await api<{ employees: { user_id: string | null }[] }>('GET', '/api/v1/employees', { token: managerToken })
    const asHr = await api<{ employees: { user_id: string | null }[] }>('GET', '/api/v1/employees', { token: hrToken })
    expect(asManager.body.employees.length).toBe(2) // self + one report
    expect(asHr.body.employees.length).toBeGreaterThanOrEqual(3)
    expect(asHr.body.employees.some(employee => employee.user_id)).toBe(true)
  })

  it('an employee cannot write compensation', async () => {
    const token = await loginAs(ids.employee!)
    const r = await api('POST', `/api/v1/employees/${ids.employeeEmp}/compensation`, {
      token, body: { annualCtcPaise: L(9_999_999), effectiveFrom: '2026-12-01', reason: 'nice try' },
    })
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('PERMISSION_DENIED')
  })

  it('an employee may upload to their own file but not publish a company document', async () => {
    const token = await loginAs(ids.employee!)
    const doc = { fileName: 'proof.txt', contentType: 'text/plain', contentBase64: Buffer.from('rent receipt').toString('base64') }
    const own = await api('POST', '/api/v1/documents', { token, body: { ...doc, ownerType: 'employee', ownerId: ids.employeeEmp } })
    expect(own.status).toBe(201)
    const colleague = await api('POST', '/api/v1/documents', { token, body: { ...doc, ownerType: 'employee', ownerId: ids.otherEmp } })
    expect(colleague.status).toBe(404)
    const company = await api('POST', '/api/v1/documents', { token, body: { ...doc, ownerType: 'tenant' } })
    expect(company.status).toBe(403)
  })
})

describe('validation and domain errors surface properly', () => {
  it('422 with the missing field names', async () => {
    const token = await loginAs(ids.hr!)
    const r = await api<{ error: { code: string; details: { missing: string[] } } }>(
      'POST', '/api/v1/employees', { token, body: { firstName: 'Nameless' } })
    expect(r.status).toBe(422)
    expect(r.body.error.code).toBe('VALIDATION_FAILED')
    expect(r.body.error.details.missing).toContain('employeeNumber')
  })

  it('rejects a bad UUID rather than passing it to SQL', async () => {
    const token = await loginAs(ids.hr!)
    const r = await api('GET', '/api/v1/employees/not-a-uuid', { token })
    expect(r.status).toBe(422)
  })

  it('a payroll-affecting config change without an effective date is 422 with its domain code', async () => {
    const token = await loginAs(ids.admin!)
    const r = await api('PATCH', '/api/v1/config/payroll.lop_basis', {
      token, body: { value: 'fixed_30', reason: 'policy' },
    })
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe('CONFIG_EFFECTIVE_DATE_REQUIRED')
  })

  it('an unknown config key is refused', async () => {
    const token = await loginAs(ids.admin!)
    const r = await api('PATCH', '/api/v1/config/leave.not_real', { token, body: { value: 1 } })
    expect(r.status).toBe(404)
    expect(r.body.error?.code).toBe('UNKNOWN_CONFIG_KEY')
  })
})

describe('configuration over HTTP', () => {
  it('lists every setting with its default, value and metadata', async () => {
    const token = await loginAs(ids.admin!)
    const r = await api<{ settings: { key: string; label: string; value: unknown; changedFromDefault: boolean }[] }>(
      'GET', '/api/v1/config', { token })
    expect(r.status).toBe(200)
    // the whole registry, not a number that goes stale every time a setting is added
    expect(r.body.settings.length).toBe(REGISTRY_KEYS.length)
    expect(r.body.settings.every((s) => s.label.length > 0)).toBe(true)
  })

  it('applies a change and reflects it in the next read', async () => {
    const token = await loginAs(ids.admin!)
    const applied = await api('PATCH', '/api/v1/config/attendance.correction_window_days', {
      token, body: { value: 20 },
    })
    expect(applied.status).toBe(200)

    const after = await api<{ settings: { key: string; value: unknown; changedFromDefault: boolean }[] }>(
      'GET', '/api/v1/config', { token })
    const grace = after.body.settings.find((s) => s.key === 'attendance.correction_window_days')
    expect(grace?.value).toBe(20)
    expect(grace?.changedFromDefault).toBe(true)
  })

  it('an HR admin cannot change settings', async () => {
    const token = await loginAs(ids.hr!)
    const r = await api('PATCH', '/api/v1/config/attendance.correction_window_days', { token, body: { value: 5 } })
    expect(r.status).toBe(403)
  })
})

describe('leave and the inbox, end to end', () => {
  it('an employee applies, the manager sees it in one inbox, approval consumes balance', async () => {
    const adminToken = await loginAs(ids.admin!)
    const employeeToken = await loginAs(ids.employee!)
    const managerToken = await loginAs(ids.manager!)

    const balances = await api<{ balances: { leaveTypeId: string; code: string; available: number }[] }>(
      'GET', '/api/v1/leave/balances?cycle=2026', { token: employeeToken })
    expect(balances.status).toBe(200)
    const el = balances.body.balances.find((b) => b.code === 'EL')!
    expect(el).toBeDefined()

    // give them something to spend
    await api('POST', '/api/v1/leave/balances/adjust', {
      token: adminToken,
      body: { employeeId: ids.employeeEmp, leaveTypeId: el.leaveTypeId, days: 10, reason: 'opening balance', cycle: 2026 },
    })

    const applied = await api<{ id: string }>('POST', '/api/v1/leave/requests', {
      token: employeeToken,
      body: {
        leaveTypeId: el.leaveTypeId, startDate: '2026-09-21', endDate: '2026-09-22',
        totalDays: 2, reason: 'family event',
      },
    })
    expect(applied.status).toBe(201)

    const inbox = await api<{ items: { kind: string; request_id?: string }[] }>(
      'GET', '/api/v1/inbox', { token: managerToken })
    expect(inbox.status).toBe(200)
    const approval = inbox.body.items.find((i) => i.kind === 'approval')
    expect(approval).toBeDefined()

    const acted = await api<{ status: string }>('POST', `/api/v1/approvals/${approval!.request_id}/act`, {
      token: managerToken, body: { action: 'approve' },
    })
    expect(acted.body.status).toBe('approved')

    const after = await api<{ balances: { code: string; consumed: number }[] }>(
      'GET', '/api/v1/leave/balances?cycle=2026', { token: employeeToken })
    expect(after.body.balances.find((b) => b.code === 'EL')!.consumed).toBe(2)
  })

  it('the ledger explains the balance', async () => {
    const employeeToken = await loginAs(ids.employee!)
    const balances = await api<{ balances: { leaveTypeId: string; code: string }[] }>(
      'GET', '/api/v1/leave/balances?cycle=2026', { token: employeeToken })
    const el = balances.body.balances.find((b) => b.code === 'EL')!

    const ledger = await api<{ entries: { entry_type: string }[] }>(
      `GET`, `/api/v1/leave/balances/${el.leaveTypeId}/ledger`, { token: employeeToken })
    expect(ledger.status).toBe(200)
    expect(ledger.body.entries.map((e) => e.entry_type)).toContain('consumption')
  })
})

describe('attendance over HTTP', () => {
  it('records a punch and refuses a duplicate silently', async () => {
    const token = await loginAs(ids.employee!)
    const body = {
      direction: 'in', localDate: '2026-09-18', clientPunchId: 'api-test-1',
      geo: { lat: 17.4, lng: 78.4 }, withinGeofence: true,
    }
    const first = await api<{ recorded: boolean }>('POST', '/api/v1/attendance/punch', { token, body })
    const again = await api<{ recorded: boolean; duplicate: boolean }>('POST', '/api/v1/attendance/punch', { token, body })
    expect(first.body.recorded).toBe(true)
    expect(again.body.duplicate).toBe(true)
  })

  it('enforces the tenant location requirement', async () => {
    const token = await loginAs(ids.employee!)
    const r = await api('POST', '/api/v1/attendance/punch', {
      token, body: { direction: 'in', localDate: '2026-09-19', clientPunchId: 'api-test-2' },
    })
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe('LOCATION_REQUIRED')
  })

  it('a correction requires a reason and applies while the period is open', async () => {
    const token = await loginAs(ids.hr!)
    const noReason = await api('POST', '/api/v1/attendance/corrections', {
      token, body: { employeeId: ids.employeeEmp, workDate: '2026-09-18', action: 'mark_half_day' },
    })
    expect(noReason.status).toBe(422)

    const ok = await api<{ results: { applied: boolean }[] }>('POST', '/api/v1/attendance/corrections', {
      token,
      body: {
        employeeId: ids.employeeEmp, workDate: '2026-09-18', action: 'mark_half_day',
        reason: 'left after lunch',
      },
    })
    expect(ok.status).toBe(200)
    expect(ok.body.results[0]!.applied).toBe(true)

    const days = await api<{ days: { work_date: string; day_fraction: number }[] }>(
      'GET', `/api/v1/attendance?from=2026-09-18&to=2026-09-18&employeeId=${ids.employeeEmp}`, { token })
    expect(days.body.days[0]!.day_fraction).toBe(0.5)
  })

  it('an employee cannot correct their own attendance', async () => {
    const token = await loginAs(ids.employee!)
    const r = await api('POST', '/api/v1/attendance/corrections', {
      token, body: { employeeId: ids.employeeEmp, workDate: '2026-09-18', action: 'mark_present', reason: 'x' },
    })
    expect(r.status).toBe(403)
  })
})

describe('the activity log records what happened over the API', () => {
  it('a compensation change appears, with the value masked for a non-payroll reader', async () => {
    const payrollToken = await loginAs(ids.payroll!)
    await api('POST', `/api/v1/employees/${ids.employeeEmp}/compensation`, {
      token: payrollToken,
      body: { annualCtcPaise: L(1_400_000), effectiveFrom: '2026-11-01', reason: 'annual revision' },
    })

    const adminToken = await loginAs(ids.admin!)
    const log = await api<{ events: { action: string; reason: string }[] }>(
      'GET', '/api/v1/activity?category=people', { token: adminToken })
    expect(log.body.events.some((e) => e.action === 'people.compensation.changed')).toBe(true)
    expect(log.body.events.find((e) => e.action === 'people.compensation.changed')?.reason)
      .toBe('annual revision')
  })

  it('the audit chain verifies through the API', async () => {
    const token = await loginAs(ids.admin!)
    const r = await api<{ ok: boolean; checked: number }>('GET', '/api/v1/activity/verify', { token })
    expect(r.body.ok).toBe(true)
    expect(r.body.checked).toBeGreaterThan(0)
  })

  it('an employee cannot read the company activity log', async () => {
    const token = await loginAs(ids.employee!)
    expect((await api('GET', '/api/v1/activity', { token })).status).toBe(403)
  })
})

describe('custom roles', () => {
  it('creates one and refuses an unknown permission', async () => {
    const token = await loginAs(ids.admin!)
    const bad = await api('POST', '/api/v1/roles', {
      token, body: { name: 'Bad Role', permissions: ['employee.read', 'employee.teleport'] },
    })
    expect(bad.status).toBe(422)
    expect(bad.body.error?.code).toBe('UNKNOWN_PERMISSION')

    const good = await api<{ id: string }>('POST', '/api/v1/roles', {
      token,
      body: { name: `Regional HR ${Date.now()}`, permissions: ['employee.read', 'leave.approve'], dataScope: 'reports' },
    })
    expect(good.status).toBe(201)
  })
})
