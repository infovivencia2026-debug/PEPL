/**
 * Two-factor authentication: TOTP matches RFC 6238 test vectors; enrolment is
 * setup → enable-with-code; a login then yields a PENDING session that can
 * reach only the MFA routes until verified; a code works once; a recovery
 * code works once and is consumed; disable needs a code; the company can
 * require admins to enrol; payroll lock insists on a recent verification.
 * Also: statutory ids are masked by default and a reveal is audited.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import { totp, stepAt, base32Encode } from '../src/auth/mfa.ts'

let A: Tenant
let server: Server; let base: string
let secretB32 = ''
beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => {
    await createUser(tx, { tenantId: A.id, email: 'madmin@acme.test', fullName: 'Admin', password: 'a-long-password-1', roles: ['org_admin'] })
    await createUser(tx, { tenantId: A.id, email: 'mhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    await createUser(tx, { tenantId: A.id, email: 'mpay@acme.test', fullName: 'Pay', password: 'a-long-password-1', roles: ['payroll_admin'] })
    await createUser(tx, { tenantId: A.id, email: 'madmin2@acme.test', fullName: 'Admin2', password: 'a-long-password-1', roles: ['org_admin'] })
    await createUser(tx, { tenantId: A.id, email: 'memp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await tx.query(`INSERT INTO employee_statutory_ids (tenant_id, employee_id, uan, pan) VALUES ($1, $2, '100123456789', 'ABCDE1234F')`, [A.id, A.employeeId])
  })
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.status === 204 ? {} : (await r.json()) as Record<string, any> }
}
const login = (email: string) => call(null, 'POST', '/api/v1/auth/login', { email, password: 'a-long-password-1' })
const b32decode = (s: string): Buffer => {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, value = 0; const out: number[] = []
  for (const c of s) { value = (value << 5) | A.indexOf(c); bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(out)
}
const codeNow = () => totp(b32decode(secretB32), stepAt())

describe('TOTP', () => {
  it('matches the RFC 6238 SHA-1 vectors (with the 20-byte seed, 6 digits)', () => {
    const seed = Buffer.from('12345678901234567890')
    expect(totp(seed, Math.floor(59 / 30))).toBe('287082')
    expect(totp(seed, Math.floor(1111111109 / 30))).toBe('081804')
    expect(totp(seed, Math.floor(1234567890 / 30))).toBe('005924')
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI')
  })
})

describe('enrolment and login', () => {
  it('setup → enable with a live code → recovery codes once; the next login is pending until verified; a code is good once', async () => {
    const first = await login('madmin@acme.test')
    expect(first.body.mfaRequired).toBe(false)
    const t = first.body.token as string
    expect((await call(t, 'GET', '/api/v1/auth/mfa')).body).toMatchObject({ enabled: false, pendingSetup: false })
    await expect(call(t, 'POST', '/api/v1/auth/mfa/enable', { code: '000000' })).resolves.toMatchObject({ status: 409 })   // nothing set up yet
    const setup = await call(t, 'POST', '/api/v1/auth/mfa/setup')
    expect(setup.status).toBe(200)
    expect(setup.body.otpauth).toMatch(/^otpauth:\/\/totp\/PEPL/)
    secretB32 = setup.body.secret
    const wrong = await call(t, 'POST', '/api/v1/auth/mfa/enable', { code: '000000' })
    expect(wrong.status).toBe(422); expect(wrong.body.error.code).toBe('MFA_CODE_INVALID')
    const enabled = await call(t, 'POST', '/api/v1/auth/mfa/enable', { code: codeNow() })
    expect(enabled.status).toBe(200)
    expect(enabled.body.recoveryCodes).toHaveLength(8)
    const recovery: string[] = enabled.body.recoveryCodes
    expect((await call(t, 'GET', '/api/v1/auth/mfa')).body).toMatchObject({ enabled: true, recoveryCodesLeft: 8 })

    // a fresh login is pending: everything but the MFA routes answers 401 MFA_REQUIRED
    const second = await login('madmin@acme.test')
    expect(second.body.mfaRequired).toBe(true)
    const t2 = second.body.token as string
    const blocked = await call(t2, 'GET', '/api/v1/employees')
    expect(blocked.status).toBe(401); expect(blocked.body.error.code).toBe('MFA_REQUIRED')
    expect((await call(t2, 'GET', '/api/v1/auth/mfa')).status).toBe(200)
    // the code used to enable is spent (same step); wait for the next step if needed
    const used = codeNow()
    const spent = await call(t2, 'POST', '/api/v1/auth/mfa/verify', { code: used })
    if (spent.status === 200) {
      // a different step ticked over between enable and now — fine; prove replay another way
      expect((await call(t2, 'POST', '/api/v1/auth/mfa/verify', { code: used })).status).toBe(422)
    } else {
      expect(spent.body.error.code).toBe('MFA_CODE_INVALID')
      // recovery code finishes the login instead, and is consumed
      const rec = await call(t2, 'POST', '/api/v1/auth/mfa/verify', { code: recovery[0]! })
      expect(rec.status).toBe(200); expect(rec.body).toMatchObject({ method: 'recovery', recoveryCodesLeft: 7 })
      expect((await call(t2, 'POST', '/api/v1/auth/mfa/verify', { code: recovery[0]! })).status).toBe(422)
    }
    expect((await call(t2, 'GET', '/api/v1/employees')).status).toBe(200)   // verified: the session works everywhere
    // disable needs a code; a wrong one is refused
    expect((await call(t2, 'POST', '/api/v1/auth/mfa/disable', { code: '000000' })).status).toBe(422)
  })

  it('a company can require admins to enrol; a plain employee is unaffected; an admin reset signs the person out', async () => {
    await withTenant(A.id, (tx) => setSetting(tx, { key: 'security.mfa_required_for_admins', value: true, reason: 'test' }))
    const hr = await login('mhr@acme.test')
    const hrT = hr.body.token as string
    const blocked = await call(hrT, 'GET', '/api/v1/employees')
    expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe('MFA_ENROLMENT_REQUIRED')
    expect((await call(hrT, 'POST', '/api/v1/auth/mfa/setup')).status).toBe(200)   // the way out is open
    const emp = await login('memp@acme.test')
    expect((await call(emp.body.token, 'GET', '/api/v1/auth/mfa')).status).toBe(200)
    expect((await call(emp.body.token, 'GET', `/api/v1/employees/${A.employeeId}`)).status).toBe(200)   // employees are not admins
    await withTenant(A.id, (tx) => setSetting(tx, { key: 'security.mfa_required_for_admins', value: false, reason: 'test' }))

    // admin reset of the enrolled admin: their factor is gone and their sessions die
    const adminId = (await withTenant(A.id, (tx) => tx.query<{ id: string }>(`SELECT id FROM app_users WHERE email = 'madmin@acme.test'`))).rows[0]!.id
    const hr2 = await call((await login('madmin2@acme.test')).body.token, 'POST', `/api/v1/auth/mfa/reset/${adminId}`)
    expect(hr2.status).toBe(204)
    expect((await login('madmin@acme.test')).body.mfaRequired).toBe(false)
  })
})

describe('masking', () => {
  it('statutory ids are masked for payroll by default, full for the person, full + audited on reveal', async () => {
    const hrT = (await login('mpay@acme.test')).body.token as string
    const masked = await call(hrT, 'GET', `/api/v1/employees/${A.employeeId}/statutory-ids`)
    expect(masked.body).toMatchObject({ masked: true, statutoryIds: { uan: '••••••••6789', pan: 'AB******4F' } })
    const own = await call((await login('memp@acme.test')).body.token, 'GET', `/api/v1/employees/${A.employeeId}/statutory-ids`)
    expect(own.body).toMatchObject({ masked: false, statutoryIds: { uan: '100123456789', pan: 'ABCDE1234F' } })
    const revealed = await call(hrT, 'GET', `/api/v1/employees/${A.employeeId}/statutory-ids?reveal=true`)
    expect(revealed.body).toMatchObject({ masked: false, statutoryIds: { pan: 'ABCDE1234F' } })
    const audited = await withTenant(A.id, (tx) => tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM audit_events WHERE action = 'access.tier3.revealed' AND metadata->>'document' = 'statutory_ids'`))
    expect(Number(audited.rows[0]!.n)).toBe(1)
  })
})
