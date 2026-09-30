/**
 * The browser and the API must run payroll the same way.
 *
 * The browser (/api/ui) and the API (/api/v1) each built their own engine options
 * by hand. The browser's left out `computeTds`, so every payroll run from the UI
 * deducted ZERO income tax -- and the existing workflow test could not see it,
 * because it pays Rs 50,000 a month (Rs 6 lakh a year, under the rebate
 * threshold) and only asserts that net pay is positive. The v1 path, for its part,
 * passed no month (so a February professional-tax rule never applied) and read
 * the statutory rates of TODAY rather than the run's period.
 *
 * This runs identical payroll through both routes, in two companies, with a
 * salary that is actually taxable, and requires the same answer.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildUiRouter } from '../src/http/ui-routes.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { seedTaxTables, seedPtSlabs } from '../scripts/seed-statutory.ts'

const PASSWORD = 'parity-test-password'
let ui: Server, v1: Server, uiBase: string, v1Base: string
let A: Tenant, B: Tenant
const token: Record<string, string> = {}

const listen = async (server: Server): Promise<string> => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`
}

const call = async (base: string, path: string, who: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> & { id?: string; error?: { code: string; message: string } } }
}

beforeAll(async () => {
  ;({ a: A, b: B } = await resetAndSeed())
  await seedTaxTables()
  await seedPtSlabs('2026-04-01')
  for (const t of [A, B]) {
    await controlPool.query(
      `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"payroll":true}','{"employees":100}')
       ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [t.id])
    await withTenant(t.id, (tx) => createUser(tx, {
      tenantId: t.id, email: `payroll@${t.id.slice(0, 8)}.parity.test`, fullName: 'Payroll', password: PASSWORD, roles: ['payroll_admin'],
    }))
    const s = await login({ email: `payroll@${t.id.slice(0, 8)}.parity.test`, password: PASSWORD })
    if ('choose' in s) throw new Error('fixture address is in more than one company')
    token[t.id] = s.token
    await withTenant(t.id, (tx) => createUser(tx, {
      tenantId: t.id, email: `approver@${t.id.slice(0, 8)}.parity.test`, fullName: 'Approver', password: PASSWORD, roles: ['org_admin'],
    }))
    const a = await login({ email: `approver@${t.id.slice(0, 8)}.parity.test`, password: PASSWORD })
    if ('choose' in a) throw new Error('fixture address is in more than one company')
    token[`${t.id}:approver`] = a.token
  }
  ui = createServer(createHandler(buildUiRouter()))
  v1 = createServer(createHandler(buildRouter()))
  uiBase = await listen(ui)
  v1Base = await listen(v1)
})

afterAll(async () => {
  ui?.closeAllConnections(); v1?.closeAllConnections()
  ui?.close(); v1?.close()
  await closePools()
})

/** One employee on the given monthly basic, taxed under the new regime. */
const row = (t: Tenant, basicRupees: number, extra: Record<string, unknown> = {}) => ({
  employeeId: t.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
  monthlyComponents: { basic: basicRupees * 100 }, annualCtcPaise: basicRupees * 100 * 12,
  stateCode: 'TS', pfApplicable: true, esiApplicable: false, taxRegime: 'new', ...extra,
})

const OCTOBER = { label: '2026-10', start: '2026-10-01', end: '2026-10-31', pay: '2026-11-01' }
const FEBRUARY = { label: '2027-02', start: '2027-02-01', end: '2027-02-28', pay: '2027-03-01' }

async function runPayroll(via: 'ui' | 'v1', t: Tenant, rows: unknown[], p = OCTOBER) {
  const period = await withTenant(t.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods(tenant_id,label,period_start,period_end,pay_date)
     VALUES($1,$2,$3,$4,$5) RETURNING id`, [t.id, p.label, p.start, p.end, p.pay])).rows[0]!.id)
  const base = via === 'ui' ? uiBase : v1Base
  const prefix = via === 'ui' ? '/api/ui/payroll' : '/api/v1/payroll'

  const created = await call(base, `${prefix}/runs`, t.id, { periodId: period })
  expect(created.status, `${via} create`).toBe(201)
  const id = created.body.id!

  const freeze = via === 'ui'
    ? await call(base, `${prefix}/${id}/actions`, t.id, { action: 'freeze', rows })
    : await call(base, `${prefix}/runs/${id}/freeze`, t.id, { rows })
  expect(freeze.status, `${via} freeze: ${JSON.stringify(freeze.body)}`).toBe(200)

  const calc = via === 'ui'
    ? await call(base, `${prefix}/${id}/actions`, t.id, { action: 'calculate' })
    : await call(base, `${prefix}/runs/${id}/calculate`, t.id, {})
  expect(calc.status, `${via} calculate: ${JSON.stringify(calc.body)}`).toBe(200)

  return withTenant(t.id, async (tx) => {
    const lines = (await tx.query<{ component_code: string; amount_paise: string }>(
      `SELECT component_code, amount_paise::text FROM payroll_lines WHERE run_id = $1`, [id])).rows
    const get = (code: string) => Number(lines.find((l) => l.component_code === code)?.amount_paise ?? 0)
    return { id, tds: get('TDS'), pt: get('PT'), pf: get('PF_EE'), codes: lines.map((l) => l.component_code) }
  })
}

describe('income tax is deducted whichever door the payroll comes through', () => {
  it('the browser route deducts TDS on a taxable salary', async () => {
    // Rs 5,00,000 a month. NOT Rs 2,00,000: the run is October, so only six months
    // remain and a fresh company has earned nothing to date -- that projects to
    // Rs 12 lakh, under the 87A rebate threshold, and a legitimate zero looks just
    // like the bug. Rs 30 lakh projected leaves no room for the rebate to explain it.
    const r = await runPayroll('ui', A, [row(A, 500_000)])
    expect(r.codes).toContain('TDS')
    expect(r.tds).toBeGreaterThan(0)
  })

  it('the API route deducts TDS on the same salary', async () => {
    const r = await runPayroll('v1', B, [row(B, 500_000)])
    expect(r.tds).toBeGreaterThan(0)
  })

  it('and the two agree to the paisa', async () => {
    // Same period, same salary, same statutory tables, two different companies.
    const [a, b] = await withTenantsTds()
    expect(a).toBeGreaterThan(0)
    expect(a).toBe(b)
  })
})

/** The TDS each company's run produced, read back from the ledger lines. */
async function withTenantsTds(): Promise<[number, number]> {
  const one = (t: Tenant) => withTenant(t.id, async (tx) => Number((await tx.query<{ n: string | null }>(
    `SELECT sum(amount_paise)::text AS n FROM payroll_lines WHERE component_code = 'TDS'`)).rows[0]?.n ?? 0))
  return [await one(A), await one(B)]
}

describe('a state February rule applies through both doors', () => {
  // Karnataka charges Rs 200 a month and Rs 300 in February. The API passed no
  // month to the professional-tax lookup, so its February run charged Rs 200 --
  // a rule that was in the reference data and silently never applied.
  const karnataka = (t: Tenant) => row(t, 60_000, { stateCode: 'KA' })

  it('the browser charges the February amount', async () => {
    const r = await runPayroll('ui', A, [karnataka(A)], FEBRUARY)
    expect(r.pt).toBe(30_000)
  })

  it('and so does the API', async () => {
    const r = await runPayroll('v1', B, [karnataka(B)], FEBRUARY)
    expect(r.pt).toBe(30_000)
  })

  it('while every other month still charges the ordinary amount', async () => {
    // A control, so "always 300" cannot pass. October, the other company.
    const r = await runPayroll('v1', A, [karnataka(A)], { ...OCTOBER, label: '2026-10b' })
    expect(r.pt).toBe(20_000)
  })
})

describe('approving a run checks it for anomalies, whichever door it comes through', () => {
  // The API ran the payroll guards before approving. The browser called approve()
  // directly, and approve() only refuses findings that are ALREADY open -- so a
  // run driven from the UI never generated any, and an approver never saw them.
  // PAID_BEFORE_JOINING is a blocking guard: paying someone whose joining date is
  // after the period.
  const NOVEMBER = { label: '2026-11', start: '2026-11-01', end: '2026-11-30', pay: '2026-12-01' }

  const payBeforeJoining = async (via: 'ui' | 'v1', t: Tenant) => {
    const original = (await controlPool.query<{ d: string }>(`SELECT date_of_joining::text AS d FROM employees WHERE id = $1`, [t.employeeId])).rows[0]!.d
    await controlPool.query(`UPDATE employees SET date_of_joining = '2030-01-01' WHERE id = $1`, [t.employeeId])
    try {
      const r = await runPayroll(via, t, [row(t, 90_000)], NOVEMBER)
      const base = via === 'ui' ? uiBase : v1Base
      const validated = via === 'ui'
        ? await call(base, `/api/ui/payroll/${r.id}/actions`, t.id, { action: 'validate' })
        : await call(base, `/api/v1/payroll/runs/${r.id}/validate`, t.id, {})
      expect(validated.status, `${via} validate: ${JSON.stringify(validated.body)}`).toBe(200)
      // `return await`, not `return`: the finally below restores the joining date,
      // and a bare return runs it while the request is still in flight -- the guard
      // then reads an ordinary employee and the approval sails through.
      return await (via === 'ui'
        ? call(base, `/api/ui/payroll/${r.id}/actions`, `${t.id}:approver`, { action: 'approve' })
        : call(base, `/api/v1/payroll/runs/${r.id}/approve`, `${t.id}:approver`, {}))
    } finally {
      await controlPool.query(`UPDATE employees SET date_of_joining = $2 WHERE id = $1`, [t.employeeId, original])
    }
  }

  it('the API refuses to approve a run that pays someone before they joined', async () => {
    const r = await payBeforeJoining('v1', B)
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('ANOMALIES_OPEN')
  })

  it('and so does the browser', async () => {
    const r = await payBeforeJoining('ui', A)
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('ANOMALIES_OPEN')
  })
})
