/**
 * Rate limiting.
 *
 * The unit half pins the window arithmetic. The HTTP half proves the two limits
 * are wired to the right keys: an IP for the front door, a session for
 * everything behind it — and that the probes a load balancer relies on are
 * never told to back off.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb, provisionTenant } from '../src/control-plane/index.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { createUser } from '../src/auth/index.ts'
import { RateLimiter, sessionKey } from '../src/http/rate-limit.ts'

describe('the window', () => {
  it('allows up to the limit, then refuses until the window resets', () => {
    const limiter = new RateLimiter({ max: 3, windowMs: 1000 })
    const t0 = 1_000_000
    expect(limiter.check('a', t0).allowed).toBe(true)
    expect(limiter.check('a', t0).allowed).toBe(true)
    expect(limiter.check('a', t0).allowed).toBe(true)

    const refused = limiter.check('a', t0 + 10)
    expect(refused.allowed).toBe(false)
    expect(refused.retryAfterSeconds).toBe(1)

    expect(limiter.check('a', t0 + 1000).allowed).toBe(true)
  })

  it('keeps keys apart', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 })
    expect(limiter.check('a').allowed).toBe(true)
    expect(limiter.check('b').allowed).toBe(true)
    expect(limiter.check('a').allowed).toBe(false)
  })

  it('reports what is left', () => {
    const limiter = new RateLimiter({ max: 5, windowMs: 1000 })
    expect(limiter.check('a').remaining).toBe(4)
    expect(limiter.check('a').remaining).toBe(3)
  })

  it('forgets expired buckets rather than growing forever', () => {
    const limiter = new RateLimiter({ max: 1, windowMs: 1000 })
    const t0 = 5_000_000
    for (let i = 0; i < 100; i++) limiter.check(`k${i}`, t0)
    expect(limiter.size()).toBe(100)
    limiter.check('fresh', t0 + 2000)   // a sweep is due
    expect(limiter.size()).toBe(1)
  })

  it('never keeps the token itself as a key', () => {
    const key = sessionKey('super-secret-session-token')
    expect(key).not.toContain('secret')
    expect(key).toMatch(/^s:[0-9a-f]+$/)
    expect(sessionKey('a')).not.toBe(sessionKey('b'))
  })
})

// ---------------------------------------------------------------------------

let server: Server
let base: string
let token: string

beforeAll(async () => {
  // Low limits so the tests reach 429 in a handful of requests.
  server = createServer(createHandler(buildRouter(), {
    publicLimit: { max: 4, windowMs: 60_000 },
    sessionLimit: { max: 6, windowMs: 60_000 },
  }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const stamp = Date.now()
  const email = `rl-${stamp}@ratelimit.local`
  const { tenantId } = await provisionTenant({
    legalName: `Rate Limit ${stamp}`, displayName: 'RL', planCode: 'professional',
    adminEmail: email, adminName: 'RL',
  })
  await withTenant(tenantId, (tx) =>
    createUser(tx, { tenantId, email, fullName: 'RL', password: 'rate-limit-pass', roles: ['org_admin'] }))

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'rate-limit-pass' }),
  })
  token = ((await login.json()) as { token: string }).token
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closePools()
  await controlDb.end()
})

const hit = (path: string, auth?: string) =>
  fetch(`${base}${path}`, {
    method: path.includes('login') ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      ...(auth ? { authorization: `Bearer ${auth}` } : {}),
    },
    body: path.includes('login') ? JSON.stringify({ email: 'x@y.test', password: 'wrong' }) : undefined,
  })

describe('the front door is limited per IP', () => {
  it('turns a login spray into 429s with a Retry-After', async () => {
    // The login in beforeAll already spent one of the four.
    const statuses: number[] = []
    for (let i = 0; i < 5; i++) statuses.push((await hit('/api/v1/auth/login')).status)

    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0)
    const last = await hit('/api/v1/auth/login')
    expect(last.status).toBe(429)
    expect(last.headers.get('retry-after')).toMatch(/^\d+$/)
    const body = (await last.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
  })
})

describe('a session is limited on its own', () => {
  it('does not share the public bucket the login spray exhausted', async () => {
    const r = await hit('/api/v1/me', token)
    expect(r.status).toBe(200)
  })

  it('refuses once the session has used its allowance', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 8; i++) statuses.push((await hit('/api/v1/me', token)).status)
    expect(statuses).toContain(429)
    expect(statuses[0]).toBe(200)
  })
})

describe('what is never limited', () => {
  it('leaves the probes alone however hard they are polled', async () => {
    for (let i = 0; i < 12; i++) {
      expect((await hit('/health')).status).toBe(200)
    }
  })
})
