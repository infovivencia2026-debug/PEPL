/**
 * A correction must pay the DIFFERENCE, and take a loan instalment once.
 *
 * A revision is a full recomputation of a locked run. Two things treated it as a
 * fresh month:
 *
 *  1. THE BANK FILE paid every employee's whole new net again. The original had
 *     already been paid, so correcting one person's allowance by Rs 5,000 would have
 *     re-transferred the entire payroll -- the double payment that bank-file.ts
 *     says is "not fully recoverable" and exists to prevent.
 *
 *  2. THE LOAN INSTALMENT was taken again for the revision run and recorded as a
 *     second repayment, so the balance fell by two instalments for one month and the
 *     loan settled a month early.
 *
 * Found by an audit; reproduced here first.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { generateBankFile } from '../src/payments/bank-file.ts'
import { approve, calculate, createRun, freezeInputs, lock, revise, validate, type FreezeRow } from '../src/payroll/run.ts'
import { grantLoan, listLoans } from '../src/payroll/loans.ts'
import { buildJournal } from '../src/payroll/journal.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let A: Tenant
let periodId: string
let statutoryId: string

const PROCESSOR = 'a1000000-0000-0000-0000-0000000000a1'
const APPROVER = 'b1000000-0000-0000-0000-0000000000b1'
const L = (rupees: number): number => rupees * 100

const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}

beforeEach(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  periodId = await withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
     VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])).rows[0]!.id)
  await withTenant(A.id, (tx) => tx.query(
    `INSERT INTO employee_bank_accounts (tenant_id, employee_id, beneficiary_name, account_number, ifsc, bank_name)
     VALUES ($1,$2,'Rahul Sharma','50100123456789','HDFC0001234','HDFC Bank')`, [A.id, A.employeeId]))
})

afterAll(async () => { await closePools(); await controlPool.end() })

const row = (basic: number): FreezeRow => ({
  employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
  monthlyComponents: { basic: L(basic), hra: L(8_000) }, annualCtcPaise: L(336_000), stateCode: 'TS', pfApplicable: true,
})

/** Run a fresh run through to locked; `approver` must differ from `processor`. */
async function lockedRun(basic: number, opts: { revises?: string } = {}): Promise<string> {
  return withTenant(A.id, async (tx) => {
    const runId = opts.revises
      ? await revise(tx, opts.revises, { reason: 'allowance corrected', processedByUserId: PROCESSOR })
      : await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [row(basic)], {}, statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 90 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    return runId
  })
}

const netOf = (runId: string) => withTenant(A.id, async (tx) =>
  BigInt((await tx.query<{ n: string }>(`SELECT net_paise::text AS n FROM payslips WHERE run_id = $1`, [runId])).rows[0]!.n))

const file = (runId: string) => withTenant(A.id, (tx) =>
  generateBankFile(tx, { runId, format: 'generic_neft_csv', valueDate: '2026-10-01', generatedByUserId: PROCESSOR }))

describe('the bank file for a revision', () => {
  it('pays only the increase, not the whole net a second time', async () => {
    const original = await lockedRun(20_000)
    const first = await file(original)
    const oldNet = await netOf(original)
    expect(BigInt(first.totalPaise)).toBe(oldNet)

    const revised = await lockedRun(25_000, { revises: original })
    const newNet = await netOf(revised)
    expect(newNet).toBeGreaterThan(oldNet)

    const second = await file(revised)
    expect(BigInt(second.totalPaise)).toBe(newNet - oldNet)          // NOT newNet
    expect(second.lineCount).toBe(1)
    expect(second.content).toContain(`"${(Number(newNet - oldNet) / 100).toFixed(2)}"`)
  })

  it('labels the reference so the two transfers cannot be confused', async () => {
    const original = await lockedRun(20_000)
    await file(original)
    const revised = await lockedRun(25_000, { revises: original })
    expect((await file(revised)).content).toMatch(/SAL 2026-09 REV2 /)
  })

  it('a correction that lowers pay creates no payment (a recovery is not a transfer)', async () => {
    const original = await lockedRun(25_000)
    await file(original)
    const revised = await lockedRun(20_000, { revises: original })
    const second = await file(revised)
    expect(second.lineCount).toBe(0)
    expect(BigInt(second.totalPaise)).toBe(0n)
  })

  it('a correction that changes nothing pays nothing', async () => {
    const original = await lockedRun(20_000)
    await file(original)
    const revised = await lockedRun(20_000, { revises: original })
    expect((await file(revised)).lineCount).toBe(0)
  })

  it('is still idempotent: asking again returns the same file', async () => {
    const original = await lockedRun(20_000)
    await file(original)
    const revised = await lockedRun(25_000, { revises: original })
    const a = await file(revised)
    const b = await file(revised)
    expect(b.reused).toBe(true)
    expect(b.checksum).toBe(a.checksum)
  })

  it('the original run is unchanged: it still pays its full net', async () => {
    const original = await lockedRun(20_000)
    expect(BigInt((await file(original)).totalPaise)).toBe(await netOf(original))
  })
})

describe('a loan instalment in a revised month', () => {
  it('is deducted on the revised payslip and recorded ONCE', async () => {
    await withTenant(A.id, (tx) => grantLoan(tx, {
      employeeId: A.employeeId, kind: 'loan', principalPaise: L(12_000), instalments: 6, startsOn: '2026-09-01',
    }))
    const original = await lockedRun(20_000)
    const emi = await withTenant(A.id, async (tx) => (await listLoans(tx, A.employeeId))[0]!)
    expect(emi.instalments_taken).toBe(1)

    const revised = await lockedRun(25_000, { revises: original })
    const after = await withTenant(A.id, async (tx) => (await listLoans(tx, A.employeeId))[0]!)
    expect(after.instalments_taken).toBe(1)                         // was 2
    expect(after.balance_paise).toBe(emi.balance_paise)

    // ...and the revised payslip still carries the deduction, so pay is not overstated.
    const lines = await withTenant(A.id, async (tx) => (await tx.query<{ component_code: string; amount_paise: string }>(
      `SELECT component_code, amount_paise::text FROM payroll_lines WHERE run_id = $1 AND component_code = 'LOAN_EMI'`, [revised])).rows)
    expect(lines).toHaveLength(1)
    expect(BigInt(lines[0]!.amount_paise)).toBe(BigInt(L(2_000)))
  })
})

describe('the accounting journal for a revision', () => {
  const journal = (runId: string) => withTenant(A.id, (tx) => buildJournal(tx, runId))
  const wages = (j: Awaited<ReturnType<typeof journal>>) =>
    j.lines.filter((l) => l.account === 'Salaries & Wages').reduce((n, l) => n + l.debitPaise - l.creditPaise, 0n)

  it('books only the difference: the original month is already in the ledger', async () => {
    const original = await lockedRun(20_000)
    const revised = await lockedRun(25_000, { revises: original })
    const o = await journal(original)
    const r = await journal(revised)
    expect(o.balanced).toBe(true)
    expect(r.balanced).toBe(true)
    expect(wages(r)).toBe(BigInt(L(5_000)))            // was the whole revised gross again
    expect(wages(o)).toBe(BigInt(L(28_000)))           // the original is untouched
  })

  it('reverses when a correction lowers pay', async () => {
    const original = await lockedRun(25_000)
    const revised = await lockedRun(20_000, { revises: original })
    const r = await journal(revised)
    expect(r.balanced).toBe(true)
    expect(wages(r)).toBe(-BigInt(L(5_000)))
  })
})
