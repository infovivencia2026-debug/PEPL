/**
 * What a login request is allowed to be, and what gets recorded about it.
 *
 * The browser's login route trimmed and lower-cased the address; the API's did
 * neither. So `Admin@Acme.test` and `admin@acme.test` had SEPARATE lockout budgets
 * -- five wrong guesses each, per capitalisation, per stray space -- a body of any
 * size was written into `login_attempts` (an audit measured five megabytes a row),
 * and a non-string email surfaced as a 500.
 *
 * And every recorded IP was the reverse proxy's: `req.ip` was the socket address,
 * which behind OpenLiteSpeed is always 127.0.0.1. The attempt log, and the
 * per-address view an operator would use to find a spray, all said the same thing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { buildUiRouter } from '../src/http/ui-routes.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'

const PASSWORD = 'a-long-password-1'
// Failures are counted per ADDRESS for fifteen minutes and this file runs often, so anything
// that fails on purpose gets an address of its own each run -- a fixed one carries the last
// run's misses and starts answering 429 before the assertion is reached.
const RUN = Date.now()
let A: Tenant, v1: Server, ui: Server, v1Base: string, uiBase: string

const post = async (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: { code: string } } & Record<string, unknown> }
}
const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, (tx) => createUser(tx, {
    tenantId: A.id, email: 'person@input.test', fullName: 'Person', password: PASSWORD, roles: ['employee'], employeeId: A.employeeId,
  }))
  v1 = createServer(createHandler(buildRouter()))
  ui = createServer(createHandler(buildUiRouter()))
  v1Base = await listen(v1)
  uiBase = await listen(ui)
})
afterAll(async () => {
  v1?.closeAllConnections(); ui?.closeAllConnections(); v1?.close(); ui?.close()
  await closePools()
  await controlPool.end()
})

describe('the address is normalised before it is counted', () => {
  it('capital letters and stray spaces share one lockout budget', async () => {
    // A fresh address every run: failures are counted per address for fifteen minutes, so
    // a fixed one carries the previous run's misses and locks early.
    const base = `lock-${Date.now()}@input.test`
    await withTenant(A.id, (tx) => createUser(tx, {
      tenantId: A.id, email: base, fullName: 'Lock', password: PASSWORD, roles: ['employee'],
    }))
    const [local, domain] = base.split('@') as [string, string]
    // Eight wrong guesses lock an address (MAX_FAILED in auth/index.ts), so spell it eight
    // different ways. Under the old behaviour each spelling had its own budget of eight
    // and none of them ever reached it.
    const variants = [
      `${local.toUpperCase()}@${domain}`, `${base} `, ` ${base.toUpperCase()}`, `${local}@${domain.toUpperCase()}`,
      `${local[0]!.toUpperCase()}${local.slice(1)}@${domain}`, `  ${base}`, base.toUpperCase(), `${local}@${domain} `,
    ]
    for (const email of variants) {
      const r = await post(v1Base, '/api/v1/auth/login', { email, password: 'the-wrong-password' })
      expect(r.status, email).toBe(401)
    }
    // Eight different spellings of ONE address have used up its budget...
    const locked = await post(v1Base, '/api/v1/auth/login', { email: base, password: PASSWORD })
    expect(locked.status).toBe(429)
  })

  it('and a differently-cased address still signs in', async () => {
    const r = await post(v1Base, '/api/v1/auth/login', { email: '  Person@INPUT.test ', password: PASSWORD })
    expect(r.status, JSON.stringify(r.body)).toBe(200)
  })
})

describe('what a login request may be', () => {
  it('refuses an email that is not text, as a client error not a crash', async () => {
    for (const email of [123, null, ['a@b.c'], { x: 1 }, true]) {
      const r = await post(v1Base, '/api/v1/auth/login', { email, password: PASSWORD })
      expect(r.status, JSON.stringify(email)).toBe(422)
    }
  })

  it('refuses an enormous email, and records nothing of it', async () => {
    const oversized = async () => Number((await controlPool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_attempts WHERE length(email) > 320`)).rows[0]!.n)
    // Before AND after, not "none at all": the table is not reset between runs, and a
    // row left by an earlier run of this very test (written by the bug it demonstrates)
    // is not this run's doing.
    const before = await oversized()
    const huge = 'a'.repeat(50_000) + '@input.test'
    const r = await post(v1Base, '/api/v1/auth/login', { email: huge, password: PASSWORD })
    expect(r.status).toBe(422)
    // It used to be stored whole. A login log row is not the place for 50 KB.
    expect(await oversized()).toBe(before)
  })

  it('refuses an enormous password before spending scrypt on it', async () => {
    const r = await post(v1Base, '/api/v1/auth/login', { email: 'person@input.test', password: 'p'.repeat(100_000) })
    expect(r.status).toBe(422)
  })

  it('applies the same rules to the browser\'s login', async () => {
    expect((await post(uiBase, '/api/ui/auth/login', { email: 123, password: PASSWORD })).status).toBe(422)
    expect((await post(uiBase, '/api/ui/auth/login', { email: '  PERSON@input.test', password: PASSWORD })).status).toBe(200)
  })
})

describe('the address that is recorded is the visitor\'s', () => {
  it('uses the forwarded address when the request came through our own proxy', async () => {
    // The test server is reached over loopback, exactly as OpenLiteSpeed reaches
    // the app, so a forwarded address is trusted.
    await post(v1Base, '/api/v1/auth/login', { email: `fwd-${RUN}@input.test`, password: 'wrong-password-value' }, { 'x-forwarded-for': '203.0.113.77' })
    const { rows } = await controlPool.query<{ ip: string }>(
      `SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 ORDER BY id DESC LIMIT 1`, [`fwd-${RUN}@input.test`])
    expect(rows[0]?.ip).toBe('203.0.113.77')
  })

  it('records the browser route\'s attempt the same way', async () => {
    await post(uiBase, '/api/ui/auth/login', { email: `fwdui-${RUN}@input.test`, password: 'wrong-password-value' }, { 'x-forwarded-for': '198.51.100.9' })
    const { rows } = await controlPool.query<{ ip: string }>(
      `SELECT host(ip) AS ip FROM login_attempts WHERE email = $1 ORDER BY id DESC LIMIT 1`, [`fwdui-${RUN}@input.test`])
    expect(rows[0]?.ip).toBe('198.51.100.9')
  })

  it('does not let a garbage header break the insert', async () => {
    // `ip` is an inet column; an unparseable value would throw and read as a 500.
    const r = await post(v1Base, '/api/v1/auth/login', { email: `garbage-${RUN}@input.test`, password: 'wrong-password-value' }, { 'x-forwarded-for': 'not-an-address' })
    expect(r.status).toBe(401)
  })
})

describe('login() is safe to call directly', () => {
  // Every route reaches it through unifiedLogin, which normalises first. This is the
  // second line of defence for anything that calls login() itself -- a job, a future
  // route, a test -- so the rules cannot depend on who happens to be the caller.
  it('normalises the address it is handed', async () => {
    const r = await login({ email: '  PERSON@Input.TEST ', password: PASSWORD })
    expect('token' in r || 'choose' in r).toBe(true)
  })

  it('refuses input that is not text or is absurdly long', async () => {
    await expect(login({ email: 123 as never, password: PASSWORD })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(login({ email: 'x'.repeat(400), password: PASSWORD })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(login({ email: 'person@input.test', password: 'p'.repeat(2000) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})
