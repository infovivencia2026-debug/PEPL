/**
 * Defects from the QA round (2026-10-05), each reproduced here before it was fixed.
 *
 * - Inviting an employee who already has a login, with a roles list, answered 200 and changed nothing:
 *   the caller believed a role had been granted and the audit event said so.
 * - A custom role with a non-string name, or a departmentCodes that was not a list of strings, threw a
 *   TypeError inside validation and surfaced as a 500.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { inviteEmployee } from '../src/people/onboard.ts'
import { createCustomRole } from '../src/authz/admin.ts'

let A: Tenant
let issuer: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  issuer = await withTenant(A.id, (tx) => createUser(tx, {
    tenantId: A.id, email: 'invitee@acme.test', fullName: 'In Vitee', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId,
  }))
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('inviting someone who already has a login', () => {
  it('refuses a roles list it cannot apply, instead of answering success and changing nothing', async () => {
    await expect(withTenant(A.id, (tx) => inviteEmployee(tx, {
      employeeId: A.employeeId, email: 'invitee@acme.test', roles: ['payroll_admin'], issuedByUserId: issuer, allowPrivilegedReissue: true,
    }))).rejects.toMatchObject({ code: 'ROLES_NOT_APPLIED' })
  })

  it('still re-issues the link when the roles asked for are the ones the login already holds', async () => {
    const r = await withTenant(A.id, (tx) => inviteEmployee(tx, {
      employeeId: A.employeeId, email: 'invitee@acme.test', roles: ['employee'], issuedByUserId: issuer,
    }))
    expect(r.created).toBe(false)
  })
})

describe('custom role validation', () => {
  const make = (over: Record<string, unknown>) => withTenant(A.id, (tx) =>
    createCustomRole(tx, { name: 'Probe', permissions: ['employee.read'], dataScope: 'self', ...over } as never))

  it('a name that is not text is a validation error, not a TypeError', async () => {
    await expect(make({ name: 42 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
  it('departmentCodes that is not a list of text is a validation error', async () => {
    await expect(make({ dataScope: 'department', departmentCodes: 'HR' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(make({ dataScope: 'department', departmentCodes: [7] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('push notifications that are not configured', () => {
  it('answers 200 with a null key, not a 503 on every settings page load', async () => {
    const { createServer } = await import('node:http')
    const { createHandler } = await import('../src/http/router.ts')
    const { buildRouter } = await import('../src/http/app.ts')
    const server = createServer(createHandler(buildRouter()))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      const login = await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'invitee@acme.test', password: 'a-long-password-1' }) })).json() as { token: string }
      const res = await fetch(`${base}/api/v1/push/vapid-public-key`, { headers: { authorization: `Bearer ${login.token}` } })
      // 200 with a null key, or the module is not sold to this company (a 4xx) -- never a 5xx.
      expect(res.status).toBeLessThan(500)
      if (res.status === 200) expect((await res.json() as { publicKey: unknown }).publicKey).toBeNull()
    } finally { server.close() }
  })
})

describe('a company created in a state files professional tax under it', () => {
  it('stateCode at provisioning becomes payroll.pt_state_code', async () => {
    const { provisionTenant } = await import('../src/control-plane/index.ts')
    const r = await provisionTenant({
      legalName: 'PT State Probe Pvt Ltd', displayName: 'PT Probe', planCode: 'growth', adminEmail: `pt-${Date.now()}@probe.test`, adminName: 'Pt Probe', stateCode: 'KA',
    })
    const { rows } = await controlPool.query(`SELECT value FROM tenant_settings WHERE tenant_id = $1 AND key = 'payroll.pt_state_code'`, [r.tenantId])
    expect(rows[0]?.value).toBe('KA')
  })
})
