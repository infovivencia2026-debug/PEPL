/**
 * A punch belongs to today.
 *
 * POST /attendance/punch took the day it applies to from the request body. An in-punch dated
 * any past or future day marked that day present -- including inside a period payroll had
 * already closed, because recomputing a day never asked whether its period was still open --
 * and a manager or HR punching for someone else left no record of who did it. The same body
 * field on POST /attendance/visits turned any absent day into a paid on-duty day. Found by an
 * audit; each case here was reproduced against the route first.
 *
 * The one legitimate use of an earlier date is the small hours after midnight: a night shift
 * punching OUT belongs to the day it started. That is allowed, and only when there is an open
 * in-punch to close.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { recordPunch } from '../src/attendance/index.ts'
import { today } from '../src/lib/timezone.ts'

const PASSWORD = 'punch-window-test-password'
const TZ = 'Asia/Kolkata'
let server: Server, base: string, A: Tenant
const token: Record<string, string> = {}
const userId: Record<string, string> = {}

const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
const TODAY = today(TZ)
const YESTERDAY = shift(TODAY, -1)

const call = async (who: string, path: string, body: unknown) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` },
    body: JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: { code: string }; recorded?: boolean } }
}
const punch = (who: string, o: { direction?: 'in' | 'out'; localDate: string; employeeId?: string; id?: string }) =>
  call(who, '/api/v1/attendance/punch', {
    direction: o.direction ?? 'in', localDate: o.localDate, employeeId: o.employeeId,
    clientPunchId: o.id ?? `w-${Math.random().toString(36).slice(2)}`, geo: { lat: 17.4, lng: 78.4 },
  })
const punchRows = (date: string) => withTenant(A.id, async (tx) =>
  (await tx.query<{ recorded_by_user_id: string | null; employee_id: string }>(
    `SELECT recorded_by_user_id, employee_id FROM attendance_punches WHERE local_date = $1 ORDER BY punched_at`, [date])).rows)

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"attendance":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])
  for (const [name, roles, employeeId] of [
    ['emp', ['employee'], A.employeeId],
    ['hr', ['hr_admin'], undefined],
  ] as const) {
    userId[name] = await withTenant(A.id, (tx) => createUser(tx, {
      tenantId: A.id, email: `${name}@punch.test`, fullName: name, password: PASSWORD, roles: [...roles], employeeId,
    }))
    const s = await login({ email: `${name}@punch.test`, password: PASSWORD })
    if ('choose' in s) throw new Error('fixture address is in more than one company')
    token[name] = s.token
  }
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => { server?.closeAllConnections(); server?.close(); await closePools(); await controlPool.end() })

const reset = () => withTenant(A.id, async () => {}).then(() => controlPool.query(
  `DELETE FROM attendance_periods WHERE tenant_id = $1`, [A.id]))

describe('the day a punch belongs to', () => {
  it('today is recorded', async () => {
    const r = await punch('emp', { localDate: TODAY, id: 'today-1' })
    expect(r.status).toBe(200)
    expect(r.body.recorded).toBe(true)
  })

  for (const [label, date] of [['a past day', shift(TODAY, -10)], ['a future day', shift(TODAY, 3)], ['tomorrow', shift(TODAY, 1)], ['yesterday, for an in-punch', YESTERDAY]] as const) {
    it(`refuses an in-punch for ${label}, and records nothing`, async () => {
      const before = (await punchRows(date)).length
      const r = await punch('emp', { localDate: date })
      expect(r.status, label).toBe(422)
      expect(r.body.error?.code).toBe('DATE_OUT_OF_WINDOW')
      expect((await punchRows(date)).length).toBe(before)
    })
  }

  it('lets a night shift punch OUT after midnight, against the day it started', async () => {
    // Without an open in-punch there is nothing to close: refused.
    expect((await punch('emp', { direction: 'out', localDate: YESTERDAY })).status).toBe(422)
    // With one, it is the shift ending.
    await withTenant(A.id, (tx) => recordPunch(tx, {
      employeeId: A.employeeId, punchedAt: new Date(Date.now() - 8 * 3_600_000).toISOString(),
      localDate: YESTERDAY, direction: 'in', source: 'web',
    }))
    const r = await punch('emp', { direction: 'out', localDate: YESTERDAY })
    expect(r.status).toBe(200)
  })
})

describe('a period that is no longer open', () => {
  for (const status of ['closed', 'frozen']) {
    it(`takes no punches once it is ${status}`, async () => {
      await reset()
      await controlPool.query(
        `INSERT INTO attendance_periods (tenant_id, period_start, period_end, status) VALUES ($1, $2, $3, $4)`,
        [A.id, shift(TODAY, -15), shift(TODAY, 15), status])
      const r = await punch('emp', { localDate: TODAY })
      expect(r.status).toBe(409)
      expect(r.body.error?.code).toBe('PERIOD_CLOSED')
    })
  }

  it('an open period is no obstacle, and neither is having no period at all', async () => {
    await reset()
    expect((await punch('emp', { localDate: TODAY, id: 'no-period' })).status).toBe(200)
    await controlPool.query(
      `INSERT INTO attendance_periods (tenant_id, period_start, period_end, status) VALUES ($1, $2, $3, 'open')`,
      [A.id, shift(TODAY, -15), shift(TODAY, 15)])
    expect((await punch('emp', { localDate: TODAY, id: 'open-period' })).status).toBe(200)
    await reset()
  })
})

describe('who recorded it', () => {
  it('a person\'s own punch names them', async () => {
    await punch('emp', { localDate: TODAY, id: 'own-actor' })
    const rows = await punchRows(TODAY)
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.recorded_by_user_id !== null)).toBe(true)
    expect(rows.some((r) => r.recorded_by_user_id === userId.emp)).toBe(true)
  })

  it('a punch made FOR someone else names the person who made it', async () => {
    const other = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-777','Ravi',DATE '2026-01-01') RETURNING id`, [A.id])).rows[0]!.id)
    const r = await punch('hr', { localDate: TODAY, employeeId: other, id: 'on-behalf' })
    expect(r.status).toBe(200)
    const row = (await punchRows(TODAY)).find((x) => x.employee_id === other)!
    expect(row.recorded_by_user_id).toBe(userId.hr)                 // HR, not Ravi
  })

  it('an employee cannot punch for a colleague', async () => {
    const other = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-778','Sita',DATE '2026-01-01') RETURNING id`, [A.id])).rows[0]!.id)
    const r = await punch('emp', { localDate: TODAY, employeeId: other })
    expect([403, 404]).toContain(r.status)
    expect((await punchRows(TODAY)).some((x) => x.employee_id === other)).toBe(false)
  })
})

describe('field visits', () => {
  const visit = (date?: string) => call('emp', '/api/v1/attendance/visits', {
    place: 'DAV School', purpose: 'demo', geo: { lat: 17.4, lng: 78.4 }, ...(date ? { localDate: date } : {}),
  })

  it('cannot be back-dated or post-dated to make an absent day a paid on-duty day', async () => {
    for (const date of [shift(TODAY, -6), YESTERDAY, shift(TODAY, 2)]) {
      const r = await visit(date)
      expect(r.status, date).toBe(422)
      expect(r.body.error?.code).toBe('DATE_OUT_OF_WINDOW')
    }
  })

  it('is recorded for today', async () => {
    expect((await visit(TODAY)).status).toBe(201)
  })
})

describe('malformed punch input is a 422, not a 500', () => {
  const bad = (o: Record<string, unknown>) => call('emp', '/api/v1/attendance/punch', { direction: 'in', clientPunchId: `bad-${Math.random()}`, geo: { lat: 17.4, lng: 78.4 }, ...o })
  it('direction, client id and coordinates are validated', async () => {
    for (const o of [{ direction: 'sideways' }, { clientPunchId: '' }, { clientPunchId: 'x'.repeat(200) }, { geo: { lat: 999, lng: 78 } }, { geo: { lat: 17, lng: -400 } }, { geo: { lat: 'a', lng: 1 } }]) {
      const r = await bad(o)
      expect(r.status, JSON.stringify(o)).toBe(422)
    }
  })
})

describe('a client that does not know the date', () => {
  it('may omit it: the server uses the company\'s today', async () => {
    const r = await call('emp', '/api/v1/attendance/punch', { direction: 'in', clientPunchId: 'no-date', geo: { lat: 17.4, lng: 78.4 } })
    expect(r.status).toBe(200)
  })
})
