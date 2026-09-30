/**
 * An employee can read their own payslip. They must not be able to read the
 * company's payroll.
 *
 * Every employee holds `payroll.read` so they can see their own pay. But
 * `assertScope(ctx, undefined)` returns silently when there is no target employee,
 * so any route about a whole RUN -- its totals, its validation, its accounting
 * journal, its payment status, the approval anomalies -- skipped the scope check
 * entirely and answered to anyone with the permission. Reported by an audit; this
 * probes each one as a real employee rather than trusting a reading of the code.
 *
 * Separately: GET /validation moved a run from `calculated` to `validated` as a
 * side effect, so a read-only auditor could advance a payroll by fetching a URL.
 */
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, login } from '../src/auth/index.ts'
import { seedTaxTables } from '../scripts/seed-statutory.ts'

const PASSWORD = 'read-scope-test-password'
let server: Server, base: string, A: Tenant, runId: string
const token: Record<string, string> = {}

const call = async (path: string, who: string, body?: unknown) => {
  const r = await fetch(base + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: r.status, body: (await r.json().catch(() => ({}))) as { error?: { code: string } } & Record<string, unknown> }
}

const statusOf = async (runIdValue: string): Promise<string> =>
  withTenant(A.id, async (tx) => (await tx.query<{ status: string }>(`SELECT status FROM payroll_runs WHERE id = $1`, [runIdValue])).rows[0]!.status)

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await seedTaxTables()
  await controlPool.query(
    `INSERT INTO tenant_entitlements(tenant_id,plan_code,features,limits) VALUES($1,'test','{"payroll":true}','{"employees":100}')
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`, [A.id])

  for (const [name, roles, employeeId] of [
    ['payroll_admin', ['payroll_admin'], undefined],
    ['employee', ['employee'], A.employeeId],
    ['auditor', ['auditor'], undefined],
  ] as const) {
    await withTenant(A.id, (tx) => createUser(tx, {
      tenantId: A.id, email: `${name}@scope.test`, fullName: name, password: PASSWORD, roles: [...roles], employeeId,
    }))
    const s = await login({ email: `${name}@scope.test`, password: PASSWORD })
    if ('choose' in s) throw new Error('fixture address is in more than one company')
    token[name] = s.token
  }

  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  // A calculated run to probe.
  const period = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods(tenant_id,label,period_start,period_end,pay_date)
     VALUES($1,'2026-10','2026-10-01','2026-10-31','2026-11-01') RETURNING id`, [A.id])).rows[0]!.id)
  runId = (await call('/api/v1/payroll/runs', 'payroll_admin', { periodId: period })).body.id as string
  await call(`/api/v1/payroll/runs/${runId}/freeze`, 'payroll_admin', { rows: [{
    employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0,
    monthlyComponents: { basic: 5_000_000 }, annualCtcPaise: 60_000_000, stateCode: 'TS', pfApplicable: true, esiApplicable: false,
  }] })
  await call(`/api/v1/payroll/runs/${runId}/calculate`, 'payroll_admin', {})
})

afterAll(async () => {
  server?.closeAllConnections(); server?.close()
  await closePools()
})

describe('what an employee must not see of the company\'s payroll', () => {
  const companyWide = (id: () => string): Array<[string, () => string]> => [
    ['the list of pay periods and their runs', () => '/api/v1/payroll/periods'],
    ['a run and its totals', () => `/api/v1/payroll/runs/${id()}`],
    ['a run\'s validation', () => `/api/v1/payroll/runs/${id()}/validation`],
    ['what changed in a revision', () => `/api/v1/payroll/runs/${id()}/delta`],
    ['the accounting journal', () => `/api/v1/payroll/runs/${id()}/journal`],
    ['whether the bank paid', () => `/api/v1/payroll/runs/${id()}/payment-status`],
    ['the ledger mappings', () => '/api/v1/payroll/ledger-mappings'],
    ['the payroll anomaly findings', () => '/api/v1/anomalies?area=payroll'],
    ['the provident fund return', () => `/api/v1/payroll/runs/${id()}/filings/ecr`],
    ['the ESI return', () => `/api/v1/payroll/runs/${id()}/filings/esi`],
  ]

  for (const [label, path] of companyWide(() => runId)) {
    it(`is refused: ${label}`, async () => {
      const r = await call(path(), 'employee')
      expect(r.status, `${path()} answered ${r.status} ${JSON.stringify(r.body)}`).toBe(403)
    })
  }

  it('but they can still read their own payslips', async () => {
    // The control: closing the company-wide routes must not close their own pay.
    expect((await call('/api/v1/payslips', 'employee')).status).toBe(200)
  })

  it('and the payroll team can still read everything above', async () => {
    for (const [label, path] of companyWide(() => runId).slice(0, 3)) {
      const r = await call(path(), 'payroll_admin')
      expect(r.status, `${label}: ${path()} -> ${r.status}`).toBe(200)
    }
  })
})

describe('reading a run\'s validation changes nothing', () => {
  it('fetching it as an auditor leaves the run calculated', async () => {
    // GET used to advance the run to `validated` as a side effect.
    expect(await statusOf(runId)).toBe('calculated')
    const r = await call(`/api/v1/payroll/runs/${runId}/validation`, 'auditor')
    expect(r.status).toBe(200)
    expect(await statusOf(runId)).toBe('calculated')
  })

  it('validating is a deliberate act that needs the right to process payroll', async () => {
    expect((await call(`/api/v1/payroll/runs/${runId}/validate`, 'auditor', {})).status).toBe(403)
    expect(await statusOf(runId)).toBe('calculated')

    const r = await call(`/api/v1/payroll/runs/${runId}/validate`, 'payroll_admin', {})
    expect(r.status).toBe(200)
    expect(await statusOf(runId)).toBe('validated')
  })
})

describe('a payslip of a run that is not locked yet', () => {
  // Until the run is locked the numbers are a draft: they can still change, and a payroll
  // team is still checking them. GET /payslips/:id/lines served them to the employee they
  // belong to (payroll.read is what lets anyone see their own pay), and unlike the PDF it left
  // no access record. Reported by an audit.
  const slipId = () => withTenant(A.id, async (tx) =>
    (await tx.query<{ id: string }>(`SELECT id FROM payslips WHERE run_id = $1`, [runId])).rows[0]!.id)
  const audited = async (id: string) => Number((await controlPool.query(
    `SELECT count(*)::int AS n FROM audit_events WHERE tenant_id = $1 AND action = 'access.tier3.revealed'
        AND entity_id = $2 AND metadata->>'format' = 'lines'`, [A.id, id])).rows[0].n)

  it('is not readable by its owner while the run is a draft', async () => {
    const id = await slipId()
    expect((await call(`/api/v1/payslips/${id}/lines`, 'employee')).status).toBe(403)
    expect((await call(`/api/v1/payslips/${id}/pdf`, 'employee')).status).toBe(403)
  })

  it('is readable by the payroll team, and each read of the lines is recorded', async () => {
    const id = await slipId()
    const before = await audited(id)
    const r = await call(`/api/v1/payslips/${id}/lines`, 'payroll_admin')
    expect(r.status).toBe(200)
    expect(await audited(id)).toBe(before + 1)
  })

  it('is readable by its owner once the run is locked -- and that read is recorded too', async () => {
    // Locked directly: the approval chain is not what is under test.
    await controlPool.query(`UPDATE payroll_runs SET status = 'locked' WHERE id = $1`, [runId])
    const id = await slipId()
    const before = await audited(id)
    const r = await call(`/api/v1/payslips/${id}/lines`, 'employee')
    expect(r.status).toBe(200)
    expect(await audited(id)).toBe(before + 1)
    expect((await call(`/api/v1/payslips/${id}/pdf`, 'employee')).status).toBe(200)
  })
})
