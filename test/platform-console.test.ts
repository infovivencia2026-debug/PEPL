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
    await enrolAndVerify(token)
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
    // Stamped per run: sign-in failures are counted per ADDRESS for 15 minutes, so a
    // fixed address here locks itself out after five runs and answers 429, which
    // reads as a regression in the product and is not.
    const absent = await api('POST', '/api/platform/login', { email: `nobody-${stamp}@nowhere.test`, password: 'not-the-password' })
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


describe('the second factor cannot be lost, looped or bypassed', () => {
  const PASS = 'a-fresh-long-operator-passphrase'
  const fresh = (label: string) => `${label}-${stamp}@pepl.test`
  const signIn = async (email: string) =>
    (await api('POST', '/api/platform/login', { email, password: PASS })).body.token as string
  const secretOf = async (email: string) =>
    (await controlDb.query<{ s: string | null }>(
      `SELECT mfa_secret AS s FROM control_plane.platform_users WHERE email = $1`, [email])).rows[0]?.s ?? null
  const remove = (email: string) =>
    controlDb.query(`DELETE FROM control_plane.platform_users WHERE email = $1`, [email])

  it('a wrong code is refused without ending the session', async () => {
    // This was the loop. A wrong code answered 401, the console read every 401
    // as "session expired", wiped the token and sent the person back to sign
    // in -- and signing in again generated a NEW secret, so the QR they had
    // already scanned was stale and every retry was guaranteed to fail.
    const email = fresh('wrong-code')
    await upsertPlatformUser({ email, fullName: 'Wrong Code', password: PASS })
    try {
      const token = await signIn(email)
      const begun = await api('POST', '/api/platform/mfa/enrol', {}, token)
      const secret = (begun.body as { secret: string }).secret

      const wrong = await api('POST', '/api/platform/mfa/verify', { code: '000000' }, token)
      expect(wrong.body.error?.code).toBe('MFA_CODE_INVALID')
      expect(wrong.status).not.toBe(401)

      // The session is still good, and the SAME secret still verifies.
      expect((await api('GET', '/api/platform/me', undefined, token)).status).toBe(200)
      const right = await api('POST', '/api/platform/mfa/verify', { code: totp(base32Decode(secret), stepAt()) }, token)
      expect(right.status).toBe(200)
    } finally { await remove(email) }
  })

  it('shows the same secret while enrolment is unfinished, so a refresh does not strand the QR', async () => {
    const email = fresh('refresh')
    await upsertPlatformUser({ email, fullName: 'Refresh', password: PASS })
    try {
      const token = await signIn(email)
      const a = await api('POST', '/api/platform/mfa/enrol', {}, token)
      const b = await api('POST', '/api/platform/mfa/enrol', {}, token)
      expect((b.body as { secret: string }).secret).toBe((a.body as { secret: string }).secret)
    } finally { await remove(email) }
  })

  it('an abandoned enrolment does not lock the operator out', async () => {
    // The secret used to be committed the moment the QR was shown. Close the
    // tab before scanning and the account was enrolled with a secret nobody
    // held: the next sign-in demanded a code that did not exist anywhere.
    const email = fresh('abandoned')
    await upsertPlatformUser({ email, fullName: 'Abandoned', password: PASS })
    try {
      const first = await api('POST', '/api/platform/login', { email, password: PASS })
      await api('POST', '/api/platform/mfa/enrol', {}, first.body.token as string)   // ...and never verify

      const second = await api('POST', '/api/platform/login', { email, password: PASS })
      expect(second.body.mfaPending).toBe(false)
      expect((second.body.user as { mfa_enabled: boolean }).mfa_enabled).toBe(false)
      expect((await api('POST', '/api/platform/mfa/enrol', {}, second.body.token as string)).status).toBe(200)
      expect(await secretOf(email)).toBeNull()
    } finally { await remove(email) }
  })

  it('a password alone cannot replace an enrolled second factor', async () => {
    // The hole. /mfa/enrol was reachable from a session that had cleared only
    // the password, and it overwrote the stored secret. So anyone holding a
    // password could enrol their OWN authenticator against an account that
    // already had one, then "verify" with it -- the second factor bypassed
    // by asking to set up a new one.
    const email = fresh('takeover')
    await upsertPlatformUser({ email, fullName: 'Takeover', password: PASS })
    try {
      await enrolAndVerify(await signIn(email))
      const before = await secretOf(email)
      expect(before).not.toBeNull()

      const passwordOnly = await signIn(email)            // password cleared, code not
      const attempt = await api('POST', '/api/platform/mfa/enrol', {}, passwordOnly)
      expect(attempt.status).toBe(409)
      expect(attempt.body.error?.code).toBe('MFA_ALREADY_ENROLLED')
      expect(await secretOf(email)).toBe(before)          // untouched

      const shut = await api('GET', '/api/platform/tenants', undefined, passwordOnly)
      expect(shut.status).toBe(403)
    } finally { await remove(email) }
  })

  it('guessing codes is rate limited', async () => {
    // Six digits is a million possibilities and the window accepts three at a
    // time. Unlimited attempts against a password-only session is a brute
    // force, so five misses lock it -- and the lock holds even for the right
    // code, or it would just be a slower guess.
    const email = fresh('guessing')
    await upsertPlatformUser({ email, fullName: 'Guessing', password: PASS })
    try {
      const secret = await enrolAndVerify(await signIn(email))
      const token = await signIn(email)
      for (let i = 0; i < 5; i++) {
        const r = await api('POST', '/api/platform/mfa/verify', { code: '000000' }, token)
        expect(r.body.error?.code).toBe('MFA_CODE_INVALID')
      }
      const locked = await api('POST', '/api/platform/mfa/verify', { code: totp(base32Decode(secret), stepAt()) }, token)
      expect(locked.status).toBe(429)
      expect(locked.body.error?.code).toBe('ACCOUNT_LOCKED')
    } finally { await remove(email) }
  })
})
