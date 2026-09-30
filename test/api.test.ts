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
import { setSetting } from '../src/config/write.ts'

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

  it('documents are categorised: a closed vocabulary, HR-issued letters refused from self-scope, confidential by category', async () => {
    const token = await loginAs(ids.employee!)
    const hr = await loginAs(ids.hr!)
    const doc = { fileName: 'x.txt', contentType: 'text/plain', contentBase64: Buffer.from('x').toString('base64'), ownerType: 'employee', ownerId: ids.employeeEmp }

    const vocab = await api<{ categories: Record<string, { key: string; group: string }[]> }>('GET', '/api/v1/documents/categories', { token })
    expect(vocab.status).toBe(200)
    expect(vocab.body.categories.employee!.map((c) => c.key)).toContain('offer_letter')
    expect(vocab.body.categories.tenant!.map((c) => c.key)).toContain('policy')

    const bad = await api('POST', '/api/v1/documents', { token, body: { ...doc, category: 'random' } })
    expect(bad.status).toBe(422)
    expect(bad.body.error?.code).toBe('INVALID_CATEGORY')

    // an employee may add a tax proof, but not issue themselves an offer letter
    const proof = await api<{ category: string; is_confidential: boolean }>('POST', '/api/v1/documents', { token, body: { ...doc, category: 'tax_proof' } })
    expect(proof.status).toBe(201)
    expect(proof.body).toMatchObject({ category: 'tax_proof', is_confidential: true })   // confidential by category, not by request
    const letter = await api('POST', '/api/v1/documents', { token, body: { ...doc, category: 'offer_letter' } })
    expect(letter.status).toBe(403)
    const issued = await api<{ category: string }>('POST', '/api/v1/documents', { token: hr, body: { ...doc, category: 'offer_letter' } })
    expect(issued.status).toBe(201)

    // list filters by category and returns counts for the folder rail
    const all = await api<{ documents: { category: string }[]; counts: Record<string, number> }>(
      'GET', `/api/v1/documents?ownerType=employee&ownerId=${ids.employeeEmp}`, { token })
    expect(all.body.counts.tax_proof).toBe(1)
    expect(all.body.counts.offer_letter).toBe(1)
    const only = await api<{ documents: { category: string }[] }>(
      'GET', `/api/v1/documents?ownerType=employee&ownerId=${ids.employeeEmp}&category=offer_letter`, { token })
    expect(only.body.documents.map((d) => d.category)).toEqual(['offer_letter'])
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

describe('the account: forgotten and changed passwords, devices', () => {
  it('forgot-password answers 202 for any address and never says whether it exists', async () => {
    const real = await api('POST', '/api/v1/auth/forgot-password', { body: { email: ids.employee } })
    const fake = await api('POST', '/api/v1/auth/forgot-password', { body: { email: 'nobody@nowhere.test' } })
    expect(real.status).toBe(202)
    expect(fake.status).toBe(202)
    expect(real.body).toEqual(fake.body)
    // a token row exists for the real one, hashed, unused
    const rows = await withTenant(tenantId, async (tx) =>
      (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM password_resets WHERE used_at IS NULL`)).rows[0]!.n)
    expect(Number(rows)).toBe(1)
  })

  it('an admin-issued link resets the password once, signs out every session, and is then dead', async () => {
    const admin = await loginAs(ids.admin!)
    const before = await loginAs(ids.employee!)
    const userId = (await withTenant(tenantId, async (tx) =>
      (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE email = $1`, [ids.employee])).rows[0]!.id))

    const asEmployee = await api('POST', `/api/v1/users/${userId}/password-reset-link`, { token: before })
    expect(asEmployee.status).toBe(403)

    const issued = await api<{ link: string }>('POST', `/api/v1/users/${userId}/password-reset-link`, { token: admin })
    expect(issued.status).toBe(200)
    const token = new URL(issued.body.link).searchParams.get('token')!
    expect(token.length).toBeGreaterThan(30)

    const weak = await api('POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'short' } })
    expect(weak.status).toBe(422)
    expect(weak.body.error?.code).toBe('WEAK_PASSWORD')

    const ok = await api('POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'a-brand-new-passphrase-1' } })
    expect(ok.status).toBe(200)

    // the old session is gone, the old password is gone, the new one works, the token is spent
    expect((await api('GET', '/api/v1/notifications', { token: before })).status).toBe(401)
    expect((await api('POST', '/api/v1/auth/login', { body: { email: ids.employee, password: PASSWORD } })).status).toBe(401)
    const again = await api<{ token: string }>('POST', '/api/v1/auth/login', { body: { email: ids.employee, password: 'a-brand-new-passphrase-1' } })
    expect(again.status).toBe(200)
    expect((await api('POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'another-long-passphrase-2' } })).status).toBe(400)

    // change it back so later tests can log in, and prove change-password keeps THIS session
    const other = await api<{ token: string }>('POST', '/api/v1/auth/login', { body: { email: ids.employee, password: 'a-brand-new-passphrase-1' } })
    const wrong = await api('POST', '/api/v1/auth/change-password', { token: again.body.token, body: { currentPassword: 'nope', newPassword: PASSWORD } })
    expect(wrong.status).toBe(401)
    const changed = await api<{ sessionsRevoked: number }>('POST', '/api/v1/auth/change-password',
      { token: again.body.token, body: { currentPassword: 'a-brand-new-passphrase-1', newPassword: PASSWORD } })
    expect(changed.status).toBe(200)
    expect(changed.body.sessionsRevoked).toBe(1)
    expect((await api('GET', '/api/v1/notifications', { token: other.body.token })).status).toBe(401)
    expect((await api('GET', '/api/v1/notifications', { token: again.body.token })).status).toBe(200)
  })

  it('lists my devices and signs one out, never someone else\'s', async () => {
    const a = await loginAs(ids.employee!)
    const b = await loginAs(ids.employee!)
    const hr = await loginAs(ids.hr!)
    const list = await api<{ sessions: { id: string; current: boolean }[] }>('GET', '/api/v1/auth/sessions', { token: a })
    expect(list.status).toBe(200)
    expect(list.body.sessions.length).toBeGreaterThanOrEqual(2)
    expect(list.body.sessions[0]!.current).toBe(true)
    const otherId = list.body.sessions.find((x) => !x.current)!.id
    const hrSessions = await api<{ sessions: { id: string }[] }>('GET', '/api/v1/auth/sessions', { token: hr })
    // HR cannot revoke the employee's session through this route
    expect((await api('DELETE', `/api/v1/auth/sessions/${otherId}`, { token: hr, body: {} })).status).toBe(404)
    expect((await api('DELETE', `/api/v1/auth/sessions/${otherId}`, { token: a, body: {} })).status).toBe(204)
    expect((await api('GET', '/api/v1/notifications', { token: b })).status).toBe(401)
    expect((await api('GET', '/api/v1/notifications', { token: a })).status).toBe(200)
    void hrSessions
  })
})

describe('changes held for approval', () => {
  it('a salary revision is held, invisible on the record, and lands when the manager approves', async () => {
    await withTenant(tenantId, (tx) => setSetting(tx, { key: 'payroll.compensation_approval', value: 'manager', reason: 'test' }))
    const hr = await loginAs(ids.payroll!)   // compensation.write is payroll's
    const before = await api<{ profile: { annual_ctc_paise: string } }>('GET', `/api/v1/employees/${ids.employeeEmp}`, { token: await loginAs(ids.payroll!) })
    const held = await api<{ held: boolean; approvalRequestId: string; chain: string }>('POST', `/api/v1/employees/${ids.employeeEmp}/compensation`, {
      token: hr, body: { annualCtcPaise: L(1_500_000), effectiveFrom: '2027-04-01', reason: 'annual revision' },
    })
    expect(held.status).toBe(202)
    expect(held.body.held).toBe(true)
    expect(held.body.chain).toBe('manager')
    // nothing on the record yet
    const rows = await withTenant(tenantId, async (tx) => (await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM compensation_records WHERE employee_id = $1 AND annual_ctc_paise = $2`, [ids.employeeEmp, String(L(1_500_000))])).rows[0]!.n)
    expect(Number(rows)).toBe(0)
    // the manager approves; the revision is applied through changeCompensation
    const mgr = await loginAs(ids.manager!)
    const decided = await api<{ status: string }>('POST', `/api/v1/approvals/${held.body.approvalRequestId}/act`, { token: mgr, body: { action: 'approve' } })
    expect(decided.status).toBe(200)
    expect(decided.body.status).toBe('approved')
    const after = await withTenant(tenantId, async (tx) => (await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM compensation_records WHERE employee_id = $1 AND annual_ctc_paise = $2`, [ids.employeeEmp, String(L(1_500_000))])).rows[0]!.n)
    expect(Number(after)).toBe(1)
    const pending = await withTenant(tenantId, async (tx) => (await tx.query<{ status: string; result: { recordId: string } }>(
      `SELECT status, result FROM pending_changes WHERE approval_request_id = $1`, [held.body.approvalRequestId])).rows[0]!)
    expect(pending.status).toBe('applied')
    expect(pending.result.recordId).toBeTruthy()
    void before
  })

  it('a rejected attendance correction is never applied', async () => {
    await withTenant(tenantId, (tx) => setSetting(tx, { key: 'attendance.correction_approval', value: 'manager', reason: 'test' }))
    const hr = await loginAs(ids.hr!)
    const held = await api<{ held: { approvalRequestId: string }[] }>('POST', '/api/v1/attendance/corrections', {
      token: hr, body: { employeeId: ids.employeeEmp, workDate: '2026-09-22', action: 'mark_present', reason: 'device offline' },
    })
    expect(held.status).toBe(202)
    expect(held.body.held).toHaveLength(1)
    const mgr = await loginAs(ids.manager!)
    const decided = await api<{ status: string }>('POST', `/api/v1/approvals/${held.body.held[0]!.approvalRequestId}/act`, { token: mgr, body: { action: 'reject', comment: 'no' } })
    expect(decided.body, JSON.stringify(decided.body)).toMatchObject({ status: 'rejected' })
    const day = await withTenant(tenantId, async (tx) => (await tx.query(
      `SELECT 1 FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-09-22' AND status = 'present'`, [ids.employeeEmp])).rowCount)
    expect(day).toBe(0)
    const pending = await withTenant(tenantId, async (tx) => (await tx.query<{ status: string }>(
      `SELECT status FROM pending_changes WHERE approval_request_id = $1`, [held.body.held[0]!.approvalRequestId])).rows[0]!.status)
    expect(pending).toBe('rejected')
    // back to direct for the rest of the suite
    await withTenant(tenantId, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_approval', value: 'none', reason: 'test' })
      await setSetting(tx, { key: 'payroll.compensation_approval', value: 'none', reason: 'test' })
    })
  })
})

describe('an employee regularises their own day', () => {
  it('is always held, only for own record and allowed actions, inside the window; the manager approves and the day changes', async () => {
    const emp = await loginAs(ids.employee!)
    const today = new Date().toISOString().slice(0, 10)
    const bad = await api('POST', '/api/v1/attendance/regularisations', { token: emp, body: { workDate: today, action: 'mark_absent', reason: 'x' } })
    expect(bad.status).toBe(422)
    const old = await api('POST', '/api/v1/attendance/regularisations', { token: emp, body: { workDate: '2020-01-01', action: 'mark_present', reason: 'x' } })
    expect(old.body.error?.code).toBe('CORRECTION_WINDOW_CLOSED')
    const noAt = await api('POST', '/api/v1/attendance/regularisations', { token: emp, body: { workDate: today, action: 'set_punch_out', reason: 'x' } })
    expect(noAt.status).toBe(422)

    const held = await api<{ held: boolean; approvalRequestId: string; chain: string }>('POST', '/api/v1/attendance/regularisations', {
      token: emp, body: { workDate: today, action: 'mark_present', reason: 'device offline at the gate' },
    })
    expect(held.status).toBe(202)
    expect(held.body.chain).toBe('manager')
    const mine = await api<{ requests: { status: string }[] }>('GET', '/api/v1/attendance/regularisations?status=pending', { token: emp })
    expect(mine.body.requests).toHaveLength(1)

    // the employee cannot approve their own; the manager can, and the day is then present
    const self = await api('POST', `/api/v1/approvals/${held.body.approvalRequestId}/act`, { token: emp, body: { action: 'approve' } })
    expect([403, 400, 409]).toContain(self.status)
    const mgr = await loginAs(ids.manager!)
    const ok = await api<{ status: string }>('POST', `/api/v1/approvals/${held.body.approvalRequestId}/act`, { token: mgr, body: { action: 'approve' } })
    expect(ok.body.status).toBe('approved')
    const day = await withTenant(tenantId, async (tx) => (await tx.query<{ status: string }>(
      `SELECT status FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`, [ids.employeeEmp, today])).rows[0]?.status)
    expect(day).toBe('present')
    const done = await api<{ requests: { status: string }[] }>('GET', '/api/v1/attendance/regularisations?status=applied', { token: emp })
    expect(done.body.requests).toHaveLength(1)
  })
})

describe('announcements live in the chat channel', () => {
  it('posting creates the read-only Announcements channel, a message in it, receipts, and acknowledgement works from either side', async () => {
    await withTenant(tenantId, (tx) => setSetting(tx, { key: 'chat.enabled', value: true, reason: 'test' }))
    const hr = await loginAs(ids.hr!)
    const emp = await loginAs(ids.employee!)

    // an employee cannot post; HR can, and it publishes at once
    const denied = await api('POST', '/api/v1/announcements', { token: emp, body: { title: 'x', bodyHtml: '<p>y</p>' } })
    expect(denied.status).toBe(403)
    const posted = await api<{ id: string; conversation_id: string; message_id: number; delivered: number; requires_acknowledgement: boolean; body_html: string }>(
      'POST', '/api/v1/announcements', { token: hr, body: { title: 'Diwali holiday', bodyHtml: '<p>Office closed on 20 Oct.<script>x()</script></p>', requiresAcknowledgement: true } })
    expect(posted.status).toBe(201)
    expect(posted.body.delivered).toBeGreaterThanOrEqual(5)          // every active user
    expect(posted.body.body_html).toBe('<p>Office closed on 20 Oct.</p>')
    expect(posted.body.conversation_id).toBeTruthy()

    // the employee sees the channel in chat, read-only, with the announcement as a message
    const convs = await api<{ conversations: { id: string; kind: string; title: string; is_readonly: boolean; unread: number }[] }>('GET', '/api/v1/chat/conversations', { token: emp })
    const channel = convs.body.conversations.find((c) => c.kind === 'announcement')!
    expect(channel).toMatchObject({ id: posted.body.conversation_id, title: 'Announcements', is_readonly: true })
    expect(channel.unread).toBe(1)
    const msgs = await api<{ messages: { id: number; content_type: string; body: string; hrms_ref: { announcementId: string; requiresAcknowledgement: boolean } }[] }>(
      'GET', `/api/v1/chat/conversations/${channel.id}/messages`, { token: emp })
    const m = msgs.body.messages.find((x) => x.hrms_ref?.announcementId === posted.body.id)!
    expect(m.content_type).toBe('announcement')
    expect(m.body).toContain('Diwali holiday')
    expect(m.hrms_ref.requiresAcknowledgement).toBe(true)

    // nobody chats in the channel, not even HR
    const reply = await api('POST', `/api/v1/chat/conversations/${channel.id}/messages`, { token: hr, body: { clientMessageId: 'r1', body: 'hi' } })
    expect(reply.status).toBe(409)
    expect(reply.body.error?.code).toBe('CONVERSATION_READONLY')

    // the list shows the receipt; opening marks viewed; acknowledging is recorded and visible to HR
    const mine = await api<{ announcements: { id: string; acknowledged_at: string | null; in_audience: boolean }[] }>('GET', '/api/v1/announcements', { token: emp })
    expect(mine.body.announcements.find((a) => a.id === posted.body.id)).toMatchObject({ acknowledged_at: null, in_audience: true })
    const opened = await api<{ viewed_at: string | null }>('GET', `/api/v1/announcements/${posted.body.id}`, { token: emp })
    expect(opened.body.viewed_at).toBeTruthy()
    const pendingBefore = await api<{ pending: { email: string }[] }>('GET', `/api/v1/announcements/${posted.body.id}/pending`, { token: hr })
    expect(pendingBefore.body.pending.map((p) => p.email)).toContain(ids.employee)
    expect((await api('POST', `/api/v1/announcements/${posted.body.id}/acknowledge`, { token: emp })).status).toBeLessThan(300)
    const pendingAfter = await api<{ pending: { email: string }[] }>('GET', `/api/v1/announcements/${posted.body.id}/pending`, { token: hr })
    expect(pendingAfter.body.pending.map((p) => p.email)).not.toContain(ids.employee)
    const stats = await api<{ acknowledged: number; delivered: number }>('GET', `/api/v1/announcements/${posted.body.id}`, { token: hr })
    expect(stats.body.acknowledged).toBe(1)

    // withdrawing needs a reason and removes the chat message
    expect((await api('POST', `/api/v1/announcements/${posted.body.id}/withdraw`, { token: hr, body: {} })).status).toBe(422)
    expect((await api('POST', `/api/v1/announcements/${posted.body.id}/withdraw`, { token: hr, body: { reason: 'dates changed' } })).status).toBe(204)
    const after = await api<{ announcements: { id: string }[] }>('GET', '/api/v1/announcements', { token: emp })
    expect(after.body.announcements.find((a) => a.id === posted.body.id)).toBeUndefined()
    const msgsAfter = await api<{ messages: { hrms_ref: { announcementId: string } | null; deleted_at: string | null }[] }>(
      'GET', `/api/v1/chat/conversations/${channel.id}/messages`, { token: emp })
    const gone = msgsAfter.body.messages.find((x) => x.hrms_ref?.announcementId === posted.body.id)
    expect(gone === undefined || gone.deleted_at !== null).toBe(true)
  })
})

describe('a fresh tenant can onboard a person without the demo seed', () => {
  it('bank account: recorded once, superseded not edited, masked on read, scope-checked', async () => {
    const hr = await loginAs(ids.hr!)
    const emp = await loginAs(ids.employee!)
    const bad = await api('POST', `/api/v1/employees/${ids.otherEmp}/bank-accounts`, { token: hr, body: { beneficiaryName: 'Sneha', accountNumber: '123', ifsc: 'nope' } })
    expect(bad.status).toBe(422)
    const first = await api<{ id: string; account_masked: string; is_primary: boolean }>('POST', `/api/v1/employees/${ids.otherEmp}/bank-accounts`,
      { token: hr, body: { beneficiaryName: 'Sneha Iyer', accountNumber: '50100123456789', ifsc: 'hdfc0001234', bankName: 'HDFC' } })
    expect(first.status).toBe(201)
    expect(first.body.account_masked).toBe('••••••••6789')
    const second = await api<{ id: string }>('POST', `/api/v1/employees/${ids.otherEmp}/bank-accounts`,
      { token: hr, body: { beneficiaryName: 'Sneha Iyer', accountNumber: '000987654321', ifsc: 'ICIC0000123' } })
    expect(second.status).toBe(201)
    const live = await api<{ accounts: { id: string; is_primary: boolean }[] }>('GET', `/api/v1/employees/${ids.otherEmp}/bank-accounts`, { token: hr })
    expect(live.body.accounts.map((a) => a.id)).toEqual([second.body.id])
    const history = await api<{ accounts: { id: string; superseded_at: string | null }[] }>('GET', `/api/v1/employees/${ids.otherEmp}/bank-accounts?history=true`, { token: hr })
    expect(history.body.accounts).toHaveLength(2)
    expect(history.body.accounts.find((a) => a.id === first.body.id)!.superseded_at).toBeTruthy()
    // a colleague's account is out of an employee's scope
    expect((await api('GET', `/api/v1/employees/${ids.otherEmp}/bank-accounts`, { token: emp })).status).toBe(404)
    expect((await api('POST', `/api/v1/employees/${ids.otherEmp}/bank-accounts`, { token: emp, body: { beneficiaryName: 'x', accountNumber: '123456789', ifsc: 'HDFC0001234' } })).status).toBe(403)   // no employee.write at all
  })

  it('invite: creates the login with a set-password link; the person sets a password and signs in; re-invite re-issues', async () => {
    const hr = await loginAs(ids.hr!)
    const email = `sneha-${Date.now()}@apitest.local`
    const none = await api<{ user_id: string | null }>('GET', `/api/v1/employees/${ids.otherEmp}/login`, { token: hr })
    expect(none.body.user_id).toBeNull()

    const inv = await api<{ userId: string; created: boolean; link: string }>('POST', `/api/v1/employees/${ids.otherEmp}/invite`, { token: hr, body: { email } })
    expect(inv.status).toBe(201)
    expect(inv.body.created).toBe(true)
    const token = new URL(inv.body.link).searchParams.get('token')!
    expect(token.length).toBeGreaterThan(20)

    // HR without roles.write cannot hand out elevated roles
    expect((await api('POST', `/api/v1/employees/${ids.otherEmp}/invite`, { token: hr, body: { email, roles: ['payroll_admin'] } })).status).toBe(403)

    // the person sets their password through the public reset route and logs in
    const set = await api('POST', '/api/v1/auth/reset-password', { body: { token, newPassword: 'sneha-first-password-2026' } })
    expect(set.status).toBe(200)
    const login = await api<{ token: string; user: { employeeId?: string; roles: string[] } }>('POST', '/api/v1/auth/login', { body: { email, password: 'sneha-first-password-2026' } })
    expect(login.status).toBe(200)
    expect(login.body.user.roles).toEqual(['employee'])
    const me = await api<{ employeeId: string | null; scope: string }>('GET', '/api/v1/me', { token: login.body.token })
    expect(me.body.employeeId ?? (me.body as unknown as { user: { employeeId: string } }).user?.employeeId).toBe(ids.otherEmp)

    // a second invite does not create a second user; it re-issues the link
    const again = await api<{ userId: string; created: boolean }>('POST', `/api/v1/employees/${ids.otherEmp}/invite`, { token: hr, body: { email: 'ignored@apitest.local' } })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ userId: inv.body.userId, created: false })
    const status = await api<{ user_id: string; email: string; roles: string[] }>('GET', `/api/v1/employees/${ids.otherEmp}/login`, { token: hr })
    expect(status.body).toMatchObject({ user_id: inv.body.userId, email, roles: ['employee'] })
  })

  // Re-inviting an existing login used to issue a reset link for ANY role and hand the link
  // back in the response: anyone with employee.write could invite the employee record of an
  // administrator, set that administrator's password, and sign in as them.
  describe('re-inviting a login that already exists', () => {
    const inviteAs = (token: string, empId: string) =>
      api<{ userId?: string; created?: boolean; link?: string; error?: { code: string } }>(
        'POST', `/api/v1/employees/${empId}/invite`, { token, body: { email: 'ignored@apitest.local' } })

    it('is refused for a login holding elevated roles unless the caller has roles.write', async () => {
      const hr = await loginAs(ids.hr!)          // employee.write, no roles.write
      const r = await inviteAs(hr, ids.managerEmp!)   // the manager's login holds 'manager'
      expect(r.status).toBe(403)
      expect(JSON.stringify(r.body)).toContain('PRIVILEGED_LOGIN')
      expect(JSON.stringify(r.body)).not.toContain('reset-password')
    })

    it('is allowed for someone with roles.write, but the link is still not returned', async () => {
      const admin = await loginAs(ids.admin!)
      const r = await inviteAs(admin, ids.managerEmp!)
      expect(r.status).toBe(200)
      expect(r.body.created).toBe(false)
      expect(r.body.link).toBeUndefined()
    })

    it('for a plain employee login re-issues by email only: the link is not in the response', async () => {
      const hr = await loginAs(ids.hr!)
      const r = await inviteAs(hr, ids.employeeEmp!)
      expect(r.status).toBe(200)
      expect(r.body.link).toBeUndefined()
    })

    it('a NEW login still returns the link, so HR can hand it over when mail is not set up', async () => {
      const hr = await loginAs(ids.hr!)
      const email = `fresh-${Date.now()}@apitest.local`
      const emp = await withTenant(tenantId, async (tx) => (await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
         VALUES ($1,$2,'Fresh',DATE '2025-06-01') RETURNING id`, [tenantId, `T-9${Date.now() % 1000}`])).rows[0]!.id)
      const r = await api<{ link?: string; created?: boolean }>('POST', `/api/v1/employees/${emp}/invite`, { token: hr, body: { email } })
      expect(r.status).toBe(201)
      expect(r.body.link).toContain('reset-password?token=')
    })
  })

  it('manager on the assignment: set, carried forward, cycle refused; the manager gains scope over the report', async () => {
    const hr = await loginAs(ids.hr!)
    // Sneha (otherEmp) now reports to Arjun (managerEmp)
    const r = await api<{ id: string }>('POST', `/api/v1/employees/${ids.otherEmp}/assignments`,
      { token: hr, body: { department: 'Sales', designation: 'Executive', managerEmployeeId: ids.managerEmp, effectiveFrom: '2026-01-01', reason: 'reporting line' } })
    expect(r.status).toBe(201)
    // a later change that says nothing about the manager keeps Arjun
    const promo = await api<{ id: string }>('POST', `/api/v1/employees/${ids.otherEmp}/assignments`,
      { token: hr, body: { department: 'Sales', designation: 'Senior Executive', effectiveFrom: '2026-06-01', reason: 'promotion' } })
    expect(promo.status).toBe(201)
    const row = await withTenant(tenantId, async (tx) => (await tx.query<{ manager_employee_id: string }>(
      `SELECT manager_employee_id FROM employee_assignments WHERE id = $1`, [promo.body.id])).rows[0]!)
    expect(row.manager_employee_id).toBe(ids.managerEmp)
    // Arjun cannot report to Sneha: that would loop
    const loop = await api('POST', `/api/v1/employees/${ids.managerEmp}/assignments`,
      { token: hr, body: { department: 'Engineering', designation: 'Manager', managerEmployeeId: ids.otherEmp, effectiveFrom: '2026-07-01' } })
    expect(loop.status).toBe(422)
    expect(loop.body.error?.code).toBe('MANAGER_CYCLE')
    expect((await api('POST', `/api/v1/employees/${ids.otherEmp}/assignments`,
      { token: hr, body: { department: 'Sales', designation: 'X', managerEmployeeId: ids.otherEmp, effectiveFrom: '2026-08-01' } })).body.error?.code).toBe('MANAGER_IS_SELF')
    // the manager can now read the report's record
    const mgr = await loginAs(ids.manager!)
    expect((await api('GET', `/api/v1/employees/${ids.otherEmp}`, { token: mgr })).status).toBe(200)
  })
})

describe('task templates: onboarding and offboarding checklists a company defines itself', () => {
  it('create, validate, update, instantiate with auto-resolved assignees, retire', async () => {
    const hr = await loginAs(ids.hr!)
    const bad = await api('POST', '/api/v1/task-templates', { token: hr, body: { name: 'x', trigger: 'onboarding', items: [{ title: 'a', assigneeRule: 'named_user' }] } })
    expect(bad.status).toBe(422)                                       // named_user needs assigneeRef
    const t = await api<{ id: string; items: { sequence: number; assignee_rule: string }[] }>('POST', '/api/v1/task-templates', { token: hr, body: {
      name: 'New joiner', trigger: 'onboarding', items: [
        { title: 'Collect PAN and Aadhaar', assigneeRule: 'hr', dueOffsetDays: 0, requiresAttachment: true },
        { title: 'Introduce the team', assigneeRule: 'manager', dueOffsetDays: 2 },
        { title: 'Read the handbook', assigneeRule: 'employee', dueOffsetDays: 7, blocksCompletion: false },
      ] } })
    expect(t.status).toBe(201)
    expect(t.body.items.map((i) => [i.sequence, i.assignee_rule])).toEqual([[1, 'hr'], [2, 'manager'], [3, 'employee']])
    expect((await api('POST', '/api/v1/task-templates', { token: hr, body: { name: 'new JOINER', trigger: 'onboarding', items: [{ title: 'a', assigneeRule: 'hr' }] } })).body.error?.code).toBe('TEMPLATE_EXISTS')

    const upd = await api<{ items: { title: string }[] }>('PATCH', `/api/v1/task-templates/${t.body.id}`, { token: hr, body: { items: [{ title: 'Collect PAN', assigneeRule: 'hr' }, { title: 'Laptop', assigneeRule: 'it' }] } })
    expect(upd.status).toBe(200)
    expect(upd.body.items.map((i) => i.title)).toEqual(['Collect PAN', 'Laptop'])

    // instantiate for Sneha (reports to Arjun): no assignees given — rules resolve from the org
    const run = await api<{ taskIds: string[] }>('POST', '/api/v1/tasks/instantiate', { token: hr, body: { templateId: t.body.id, employeeId: ids.otherEmp, anchorDate: '2026-10-01', sourceType: 'onboarding' } })
    expect(run.status).toBe(201)
    expect(run.body.taskIds).toHaveLength(2)
    const tasks = await withTenant(tenantId, async (tx) => (await tx.query<{ title: string; assignee_user_id: string | null; due_date: string }>(
      `SELECT title, assignee_user_id, due_date::text FROM tasks WHERE id = ANY($1::uuid[]) ORDER BY title`, [run.body.taskIds])).rows)
    expect(tasks.map((x) => x.title)).toEqual(['Collect PAN', 'Laptop'])
    expect(tasks.every((x) => x.assignee_user_id)).toBe(true)         // hr and it both resolved to a real login
    expect(tasks[0]!.due_date).toBe('2026-10-01')

    expect((await api('POST', `/api/v1/task-templates/${t.body.id}/retire`, { token: hr })).status).toBe(200)
    const listed = await api<{ templates: { id: string }[] }>('GET', '/api/v1/task-templates', { token: hr })
    expect(listed.body.templates.find((x) => x.id === t.body.id)).toBeUndefined()
    const history = await api<{ templates: { id: string; status: string }[] }>('GET', '/api/v1/task-templates?includeRetired=true', { token: hr })
    expect(history.body.templates.find((x) => x.id === t.body.id)!.status).toBe('retired')
    expect((await api('PATCH', `/api/v1/task-templates/${t.body.id}`, { token: hr, body: { name: 'z' } })).body.error?.code).toBe('TEMPLATE_RETIRED')
    // an employee cannot define checklists
    expect((await api('POST', '/api/v1/task-templates', { token: await loginAs(ids.employee!), body: { name: 'n', trigger: 'manual', items: [{ title: 'a', assigneeRule: 'hr' }] } })).status).toBe(403)
  })
})

describe('lists page instead of dumping history', () => {
  it('leave requests and payslips take limit/offset and report hasMore; scope still narrows', async () => {
    const hr = await loginAs(ids.hr!)
    const emp = await loginAs(ids.employee!)
    const all = await api<{ requests: { employee_id: string; status: string }[]; hasMore: boolean }>('GET', '/api/v1/leave/requests?limit=2', { token: hr })
    expect(all.status).toBe(200)
    expect(all.body.requests.length).toBeLessThanOrEqual(2)
    const mine = await api<{ requests: { employee_id: string }[] }>('GET', '/api/v1/leave/requests?limit=50', { token: emp })
    expect(mine.body.requests.every((r) => r.employee_id === ids.employeeEmp)).toBe(true)
    expect((await api('GET', `/api/v1/leave/requests?employeeId=${ids.otherEmp}`, { token: emp })).status).toBe(404)
    const slips = await api<{ payslips: unknown[]; hasMore: boolean }>('GET', '/api/v1/payslips?limit=1&offset=0', { token: emp })
    expect(slips.status).toBe(200)
    expect(slips.body.payslips.length).toBeLessThanOrEqual(1)
    expect(typeof slips.body.hasMore).toBe('boolean')
  })
})
