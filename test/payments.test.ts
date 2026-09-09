import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { generateBankFile, renderBankFile, PaymentError, type Instruction } from '../src/payments/bank-file.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let A: Tenant
let B: Tenant
let periodId: string
let statutoryId: string

const PROCESSOR = 'a1000000-0000-0000-0000-0000000000a1'
const APPROVER = 'b1000000-0000-0000-0000-0000000000b1'
const L = (rupees: number): number => rupees * 100

const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12,
    pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325,
    esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: () => 0n,
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await controlPool.query('TRUNCATE statutory_configs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(L(15_000)), String(L(21_000))])
  statutoryId = rows[0]!.id

  periodId = await withTenant(A.id, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01')
       RETURNING id`, [A.id])
    return r.rows[0]!.id
  })
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const addBank = (tenant: Tenant, employeeId: string) =>
  withTenant(tenant.id, async (tx) =>
    tx.query(
      `INSERT INTO employee_bank_accounts
         (tenant_id, employee_id, beneficiary_name, account_number, ifsc, bank_name)
       VALUES ($1,$2,'Rahul Sharma','50100123456789','HDFC0001234','HDFC Bank')`,
      [tenant.id, employeeId]))

async function lockedRun(tenant: Tenant): Promise<string> {
  return withTenant(tenant.id, async (tx) => {
    const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [{
      employeeId: tenant.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
      monthlyComponents: { basic: L(20_000), hra: L(8_000) },
      annualCtcPaise: L(336_000), stateCode: 'TS',
    }], {}, statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 25 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    return runId
  })
}

const SAMPLE: Instruction[] = [
  {
    employeeId: 'x', employeeNumber: 'A-001', beneficiaryName: 'Rahul Sharma',
    accountNumber: '50100123456789', ifsc: 'HDFC0001234',
    amountPaise: BigInt(L(24_500)), reference: 'SAL 2026-09 A-001',
  },
]

describe('file rendering', () => {
  it('writes rupees with two decimals, not paise', () => {
    const f = renderBankFile(SAMPLE, 'generic_neft_csv', '2026-10-01')
    expect(f.content).toContain('"24500.00"')
    expect(f.content).not.toContain('2450000')
  })

  it('supports each bank template with its own column order', () => {
    const hdfc = renderBankFile(SAMPLE, 'hdfc_neft_csv', '2026-10-01')
    const icici = renderBankFile(SAMPLE, 'icici_csv', '2026-10-01')
    expect(hdfc.content.split('\r\n')[0]).toContain('Transaction Type')
    expect(icici.content.split('\r\n')[0]).toContain('PYMT_MODE')
    expect(hdfc.checksum).not.toBe(icici.checksum)
  })

  it('neutralises a CSV injection attempt in a beneficiary name', () => {
    const f = renderBankFile(
      [{ ...SAMPLE[0]!, beneficiaryName: '=cmd|calc' }],
      'generic_neft_csv', '2026-10-01')
    expect(f.content).toContain(`"'=cmd|calc"`)
  })

  it('reports the row count and total so a bank dispute is answerable', () => {
    const f = renderBankFile(
      [SAMPLE[0]!, { ...SAMPLE[0]!, amountPaise: BigInt(L(10_000)) }],
      'generic_neft_csv', '2026-10-01')
    expect(f.lineCount).toBe(2)
    expect(f.totalPaise).toBe(BigInt(L(34_500)))
  })

  it('refuses an unknown format', () => {
    expect(() => renderBankFile(SAMPLE, 'nope' as never, '2026-10-01'))
      .toThrow(/no bank file format/)
  })
})

describe('a batch can only come from a locked run', () => {
  it('refuses a draft run', async () => {
    await addBank(A, A.employeeId)
    const err = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      return generateBankFile(tx, {
        runId, format: 'generic_neft_csv', valueDate: '2026-10-01',
        generatedByUserId: APPROVER,
      }).catch((e: unknown) => e)
    })
    expect(err).toBeInstanceOf(PaymentError)
    expect((err as PaymentError).code).toBe('RUN_NOT_LOCKED')
  })

  it('generates from a locked run', async () => {
    await addBank(A, A.employeeId)
    const runId = await lockedRun(A)
    const file = await withTenant(A.id, (tx) =>
      generateBankFile(tx, {
        runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01',
        generatedByUserId: APPROVER,
      }))
    expect(file.lineCount).toBe(1)
    expect(file.reused).toBe(false)
    expect(file.content).toContain('50100123456789')
  })
})

describe('double payment is structurally prevented', () => {
  it('generating twice returns the SAME file, byte for byte', async () => {
    await addBank(A, A.employeeId)
    const runId = await lockedRun(A)
    const first = await withTenant(A.id, (tx) =>
      generateBankFile(tx, { runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER }))
    const second = await withTenant(A.id, (tx) =>
      generateBankFile(tx, { runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER }))

    expect(second.reused).toBe(true)
    expect(second.batchId).toBe(first.batchId)
    expect(second.checksum).toBe(first.checksum)
    expect(second.content).toBe(first.content)
  })

  it('only one batch row exists however many times it is called', async () => {
    await addBank(A, A.employeeId)
    const runId = await lockedRun(A)
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 3; i++) {
        await generateBankFile(tx, { runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER })
      }
    })
    const n = await withTenant(A.id, async (tx) =>
      Number((await tx.query('SELECT count(*)::int AS n FROM payment_batches')).rows[0].n))
    expect(n).toBe(1)
  })

  it('a payment record cannot be deleted', async () => {
    await addBank(A, A.employeeId)
    const runId = await lockedRun(A)
    await withTenant(A.id, (tx) =>
      generateBankFile(tx, { runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER }))
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM payment_batches')),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('missing bank details stop the run, they do not silently skip someone', () => {
  it('names every employee without an account', async () => {
    const runId = await lockedRun(A)
    const err = await withTenant(A.id, async (tx) =>
      generateBankFile(tx, {
        runId, format: 'generic_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER,
      }).catch((e: unknown) => e))
    expect(err).toBeInstanceOf(PaymentError)
    expect((err as PaymentError).code).toBe('MISSING_BANK_DETAILS')
    expect((err as PaymentError).message).toContain('A-001')
  })
})

describe('payments stay tenant-isolated', () => {
  it('another company sees no batches or instructions', async () => {
    await addBank(A, A.employeeId)
    const runId = await lockedRun(A)
    await withTenant(A.id, (tx) =>
      generateBankFile(tx, { runId, format: 'hdfc_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER }))

    const counts = await withTenant(B.id, async (tx) => ({
      batches: (await tx.query('SELECT * FROM payment_batches')).rows.length,
      instructions: (await tx.query('SELECT * FROM payment_instructions')).rows.length,
      banks: (await tx.query('SELECT * FROM employee_bank_accounts')).rows.length,
    }))
    expect(counts).toEqual({ batches: 0, instructions: 0, banks: 0 })
  })
})
