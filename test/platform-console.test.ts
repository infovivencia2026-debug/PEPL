/**
 * The operator console's authentication.
 *
 * This identity stands OUTSIDE tenant isolation — one account that reaches
 * every customer's billing — so these are written as the properties that must
 * hold rather than as a feature description.
 *
 *   - A tenant session must never open an operator route, and vice versa.
 *   - A password alone must not be enough.
 *   - An operator must not be able to read a customer's own data.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { upsertPlatformUser, setPlatformUserStatus } from '../src/control-plane/platform-auth.ts'
import { signup } from '../src/control-plane/billing.ts'
import { login } from '../src/auth/index.ts'
import { totp, stepAt } from '../src/auth/mfa.ts'

let server: Server
let base: string
const stamp = Date.now()
const operator = `ops-${stamp}@pepl.test`
const OPERATOR_PASSWORD = 'an-operator-passphrase-long'
let tenantToken: string

const api = async (method: string, path: string, body?: unknown, token?: string) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: (r.status === 204 ? {} : await r.json()) as Record<string, unknown> & { error?: { code: string } } }
}


const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32Decode = (v: string): Buffer => {
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of v.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/**
 * Enrol and clear the second factor, as a real operator does on first sign-in.
 * The console opens nothing until this has happened, so any test that wants to
 * reach a route has to go through it.
 */
const enrolAndVerify = async (token: string): Promise<string> => {
  const begun = await api('POST', '/api/platform/mfa/enrol', {}, token)
  const secret = (begun.body as { secret?: string }).secret!
  const code = totp(base32Decode(secret), stepAt())
  const r = await api('POST', '/api/platform/mfa/verify', { code }, token)
  if (r.status !== 200 && r.status !== 204) throw new Error(`could not verify: ${JSON.stringify(r.body)}`)
  return secret
}

beforeAll(async () => {
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  await upsertPlatformUser({ email: operator, fullName: 'Test Operator', password: OPERATOR_PASSWORD })

  // A perfectly ordinary customer admin, to prove their session opens nothing here.
  const email = `customer-${stamp}@customerco.test`
  await signup({
    legalName: `CustomerCo ${stamp}`, adminEmail: email, adminName: 'Customer Admin',
    password: 'a-long-customer-passphrase', planCode: 'starter', stateCode: 'TS',
  })
  const s = await login({ email, password: 'a-long-customer-passphrase' })
  if ('choose' in s) throw new Error('unexpected company choice')
  tenantToken = s.token
})

afterAll(async () => {
  server?.close()
  await controlDb.query(`DELETE FROM control_plane.platform_users WHERE email = ANY($1)`, [[operator, `viewer-${stamp}@pepl.test`]])
  await closePools()
  await controlDb.end()
})

describe('the two identities never meet', () => {
  it('a customer session opens nothing on the console', async () => {
    // The whole point. A tenant admin is an administrator of THEIR company,
    // not of the platform, and the token that proves the first must not be
    // accepted as proof of the second.
    const r = await api('GET', '/api/platform/tenants', undefined, tenantToken)
    expect(r.status).toBe(401)
  })

  it('an operator token opens nothing in the product', async () => {
    const signedIn = await api('POST', '/api/platform/login', { email: operator, password: OPERATOR_PASSWORD })
    const token = signedIn.body.token as string
    const r = await api('GET', '/api/v1/me', undefined, token)
    expect(r.status).toBe(401)
  })

  it('the operator login is not the customer login', async () => {
    // An operator address must not resolve through the tenant credential path.
    await expect(login({ email: operator, password: OPERATOR_PASSWORD })).rejects.toThrow()
  })
})

describe('a password alone is not enough', () => {
  it('signs in, but the console stays shut until the second factor', async () => {
    const signedIn = await api('POST', '/api/platform/login', { email: operator, password: OPERATOR_PASSWORD })
    expect(signedIn.status).toBe(200)
    const token = signedIn.body.token as string

    // Not yet enrolled, so this session is open — enrolling is what it is for.
    expect(signedIn.body.mfaPending).toBe(false)

    // Once enrolled, a NEW session must clear the factor before it opens anything.
    await api('POST', '/api/platform/mfa/enrol', {}, token)
    const second = await api('POST', '/api/platform/login', { email: operator, password: OPERATOR_PASSWORD })
    expect(second.body.mfaPending).toBe(true)

    const blocked = await api('GET', '/api/platform/tenants', undefined, second.body.token as string)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error?.code).toBe('MFA_REQUIRED')
  })

  it('refuses a wrong code', async () => {
    const s = await api('POST', '/api/platform/login', { email: operator, password: OPERATOR_PASSWORD })
    const r = await api('POST', '/api/platform/mfa/verify', { code: '000000' }, s.body.token as string)
    expect(r.body.error?.code).toBe('MFA_CODE_INVALID')
  })

  it('refuses a wrong password without saying whether the account exists', async () => {
    const wrong = await api('POST', '/api/platform/login', { email: operator, password: 'not-the-password' })
    const absent = await api('POST', '/api/platform/login', { email: 'nobody@nowhere.test', password: 'not-the-password' })
    expect(wrong.status).toBe(401)
    expect(absent.status).toBe(401)
    expect(wrong.body.error?.code).toBe(absent.body.error?.code)
  })
})

describe('suspending an operator', () => {
  it('revokes their sessions immediately, not at expiry', async () => {
    const fresh = `leaver-${stamp}@pepl.test`
    await upsertPlatformUser({ email: fresh, fullName: 'Leaver', password: 'another-long-passphrase' })
    const s = await api('POST', '/api/platform/login', { email: fresh, password: 'another-long-passphrase' })
    const token = s.body.token as string
    await enrolAndVerify(token)
    expect((await api('GET', '/api/platform/tenants', undefined, token)).status).toBe(200)

    await setPlatformUserStatus(fresh, 'suspended')
    // Somebody who has left keeps working until their token expires otherwise.
    expect((await api('GET', '/api/platform/tenants', undefined, token)).status).toBe(401)
    await controlDb.query(`DELETE FROM control_plane.platform_users WHERE email = $1`, [fresh])
  })
})

describe('what an operator can and cannot see', () => {
  // A separate operator, because the suite above deliberately enrols a second
  // factor on `operator` and every later sign-in of theirs then demands it.
  const viewer = `viewer-${stamp}@pepl.test`
  let viewerSecret = ''
  const VIEWER_PASSWORD = 'a-third-long-operator-passphrase'
  beforeAll(async () => {
    await upsertPlatformUser({ email: viewer, fullName: 'Read Only', password: VIEWER_PASSWORD })
    const s = await api('POST', '/api/platform/login', { email: viewer, password: VIEWER_PASSWORD })
    viewerSecret = await enrolAndVerify(s.body.token as string)
  })

  it('sees that a company exists and what it owes', async () => {
    const s = await api('POST', '/api/platform/login', { email: viewer, password: VIEWER_PASSWORD })
    const token = s.body.token as string
    await api('POST', '/api/platform/mfa/verify', { code: totp(base32Decode(viewerSecret), stepAt()) }, token)
    const r = await api('GET', '/api/platform/tenants', undefined, token)
    expect(r.status).toBe(200)
    const tenants = r.body.tenants as Array<{ legal_name: string; employees: number }>
    expect(tenants.some((t) => t.legal_name === `CustomerCo ${stamp}`)).toBe(true)
    // Headcount is a number, never the people behind it.
    expect(typeof tenants[0]!.employees).toBe('number')
  })

  it('has no route into a customer own records', async () => {
    // Deliberately absent: an operator knows a company has 47 employees and
    // cannot see who they are or what they are paid. Reaching inside needs
    // that tenant's consent, which is what support-access is for.
    const s = await api('POST', '/api/platform/login', { email: viewer, password: VIEWER_PASSWORD })
    const token = s.body.token as string
    await api('POST', '/api/platform/mfa/verify', { code: totp(base32Decode(viewerSecret), stepAt()) }, token)
    for (const path of ['/api/platform/employees', '/api/platform/payroll', '/api/platform/tenants/x/employees']) {
      const r = await api('GET', path, undefined, token)
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
  })
})

describe('enrolment is not optional', () => {
  it('an operator who has never enrolled opens nothing but enrolment', async () => {
    // This was the gap: not-yet-enrolled meant "mfaPending false", so the
    // session was fully open and an operator who never got round to enrolling
    // kept password-only access to every customer's billing. The console's UI
    // pushed them to enrol; the API did not require it.
    const lazy = `never-enrols-${stamp}@pepl.test`
    await upsertPlatformUser({ email: lazy, fullName: 'Never Enrols', password: 'yet-another-long-passphrase' })
    const s = await api('POST', '/api/platform/login', { email: lazy, password: 'yet-another-long-passphrase' })
    const token = s.body.token as string

    const blocked = await api('GET', '/api/platform/tenants', undefined, token)
    expect(blocked.status).toBe(403)
    expect(blocked.body.error?.code).toBe('MFA_ENROLMENT_REQUIRED')

    // ...but enrolling itself must stay reachable, or the requirement is
    // unsatisfiable and the account is bricked.
    const begun = await api('POST', '/api/platform/mfa/enrol', {}, token)
    expect(begun.status).toBe(200)

    await controlDb.query(`DELETE FROM control_plane.platform_users WHERE email = $1`, [lazy])
  })
})
