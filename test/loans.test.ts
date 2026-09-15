/**
 * Loans: the schedule is equal rupee instalments with the remainder last;
 * each freeze takes one instalment and records it; unfreeze gives it back;
 * the balance is a sum over facts; the final run takes everything; lock
 * settles a cleared loan.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, unfreezeInputs, validate } from '../src/payroll/run.ts'
import { closeLoan, grantLoan, listLoans, repayManually, schedule } from '../src/payroll/loans.ts'
import { initiateSeparation } from '../src/payroll/exit.ts'
import { changeCompensation } from '../src/people/history.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
let A: Tenant
let statutoryId: string
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}
const ROW = { employeeId: '', calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { basic: L(30_000) }, annualCtcPaise: L(360_000), stateCode: 'TS', pfApplicable: true }

beforeAll(async () => {
  A = (await resetAndSeed()).a
  ROW.employeeId = A.employeeId
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    await tx.query(`UPDATE employees SET date_of_joining = DATE '2020-01-01' WHERE id = $1`, [A.employeeId])
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(360_000), components: { basic: L(30_000) }, effectiveFrom: '2026-01-01' })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

const period = (label: string, start: string, end: string) => withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
  `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id)

describe('schedule', () => {
  it('equal rupee instalments, interest simple over the term', () => {
    expect(schedule(L(50_000), 0, 5)).toEqual({ totalPaise: L(50_000), instalmentPaise: L(10_000) })
    expect(schedule(L(50_000), 0, 3)).toEqual({ totalPaise: L(50_000), instalmentPaise: L(16_667) })    // ceil; the last takes the remainder
    // 1L at 12% over 12 months = 12,000 interest
    expect(schedule(L(100_000), 12, 12)).toEqual({ totalPaise: L(112_000), instalmentPaise: L(9_334) })
  })
})

describe('recovery through payroll', () => {
  it('takes one instalment per freeze, releases on unfreeze, settles on the last, and shows a live balance', async () => {
    const dec = await period('2026-12', '2026-12-01', '2026-12-31')
    const jan = await period('2027-01', '2027-01-01', '2027-01-31')
    const feb = await period('2027-02', '2027-02-01', '2027-02-28')
    const loan = await withTenant(A.id, (tx) => grantLoan(tx, { employeeId: A.employeeId, kind: 'advance', principalPaise: L(25_000), instalments: 3, startsOn: '2026-12-01' }))
    expect(loan.instalment_paise).toBe(String(L(8_334)))
    await expect(withTenant(A.id, (tx) => grantLoan(tx, { employeeId: A.employeeId, kind: 'advance', principalPaise: L(1), instalments: 24, startsOn: '2026-12-01' })))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

    const runFor = async (periodId: string) => withTenant(A.id, async (tx) => {
      const id = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, id, [ROW], {}, statutoryId)
      return id
    })
    const adhocOf = (runId: string) => withTenant(A.id, async (tx) =>
      (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [runId])).rows[0]!.adhoc)
    const finish = (runId: string) => withTenant(A.id, async (tx) => {
      await calculate(tx, runId, OPTS); await validate(tx, runId, { ...OPTS, variancePct: 1000 })
      await approve(tx, runId, APPROVER, { requireSeparateApprover: true }); await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    })

    const r1 = await runFor(dec)
    expect(await adhocOf(r1)).toEqual([{ code: 'LOAN_EMI', amountPaise: L(8_334), type: 'deduction' }])
    let [v] = await withTenant(A.id, (tx) => listLoans(tx, A.employeeId))
    expect(v!.balance_paise).toBe(L(25_000) - L(8_334))
    // unfreeze: the instalment comes back
    await withTenant(A.id, (tx) => unfreezeInputs(tx, r1))
    ;[v] = await withTenant(A.id, (tx) => listLoans(tx, A.employeeId))
    expect(v!.balance_paise).toBe(L(25_000))
    await withTenant(A.id, (tx) => freezeInputs(tx, r1, [ROW], {}, statutoryId))
    await finish(r1)
    // the payslip shows the deduction
    const line = await withTenant(A.id, async (tx) => (await tx.query<{ amount_paise: string; component_type: string }>(
      `SELECT amount_paise::text, component_type FROM payroll_lines WHERE run_id = $1 AND component_code = 'LOAN_EMI'`, [r1])).rows[0]!)
    expect(line).toEqual({ amount_paise: String(L(8_334)), component_type: 'deduction' })

    const r2 = await runFor(jan); await finish(r2)
    // a manual repayment in between shortens the tail
    await withTenant(A.id, (tx) => repayManually(tx, loan.id, L(2_000), 'cash'))
    const r3 = await runFor(feb)
    // balance before Feb: 25,000 − 8,334 − 8,334 − 2,000 = 6,332 < instalment → takes the balance
    expect(await adhocOf(r3)).toEqual([{ code: 'LOAN_EMI', amountPaise: L(6_332), type: 'deduction' }])
    ;[v] = await withTenant(A.id, (tx) => listLoans(tx, A.employeeId))
    expect(v!.status).toBe('active')                       // settled at LOCK, not freeze
    await finish(r3)
    const closed = await withTenant(A.id, (tx) => listLoans(tx, A.employeeId, true))
    expect(closed[0]).toMatchObject({ status: 'settled', balance_paise: 0, repaid_paise: L(25_000), instalments_taken: 4 })
    // nothing more is taken
    const mar = await period('2027-03', '2027-03-01', '2027-03-31')
    expect(await adhocOf(await runFor(mar))).toEqual([])
  })

  it('the final run at exit recovers the whole balance; a written-off loan takes nothing', async () => {
    const may = await period('2027-05', '2027-05-01', '2027-05-31')
    await withTenant(A.id, async (tx) => {
      const big = await grantLoan(tx, { employeeId: A.employeeId, kind: 'loan', principalPaise: L(120_000), instalments: 24, startsOn: '2027-05-01' })
      const gone = await grantLoan(tx, { employeeId: A.employeeId, kind: 'loan', principalPaise: L(9_000), instalments: 9, startsOn: '2027-05-01' })
      await closeLoan(tx, gone.id, 'written_off', 'hardship, approved')
      await initiateSeparation(tx, { employeeId: A.employeeId, reason: 'resignation', initiatedOn: '2027-03-01', lastWorkingDay: '2027-05-20', actorUserId: PROCESSOR })
      const id = await createRun(tx, { periodId: may, processedByUserId: PROCESSOR })
      await freezeInputs(tx, id, [{ ...ROW, calendarDays: 31, payableDays: 20 }], {}, statutoryId)
      const adhoc = (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [id])).rows[0]!.adhoc
      const settlement = adhoc.find((a) => a.code === 'LOAN_SETTLEMENT')
      expect(settlement).toEqual({ code: 'LOAN_SETTLEMENT', amountPaise: L(120_000), type: 'deduction' })
      expect(adhoc.some((a) => a.code === 'LOAN_EMI')).toBe(false)
      void big
    })
  })
})
