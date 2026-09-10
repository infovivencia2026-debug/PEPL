/**
 * The bank file over HTTP.
 *
 * The module was tested and had no route, so salary disbursement was
 * unreachable. These cover the endpoint: who may call it, and that the two
 * safety properties survive the transport — locked runs only, and a repeat call
 * returns the same file rather than authorising a second payment.
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
import {
  approve, calculate, createRun, freezeInputs, lock, validate, type FreezeRow,
} from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let server: Server
let base: string
let tenantId: string
let financeToken: string
let employeeToken: string
let lockedRunId: string
let draftRunId: string

const PASSWORD = 'payments-test-password'
const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'

const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12,
    pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325,
    esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: () => BigInt(L(200)),
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}

async function api<T = Record<string, never>>(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: T & { error?: { code: string; message: string } } }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const text = await res.text()
  return { status: res.status, body: text ? JSON.parse(text) : {} }
}

beforeAll(async () => {
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`

  const stamp = Date.now()
  const provisioned = await provisionTenant({
    legalName: `Payments Test ${stamp}`, displayName: 'Payments Test',
    planCode: 'professional',
    adminEmail: `pay-admin-${stamp}@paytest.local`, adminName: 'Admin',
  })
  tenantId = provisioned.tenantId

  const financeEmail = `pay-finance-${stamp}@paytest.local`
  const employeeEmail = `pay-emp-${stamp}@paytest.local`

  const setup = await withTenant(tenantId, async (tx) => {
    const { rows: emp } = await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
       VALUES ($1,'P-001','Rahul',DATE '2025-06-01') RETURNING id`, [tenantId])
    const employeeId = emp[0]!.id

    await tx.query(
      `INSERT INTO employee_bank_accounts
         (tenant_id, employee_id, beneficiary_name, account_number, ifsc, bank_name)
       VALUES ($1,$2,'Rahul Nair','000111222333','HDFC0000123','HDFC Bank')`,
      [tenantId, employeeId])

    const { rows: period } = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01')
       RETURNING id`, [tenantId])

    await createUser(tx, {
      tenantId, email: financeEmail, fullName: 'Finance', password: PASSWORD, roles: ['finance'],
    })
    await createUser(tx, {
      tenantId, email: employeeEmail, fullName: 'Employee', password: PASSWORD,
      roles: ['employee'], employeeId,
    })
    // A second period, so the draft run does not collide with the locked one:
    // a run is unique per (tenant, period, revision).
    const { rows: nextPeriod } = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01')
       RETURNING id`, [tenantId])

    return { employeeId, periodId: period[0]!.id, nextPeriodId: nextPeriod[0]!.id }
  })

  const { rows: statutory } = await controlDb.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2)
     -- statutory rows are GLOBAL and another suite may already own this date
     ON CONFLICT (effective_from) DO UPDATE SET pf_employee_rate = EXCLUDED.pf_employee_rate
     RETURNING id`,
    [String(OPTS.statutory.pf_wage_ceiling_paise), String(OPTS.statutory.esi_gross_threshold_paise)])

  const row = (employeeId: string): FreezeRow => ({
    employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
    monthlyComponents: { basic: L(20_000), hra: L(8_000), special: L(12_000) },
    annualCtcPaise: L(480_000), stateCode: 'TS', pfApplicable: true,
  })

  lockedRunId = await withTenant(tenantId, async (tx) => {
    const runId = await createRun(tx, { periodId: setup.periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [row(setup.employeeId)], { lop_basis: 'calendar_days' },
      statutory[0]!.id)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 25 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    return runId
  })

  draftRunId = await withTenant(tenantId, (tx) =>
    createRun(tx, { periodId: setup.nextPeriodId, processedByUserId: PROCESSOR }))

  const login = async (email: string): Promise<string> => {
    const r = await api<{ token: string }>('POST', '/api/v1/auth/login', {
      body: { email, password: PASSWORD },
    })
    if (!r.body.token) throw new Error(`login failed for ${email}: ${JSON.stringify(r.body)}`)
    return r.body.token
  }
  financeToken = await login(financeEmail)
  employeeToken = await login(employeeEmail)
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await closePools()
  await controlDb.end()
})

describe('who may reach the bank file', () => {
  it('refuses an employee', async () => {
    const r = await api('POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
      token: employeeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
    })
    expect(r.status).toBe(403)
    expect(r.body.error?.code).toBe('PERMISSION_DENIED')
  })

  it('refuses an anonymous caller', async () => {
    const r = await api('POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
      body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
    })
    expect(r.status).toBe(401)
  })

  it('allows finance', async () => {
    const r = await api<{ batchId: string }>(
      'POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
        token: financeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
      })
    expect(r.status).toBe(200)
    expect(r.body.batchId).toBeTruthy()
  })
})

describe('the safety properties survive the transport', () => {
  it('produces the identical file when called again', async () => {
    const first = await api<{ batchId: string; checksum: string; content: string; reused: boolean }>(
      'POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
        token: financeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
      })
    const second = await api<{ batchId: string; checksum: string; content: string; reused: boolean }>(
      'POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
        token: financeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
      })

    expect(second.body.batchId).toBe(first.body.batchId)
    expect(second.body.checksum).toBe(first.body.checksum)
    expect(second.body.content).toBe(first.body.content)
    expect(second.body.reused).toBe(true)
  })

  it('refuses a run that is not locked', async () => {
    const r = await api('POST', `/api/v1/payroll/runs/${draftRunId}/bank-file`, {
      token: financeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
    })
    expect(r.status).toBe(409)
    expect(r.body.error?.code).toBe('RUN_NOT_LOCKED')
  })

  it('rejects a format it cannot write', async () => {
    const r = await api('POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
      token: financeToken, body: { format: 'sbi_quantum_ledger', valueDate: '2026-10-01' },
    })
    expect(r.status).toBe(422)
    expect(r.body.error?.code).toBe('VALIDATION_FAILED')
  })

  it('names the formats it can write', async () => {
    const r = await api<{ formats: string[] }>('GET', '/api/v1/payments/formats', {
      token: financeToken,
    })
    expect(r.status).toBe(200)
    expect(r.body.formats).toContain('hdfc_neft_csv')
  })
})

describe('the batch list', () => {
  it('shows what has been generated, and the file on request', async () => {
    await api('POST', `/api/v1/payroll/runs/${lockedRunId}/bank-file`, {
      token: financeToken, body: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' },
    })

    const list = await api<{ batches: { id: string; instruction_count: number }[] }>(
      'GET', '/api/v1/payments/batches', { token: financeToken })
    expect(list.status).toBe(200)
    expect(list.body.batches.length).toBeGreaterThan(0)

    const one = await api<{ file_content: string }>(
      'GET', `/api/v1/payments/batches/${list.body.batches[0]!.id}`, { token: financeToken })
    expect(one.status).toBe(200)
    expect(one.body.file_content).toContain('HDFC0000123')
  })

  it('does not show batches to an employee', async () => {
    const r = await api('GET', '/api/v1/payments/batches', { token: employeeToken })
    expect(r.status).toBe(403)
  })
})
