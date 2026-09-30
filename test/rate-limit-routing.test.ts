/**
 * Which rate limit a request falls under.
 *
 * The design says: public routes are limited per IP, everything else per session.
 * The code chose by whether a bearer token was PRESENT, not by whether the route
 * was public -- so attaching any junk `Authorization: Bearer x` header to the
 * login route moved the request into a private bucket keyed on that junk, and a
 * fresh junk value per request meant the per-IP limit never applied. Login
 * spraying, password-reset mail bombing and every other public route were
 * effectively unlimited. Reported by the audit; reproduced here first.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { RateLimiter, sessionKey } from '../src/http/rate-limit.ts'

let server: Server | undefined
afterEach(() => { server?.closeAllConnections(); server?.close(); server = undefined })

const start = async (options: Parameters<typeof createHandler>[1]) => {
  server = createServer(createHandler(buildRouter(), options))
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

const login = (base: string, n: number, bearer?: string) =>
  fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    // a different address each time, so the per-email lockout is not what answers
    body: JSON.stringify({ email: `spray-${n}-${Date.now()}@nowhere.test`, password: 'not-the-password-1' }),
  })

describe('a public route is limited per IP, whatever header it carries', () => {
  it('limits plain requests (the control)', async () => {
    const base = await start({ publicLimit: { max: 3, windowMs: 60_000 } })
    const statuses = []
    for (let i = 0; i < 6; i++) statuses.push((await login(base, i)).status)
    expect(statuses.slice(0, 3)).not.toContain(429)
    expect(statuses.slice(3)).toContain(429)
  })

  it('and a fresh junk bearer token on every request does not escape it', async () => {
    // The spray: one IP, a new bogus Authorization header each time. Before the
    // fix every one of these landed in its own bucket and none was ever refused.
    const base = await start({ publicLimit: { max: 3, windowMs: 60_000 } })
    const statuses = []
    for (let i = 0; i < 8; i++) statuses.push((await login(base, i, `junk-token-${i}-${Math.random()}`)).status)
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThanOrEqual(4)
  })
})

describe('an authenticated route is still limited per session, not per IP', () => {
  it('two different tokens do not share a bucket', async () => {
    // A real office shares one address. Session traffic must not be squeezed
    // through the per-IP limit meant for the login page.
    const base = await start({ publicLimit: { max: 1, windowMs: 60_000 }, sessionLimit: { max: 100, windowMs: 60_000 } })
    const statuses = []
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`${base}/api/v1/me`, { headers: { authorization: `Bearer token-${i}` } })
      statuses.push(r.status)
    }
    // Refused for having no valid session (401) -- never for rate (429).
    expect(statuses).not.toContain(429)
  })
})

describe('the session key', () => {
  it('is 128 bits, not 32', () => {
    // FNV-1a into 32 bits: with tens of thousands of live sessions two tokens
    // WILL share a bucket, and one person then spends another's allowance.
    expect(sessionKey('a-token').replace(/^s:/, '').length).toBeGreaterThanOrEqual(32)
  })

  it('is stable and distinguishes tokens', () => {
    expect(sessionKey('one')).toBe(sessionKey('one'))
    expect(sessionKey('one')).not.toBe(sessionKey('two'))
  })

  it('never contains the token itself', () => {
    expect(sessionKey('super-secret-token-value')).not.toContain('super-secret')
  })
})

describe('the limiter\'s memory', () => {
  it('is bounded, however many distinct keys arrive', () => {
    // Each junk token used to create a bucket that lived a full window. A stream
    // of them grew the map without limit.
    const limiter = new RateLimiter({ max: 5, windowMs: 60_000 }, 1_000)
    for (let i = 0; i < 5_000; i++) limiter.check(`k${i}`)
    expect(limiter.size()).toBeLessThanOrEqual(1_000)
  })

  it('still counts correctly for a key that is kept', () => {
    const limiter = new RateLimiter({ max: 2, windowMs: 60_000 }, 1_000)
    expect(limiter.check('same').allowed).toBe(true)
    expect(limiter.check('same').allowed).toBe(true)
    expect(limiter.check('same').allowed).toBe(false)
  })
})
