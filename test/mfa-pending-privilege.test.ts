/**
 * A session that has passed the PASSWORD but not the second factor is not an authenticated admin.
 *
 * The MFA gate let a pending session through to anything matching /auth/mfa(/|$) -- which includes
 * POST /auth/mfa/reset/:userId, the admin route that removes ANOTHER user's second factor. Anyone who
 * had only stolen an administrator's password (the very case MFA exists for) could therefore strip a
 * colleague's second factor, and the same regex let an admin who had not yet enrolled do it. The event
 * stream also accepted a pending session. A pending session may reach exactly the routes needed to
 * finish signing in.
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
import { totp, stepAt } from '../src/auth/mfa.ts'
import { handleEvents } from '../src/realtime/sse.ts'

const PW = 'a-long-password-1'
let A: Tenant, server: Server, base: string
let victimId: string

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.status === 204 ? {} : (await r.json().catch(() => ({}))) as Record<string, any> }
}
const login = (email: string) => call(null, 'POST', '/api/v1/auth/login', { email, password: PW })
const b32 = (s: string): Buffer => {
  const al = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, v = 0; const out: number[] = []
  for (const c of s) { v = (v << 5) | al.indexOf(c); bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(out)
}
/** Enrol a user's second factor through the API; returns a recovery code for later verification. */
async function enrol(email: string): Promise<string> {
  const t = (await login(email)).body.token as string
  const setup = await call(t, 'POST', '/api/v1/auth/mfa/setup')
  const en = await call(t, 'POST', '/api/v1/auth/mfa/enable', { code: totp(b32(setup.body.secret), stepAt()) })
  return (en.body.recoveryCodes as string[])[0]!
}
const mfaOn = async (userId: string) => withTenant(A.id, async (tx) => (await tx.query(`SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL`, [userId])).rowCount === 1)

beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => {
    await createUser(tx, { tenantId: A.id, email: 'padmin@acme.test', fullName: 'Admin', password: PW, roles: ['org_admin'] })
    victimId = await createUser(tx, { tenantId: A.id, email: 'pvictim@acme.test', fullName: 'Victim', password: PW, roles: ['employee'], employeeId: A.employeeId })
  })
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })

describe('a password-only session cannot act as an administrator', () => {
  let recovery: string
  it('setup: an administrator and a colleague both have a second factor', async () => {
    recovery = await enrol('padmin@acme.test')
    await enrol('pvictim@acme.test')
    expect(await mfaOn(victimId)).toBe(true)
  })

  it('a pending admin session cannot reset a colleague\'s second factor', async () => {
    const pending = await login('padmin@acme.test')
    expect(pending.body.mfaRequired).toBe(true)
    const r = await call(pending.body.token, 'POST', `/api/v1/auth/mfa/reset/${victimId}`)
    expect(r.status).toBe(401)
    expect(r.body.error.code).toBe('MFA_REQUIRED')
    expect(await mfaOn(victimId)).toBe(true)                 // untouched
  })

  it('nor reach the rest of the MFA admin surface; only what finishing sign-in needs', async () => {
    const t = (await login('padmin@acme.test')).body.token as string
    for (const [m, p] of [['POST', '/api/v1/auth/mfa/disable'], ['GET', '/api/v1/employees'], ['POST', '/api/v1/auth/logout-everywhere']] as const) {
      expect((await call(t, m, p, m === 'POST' ? {} : undefined)).status, `${m} ${p}`).toBe(401)
    }
    expect((await call(t, 'GET', '/api/v1/auth/mfa')).status).toBe(200)       // status
  })

  it('the live event stream refuses a pending session', async () => {
    const t = (await login('padmin@acme.test')).body.token as string
    // The stream is mounted before the JSON router in server.ts, so mount it the same way here.
    const sse = createServer((req, res) => { void handleEvents(req, res) })
    await new Promise<void>((r) => sse.listen(0, '127.0.0.1', r))
    try {
      const port = (sse.address() as { port: number }).port
      const r = await fetch(`http://127.0.0.1:${port}/api/v1/events`, { headers: { authorization: `Bearer ${t}` } })
      expect(r.status).toBe(401)
      await r.body?.cancel()
    } finally { sse.closeAllConnections(); sse.close() }
  })

  it('once the second factor is proved, the same admin can reset it', async () => {
    const t = (await login('padmin@acme.test')).body.token as string
    expect((await call(t, 'POST', '/api/v1/auth/mfa/verify', { code: recovery })).status).toBe(200)
    expect((await call(t, 'POST', `/api/v1/auth/mfa/reset/${victimId}`)).status).toBe(204)
    expect(await mfaOn(victimId)).toBe(false)
  })
})

describe('an administrator who has not enrolled', () => {
  it('cannot use the reset route while the company requires administrators to enrol', async () => {
    await withTenant(A.id, async (tx) => {
      await createUser(tx, { tenantId: A.id, email: 'pnew@acme.test', fullName: 'New admin', password: PW, roles: ['org_admin'] })
      await setSetting(tx, { key: 'security.mfa_required_for_admins', value: true, reason: 'test' })
    })
    const t = (await login('pnew@acme.test')).body.token as string
    const r = await call(t, 'POST', `/api/v1/auth/mfa/reset/${victimId}`)
    expect(r.status).toBe(403)
    expect(r.body.error.code).toBe('MFA_ENROLMENT_REQUIRED')
    // ...while enrolment itself stays reachable, or they could never comply.
    expect((await call(t, 'POST', '/api/v1/auth/mfa/setup')).status).toBe(200)
  })
})
