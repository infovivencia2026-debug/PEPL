/**
 * Opening year-to-date figures: what an employee had earned and paid in tax BEFORE their first PEPL run.
 *
 * A company moving onto PEPL in, say, October has six months of salary and tax already behind it. With
 * nowhere to record that, the October run computed TDS as if the year had begun in October: it projected a
 * full year of income out of six months of data, taxed it at the wrong slab and never credited the tax
 * already deducted. The opening figures are an append-only record (a correction is a new row; the latest
 * wins) and `yearToDate` adds them to whatever PEPL has locked itself.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { yearToDate } from '../src/payroll/run.ts'
import { recordOpeningYtd, listOpeningYtd } from '../src/payroll/opening-ytd.ts'

let A: Tenant
let B: Tenant
// TRUNCATE inside resetAndSeed waits for locks the previous file's connections may still hold: allow for it.
beforeAll(async () => { const s = await resetAndSeed(); A = s.a; B = s.b }, 30_000)
afterAll(async () => { await closePools(); await controlPool.end() })

const L = (r: number): bigint => BigInt(r * 100)
const OCT_2026 = new Date('2026-10-01T00:00:00Z')

const ytd = (t: Tenant, when = OCT_2026) => withTenant(t.id, (tx) => yearToDate(tx, t.employeeId, when))
const record = (t: Tenant, over: Partial<Parameters<typeof recordOpeningYtd>[1]> = {}) => withTenant(t.id, (tx) => recordOpeningYtd(tx, {
  employeeId: t.employeeId, fiscalYear: '2026-27', taxablePaise: L(300_000), tdsPaise: L(12_000), reason: 'from the previous payroll system', ...over }))

describe('year to date includes the opening figures', () => {
  it('is zero with nothing recorded', async () => {
    const r = await ytd(A)
    expect([r.taxablePaise, r.tdsPaise]).toEqual([0n, 0n])
  })

  it('adds the opening taxable income and tax already deducted', async () => {
    await record(A)
    const r = await ytd(A)
    expect(r.taxablePaise).toBe(L(300_000))
    expect(r.tdsPaise).toBe(L(12_000))
  })

  it('a correction is a new row and the latest one wins, so the figures are never added twice', async () => {
    await record(A, { taxablePaise: L(320_000), tdsPaise: L(13_000), reason: 'corrected after reconciliation' })
    const r = await ytd(A)
    expect([r.taxablePaise, r.tdsPaise]).toEqual([L(320_000), L(13_000)])
    expect((await withTenant(A.id, (tx) => listOpeningYtd(tx, A.employeeId))).length).toBe(2)
  })

  it('belongs to its own fiscal year: another year does not see it', async () => {
    const next = await ytd(A, new Date('2027-05-01T00:00:00Z'))
    expect([next.taxablePaise, next.tdsPaise]).toEqual([0n, 0n])
  })

  it('one company never sees another company\'s opening figures', async () => {
    const r = await ytd(B)
    expect([r.taxablePaise, r.tdsPaise]).toEqual([0n, 0n])
  })
})

describe('what may be recorded', () => {
  it('refuses a negative amount, a malformed fiscal year and a missing reason', async () => {
    await expect(record(A, { taxablePaise: -1n })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(record(A, { tdsPaise: -5n })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(record(A, { fiscalYear: '2026' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(record(A, { reason: '  ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('the record is evidence, so the runtime role cannot rewrite it', () => {
  it('UPDATE and DELETE are refused to the application role', async () => {
    await expect(withTenant(A.id, (tx) => tx.query(`UPDATE payroll_opening_ytd SET taxable_paise = 1`))).rejects.toThrow(/permission denied/)
    await expect(withTenant(A.id, (tx) => tx.query(`DELETE FROM payroll_opening_ytd`))).rejects.toThrow(/permission denied/)
  })
})

describe('the API', () => {
  it('payroll_admin can record and read opening figures; an employee cannot; the audit trail names it', async () => {
    const { createServer } = await import('node:http')
    const { createHandler } = await import('../src/http/router.ts')
    const { buildRouter } = await import('../src/http/app.ts')
    const { createUser } = await import('../src/auth/index.ts')
    await withTenant(A.id, async (tx) => {
      await createUser(tx, { tenantId: A.id, email: 'pay@openytd.test', fullName: 'Pay Admin', password: 'a-long-password-1', roles: ['payroll_admin'] })
      await createUser(tx, { tenantId: A.id, email: 'emp@openytd.test', fullName: 'Plain Emp', password: 'a-long-password-1', roles: ['employee'] })
    })
    const server = createServer(createHandler(buildRouter()))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const call = async (token: string | null, method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) })
      return { status: res.status, body: await res.json().catch(() => ({})) as Record<string, unknown> }
    }
    const login = async (email: string) => ((await call(null, 'POST', '/api/v1/auth/login', { email, password: 'a-long-password-1' })).body as { token: string }).token
    try {
      const pay = await login('pay@openytd.test'), emp = await login('emp@openytd.test')
      const path = `/api/v1/employees/${A.employeeId}/opening-ytd`
      const good = { fiscalYear: '2026-27', taxablePaise: 25000000, tdsPaise: 900000, reason: 'Apr-Sep from the old system' }
      expect((await call(emp, 'POST', path, good)).status).toBe(403)
      expect((await call(emp, 'GET', path)).status).toBe(403)
      expect((await call(pay, 'POST', path, { ...good, taxablePaise: -5 })).status).toBe(422)
      expect((await call(pay, 'POST', path, { ...good, taxablePaise: 1.5 })).status).toBe(422)
      expect((await call(pay, 'POST', path, good)).status).toBe(201)
      const list = await call(pay, 'GET', path)
      expect(list.status).toBe(200)
      expect((list.body.entries as unknown[]).length).toBeGreaterThan(0)
      const { rows } = await controlPool.query(`SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'payroll.opening_ytd.recorded'`, [A.id])
      expect(rows[0].n).toBe(1)
    } finally { server.close() }
  })
});
