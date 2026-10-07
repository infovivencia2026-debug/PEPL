/**
 * Who may do what, and whether a refusal can be traced.
 *
 * - The plan's employee limit holds on the create route (it was only ever asserted as a configuration value).
 * - Statutory IDs (UAN, PAN, ESI, PF member id) are masked for everyone but the person, revealing them is an
 *   audited access, an employee cannot read or write anybody else's, and a masked value is not accepted back.
 * - Every error a client can receive carries a requestId that matches the x-request-id header, so a screenshot
 *   of an error is enough to find the log line.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'

let A: Tenant
let server: Server
let base: string
let otherEmp: string
const PW = 'a-long-password-1'

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: res.status, requestHeader: res.headers.get('x-request-id'), body: await res.json().catch(() => ({})) as Record<string, any> }
}
const login = async (email: string): Promise<string> => ((await call(null, 'POST', '/api/v1/auth/login', { email, password: PW })).body as { token: string }).token

let admin: string
let employee: string

beforeAll(async () => {
  A = (await resetAndSeed()).a
  otherEmp = (await controlPool.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'SCOPE-2','Other',DATE '2025-06-01') RETURNING id`, [A.id])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    await createUser(tx, { tenantId: A.id, email: 'admin@scope.test', fullName: 'Scope Admin', password: PW, roles: ['org_admin'] })
    await createUser(tx, { tenantId: A.id, email: 'emp@scope.test', fullName: 'Scope Emp', password: PW, roles: ['employee'], employeeId: A.employeeId })
  })
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  admin = await login('admin@scope.test')
  employee = await login('emp@scope.test')
}, 30_000)
afterAll(async () => { server.close(); await closePools(); await controlPool.end() })

describe('employee limit', () => {
  const setLimit = (n: number) => controlPool.query(
    `UPDATE tenant_entitlements SET limits = jsonb_set(coalesce(limits, '{}'::jsonb), '{employees}', to_jsonb($2::int)) WHERE tenant_id = $1`, [A.id, n])
  const add = (n: string) => call(admin, 'POST', '/api/v1/employees', { employeeNumber: n, firstName: 'Limit', dateOfJoining: '2026-01-05' })

  it('refuses the employee that would go over the plan, with a code the client can act on, and allows it after an upgrade', async () => {
    const headcount = (await controlPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM employees WHERE tenant_id = $1 AND status <> 'exited'`, [A.id])).rows[0]!.n
    await setLimit(headcount)
    const refused = await add('LIM-1')
    expect(refused.status).toBe(403)
    expect(refused.body.error.code).toBe('EMPLOYEE_LIMIT_REACHED')
    await setLimit(headcount + 1)
    expect((await add('LIM-2')).status).toBe(201)
    expect((await add('LIM-3')).status).toBe(403)   // and the next one is over again
    await setLimit(200)
  })
})

describe('statutory IDs', () => {
  const path = (id: string) => `/api/v1/employees/${id}/statutory-ids`
  it('an administrator sets them; reading someone else\'s is masked by default', async () => {
    expect((await call(admin, 'PATCH', path(otherEmp), { uan: '100123456789', pan: 'ABCDE1234F' })).status).toBe(200)
    const masked = await call(admin, 'GET', path(otherEmp))
    expect(masked.status).toBe(200)
    expect(masked.body.statutoryIds.uan).not.toBe('100123456789')
    expect(masked.body.statutoryIds.uan).toMatch(/6789$/)
  })

  it('revealing the full value is an audited access', async () => {
    const before = (await controlPool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'access.tier3.revealed'`, [A.id])).rows[0].n
    const shown = await call(admin, 'GET', path(otherEmp) + '?reveal=true')
    expect(shown.body.statutoryIds.uan).toBe('100123456789')
    const after = (await controlPool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'access.tier3.revealed'`, [A.id])).rows[0].n
    expect(after).toBe(before + 1)
  })

  it('an employee cannot read or change a colleague\'s, nor change their own', async () => {
    expect([403, 404]).toContain((await call(employee, 'GET', path(otherEmp))).status)
    expect((await call(employee, 'PATCH', path(otherEmp), { uan: '999999999999' })).status).toBe(403)
    expect((await call(employee, 'PATCH', path(A.employeeId), { uan: '999999999999' })).status).toBe(403)
    // and the colleague's number is unchanged
    expect((await call(admin, 'GET', path(otherEmp) + '?reveal=true')).body.statutoryIds.uan).toBe('100123456789')
  })

  it('a masked value posted back is refused instead of overwriting the real identifier', async () => {
    const r = await call(admin, 'PATCH', path(otherEmp), { uan: '••••••••6789' })
    expect(r.status).toBe(422)
    expect((await call(admin, 'GET', path(otherEmp) + '?reveal=true')).body.statutoryIds.uan).toBe('100123456789')
  })
})

describe('every error can be traced', () => {
  it.each([
    ['a 401 with no token', () => call(null, 'GET', '/api/v1/employees'), 401],
    ['a 403 for a missing permission', () => call(employee, 'POST', '/api/v1/employees', { employeeNumber: 'X', firstName: 'X', dateOfJoining: '2026-01-05' }), 403],
    ['a 422 for a bad body', () => call(admin, 'PATCH', `/api/v1/employees/${otherEmp}/statutory-ids`, { uan: '••••' }), 422],
    ['a 404 for an unknown route', () => call(admin, 'GET', '/api/v1/no-such-route-audit'), 404],
  ] as const)('%s carries a requestId equal to the x-request-id header', async (_label, send, status) => {
    const r = await send()
    expect(r.status).toBe(status)
    expect(r.body.error.requestId, JSON.stringify(r.body)).toBeTruthy()
    expect(r.body.error.requestId).toBe(r.requestHeader)
  })
})
