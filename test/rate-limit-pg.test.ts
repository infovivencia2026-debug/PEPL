/**
 * The shared limiter: two instances see one count, the window resets, a dead
 * store fails open, and the HTTP handler can be told to use it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { appPool, closePools } from '../src/db/pool.ts'
import { PgRateLimiter } from '../src/http/rate-limit-pg.ts'
import { Router, createHandler } from '../src/http/router.ts'

beforeAll(async () => {
  await appPool.query(`DELETE FROM rate_limit_buckets`)
})
afterAll(async () => {
  await closePools()
})

describe('PgRateLimiter', () => {
  it('two processes share one window', async () => {
    const limit = { max: 3, windowMs: 60_000 }
    const a = new PgRateLimiter(limit)
    const b = new PgRateLimiter(limit)
    const key = `ip:test-${Date.now()}`
    const t0 = Date.now()
    expect((await a.check(key, t0)).allowed).toBe(true)
    expect((await b.check(key, t0)).allowed).toBe(true)
    expect((await a.check(key, t0)).remaining).toBe(0)
    const fourth = await b.check(key, t0)
    expect(fourth.allowed).toBe(false)
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0)
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60)
    // the window rolls over: a new count starts
    expect((await a.check(key, t0 + 61_000))).toMatchObject({ allowed: true, remaining: 2 })
  })

  it('keys are independent', async () => {
    const l = new PgRateLimiter({ max: 1, windowMs: 60_000 })
    const now = Date.now()
    expect((await l.check(`k1-${now}`, now)).allowed).toBe(true)
    expect((await l.check(`k1-${now}`, now)).allowed).toBe(false)
    expect((await l.check(`k2-${now}`, now)).allowed).toBe(true)
  })

  it('fails OPEN when the store is unreachable, and counts the failure', async () => {
    const broken = { query: async () => { throw new Error('connection refused') } } as never
    const l = new PgRateLimiter({ max: 1, windowMs: 1000 }, broken)
    expect((await l.check('x')).allowed).toBe(true)
    expect((await l.check('x')).allowed).toBe(true)
    expect(l.failures).toBe(2)
  })

  it('sweeps rows whose window is long over', async () => {
    const l = new PgRateLimiter({ max: 5, windowMs: 1000 })
    const old = Date.now() - 2 * 3_600_000
    await l.check(`stale-${old}`, old)
    const removed = await PgRateLimiter.sweep(appPool, 3_600_000)
    expect(removed).toBeGreaterThanOrEqual(1)
  })
})

describe('the handler with store: postgres', () => {
  let server: Server
  let base: string
  beforeAll(async () => {
    const router = new Router()
    router.get('/api/v1/ping', { summary: 'p', tag: 'system', public: true }, async () => ({ status: 200, body: { ok: true } }))
    server = createServer(createHandler(router, { store: 'postgres', publicLimit: { max: 2, windowMs: 60_000 } }))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await appPool.query(`DELETE FROM rate_limit_buckets WHERE key LIKE 'ip:%'`)
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it('returns 429 with retry-after on the third request, from the shared table', async () => {
    expect((await fetch(`${base}/api/v1/ping`)).status).toBe(200)
    expect((await fetch(`${base}/api/v1/ping`)).status).toBe(200)
    const third = await fetch(`${base}/api/v1/ping`)
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    const { rows } = await appPool.query<{ count: number }>(`SELECT count FROM rate_limit_buckets WHERE key LIKE 'ip:%'`)
    expect(rows[0]!.count).toBe(3)
  })
})
