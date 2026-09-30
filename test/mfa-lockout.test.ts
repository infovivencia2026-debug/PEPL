/**
 * A customer's second factor cannot be guessed.
 *
 * The operator console locks after five wrong codes. The customer-facing verify
 * had no counter at all: six digits, three accepted per window, from a session
 * that has cleared only the PASSWORD -- guessable at the speed of the network.
 *
 * The obvious fix is subtly wrong. `verify()` runs inside the request's
 * transaction, and a wrong code throws, so the transaction rolls back and takes any
 * counter written inside it along. The failure has to be recorded on a SEPARATE
 * connection, the way login records its own failed attempts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { createUser } from '../src/auth/index.ts'
import { totp, stepAt } from '../src/auth/mfa.ts'

const PASSWORD = 'a-long-password-1'
let A: Tenant, server: Server, base: string

const call = async (token: string | null, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, any> }
}

const b32decode = (s: string): Buffer => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of s) {
    value = (value << 5) | alphabet.indexOf(c); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

/** A user with MFA fully enrolled; returns a way to produce a code that is genuinely valid. */
async function enrolledUser(email: string): Promise<() => string> {
  await withTenant(A.id, (tx) => createUser(tx, {
    tenantId: A.id, email, fullName: email, password: PASSWORD, roles: ['org_admin'],
  }))
  const first = await call(null, 'POST', '/api/v1/auth/login', { email, password: PASSWORD })
  const token = first.body.token as string
  const setup = await call(token, 'POST', '/api/v1/auth/mfa/setup')
  const secret = setup.body.secret as string
  const enabled = await call(token, 'POST', '/api/v1/auth/mfa/enable', { code: totp(b32decode(secret), stepAt()) })
  expect(enabled.status, JSON.stringify(enabled.body)).toBe(200)
  // Enabling CONSUMED this 30-second step, and replay protection then refuses the same
  // code again -- correctly. A recovery code is the known-good, single-use answer.
  const recovery: string[] = [...(enabled.body.recoveryCodes as string[])]
  return () => recovery.shift()!
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await closePools()
  await controlPool.end()
})

describe('guessing a second-factor code', () => {
  it('locks after five wrong codes, and the lock holds for the right one', async () => {
    const email = 'guesser@lockout.test'
    const code = await enrolledUser(email)

    // A fresh sign-in: password cleared, second factor still pending.
    const session = (await call(null, 'POST', '/api/v1/auth/login', { email, password: PASSWORD })).body.token as string

    for (let i = 0; i < 5; i++) {
      const r = await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' })
      expect(r.status, `wrong code ${i + 1}`).toBe(422)
      expect(r.body.error?.code).toBe('MFA_CODE_INVALID')
    }

    // The sixth attempt is the RIGHT code. A lock that lets it through only slows
    // the guessing down; it does not stop it.
    const locked = await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: code() })
    expect(locked.status).toBe(429)
    expect(locked.body.error?.code).toBe('ACCOUNT_LOCKED')
  })

  it('counts across sessions, so signing in again does not reset the guesses', async () => {
    // Otherwise the attacker simply re-authenticates with the password every five
    // tries and starts over.
    const email = 'resigner@lockout.test'
    const code = await enrolledUser(email)
    const signIn = async () => (await call(null, 'POST', '/api/v1/auth/login', { email, password: PASSWORD })).body.token as string

    let session = await signIn()
    for (let i = 0; i < 3; i++) await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' })
    session = await signIn()
    for (let i = 0; i < 2; i++) await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' })

    const locked = await call(await signIn(), 'POST', '/api/v1/auth/mfa/verify', { code: code() })
    expect(locked.status).toBe(429)
  })

  it('does not lock somebody who simply mistyped once', async () => {
    const email = 'typo@lockout.test'
    const code = await enrolledUser(email)
    const session = (await call(null, 'POST', '/api/v1/auth/login', { email, password: PASSWORD })).body.token as string

    expect((await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' })).status).toBe(422)
    const ok = await call(session, 'POST', '/api/v1/auth/mfa/verify', { code: code() })
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
  })

  it('is per person: one account being guessed does not lock another', async () => {
    const victim = 'victim@lockout.test', bystander = 'bystander@lockout.test'
    await enrolledUser(victim)
    const okCode = await enrolledUser(bystander)
    const v = (await call(null, 'POST', '/api/v1/auth/login', { email: victim, password: PASSWORD })).body.token as string
    for (let i = 0; i < 6; i++) await call(v, 'POST', '/api/v1/auth/mfa/verify', { code: '000000' })

    const b = (await call(null, 'POST', '/api/v1/auth/login', { email: bystander, password: PASSWORD })).body.token as string
    expect((await call(b, 'POST', '/api/v1/auth/mfa/verify', { code: okCode() })).status).toBe(200)
  })
})
