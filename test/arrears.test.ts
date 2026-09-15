/**
 * Arrears: a hike dated into paid months is paid as one ARREARS line on the
 * next freeze, prorated by the days each month actually paid, once — and
 * unfreezing gives it back so a refreeze pays it again, not twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, unfreezeInputs, validate } from '../src/payroll/run.ts'
import { arrearsOwed } from '../src/payroll/arrears.ts'
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

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  await withTenant(A.id, (tx) => changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(480_000), components: { basic: L(20_000), hra: L(8_000), special: L(12_000) }, effectiveFrom: '2026-04-01' }))
})
afterAll(async () => { await closePools(); await controlPool.end() })

const period = (label: string, start: string, end: string) => withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
  `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id)

const row = (comp: Record<string, number>, days: { calendar: number; payable: number; lop: number }) => ({
  employeeId: A.employeeId, calendarDays: days.calendar, payableDays: days.payable, lopDays: days.lop,
  monthlyComponents: comp, annualCtcPaise: L(480_000), stateCode: 'TS', pfApplicable: true,
})

async function lockRun(periodId: string, r: ReturnType<typeof row>): Promise<string> {
  return withTenant(A.id, async (tx) => {
    const id = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, id, [r], {}, statutoryId)
    await calculate(tx, id, OPTS); await validate(tx, id, { ...OPTS, variancePct: 1000 })
    await approve(tx, id, APPROVER, { requireSeparateApprover: true }); await lock(tx, id, APPROVER, { requireSeparateApprover: true })
    return id
  })
}

describe('arrears', () => {
  it('a hike dated into two paid months is paid once, prorated, on the next freeze; unfreeze releases it', async () => {
    const old = { basic: L(20_000), hra: L(8_000), special: L(12_000) }        // 40,000
    const jul = await period('2026-07', '2026-07-01', '2026-07-31')
    const aug = await period('2026-08', '2026-08-01', '2026-08-31')
    const sep = await period('2026-09', '2026-09-01', '2026-09-30')
    await lockRun(jul, row(old, { calendar: 31, payable: 31, lop: 0 }))
    await lockRun(aug, row(old, { calendar: 31, payable: 25, lop: 6 }))       // some LOP in August

    // nothing owed yet
    expect(await withTenant(A.id, (tx) => arrearsOwed(tx, A.employeeId, '2026-09-01'))).toEqual([])

    // a hike to 50,000 effective 1 July, recorded in September
    await withTenant(A.id, (tx) => changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000),
      components: { basic: L(25_000), hra: L(10_000), special: L(15_000) }, effectiveFrom: '2026-07-01', reason: 'promotion, backdated' }))
    const owed = await withTenant(A.id, (tx) => arrearsOwed(tx, A.employeeId, '2026-09-01'))
    expect(owed.map((o) => [o.periodLabel, o.amountPaise])).toEqual([
      ['2026-07', L(10_000)],                                    // full month
      ['2026-08', Math.round(L(10_000) * 25 / 31 / 100) * 100],  // 25 of 31 days paid
    ])

    // September freeze carries one ARREARS line for the sum
    const expected = L(10_000) + Math.round(L(10_000) * 25 / 31 / 100) * 100
    await withTenant(A.id, async (tx) => {
      const id = await createRun(tx, { periodId: sep, processedByUserId: PROCESSOR })
      await freezeInputs(tx, id, [row({ basic: L(25_000), hra: L(10_000), special: L(15_000) }, { calendar: 30, payable: 30, lop: 0 })], {}, statutoryId)
      const adhoc = (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [id])).rows[0]!.adhoc
      expect(adhoc).toEqual([{ code: 'ARREARS', amountPaise: expected }])
      expect(await arrearsOwed(tx, A.employeeId, '2026-09-01')).toEqual([])      // recorded as paid
      expect((await tx.query(`SELECT 1 FROM arrears_paid WHERE paid_in_run_id = $1`, [id])).rowCount).toBe(2)

      // unfreeze gives it back; refreeze pays it once more, not twice
      await unfreezeInputs(tx, id)
      expect((await arrearsOwed(tx, A.employeeId, '2026-09-01')).length).toBe(2)
      await freezeInputs(tx, id, [row({ basic: L(25_000), hra: L(10_000), special: L(15_000) }, { calendar: 30, payable: 30, lop: 0 })], {}, statutoryId)
      const again = (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [id])).rows[0]!.adhoc
      expect(again).toEqual([{ code: 'ARREARS', amountPaise: expected }])

      // and the payslip carries it as an earning
      await calculate(tx, id, OPTS)
      const line = (await tx.query<{ amount_paise: string; component_type: string }>(
        `SELECT amount_paise::text, component_type FROM payroll_lines WHERE run_id = $1 AND component_code = 'ARREARS'`, [id])).rows[0]!
      expect(line).toEqual({ amount_paise: String(expected), component_type: 'earning' })
    })
  })

  it('a backdated cut is recovered, not paid', async () => {
    const oct = await period('2026-10', '2026-10-01', '2026-10-31')
    const nov = await period('2026-11', '2026-11-01', '2026-11-30')
    const cur = { basic: L(25_000), hra: L(10_000), special: L(15_000) }
    await lockRun(oct, row(cur, { calendar: 31, payable: 31, lop: 0 }))
    await withTenant(A.id, (tx) => changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(540_000),
      components: { basic: L(25_000), hra: L(10_000), special: L(10_000) }, effectiveFrom: '2026-10-01', reason: 'allowance withdrawn' }))
    await withTenant(A.id, async (tx) => {
      const id = await createRun(tx, { periodId: nov, processedByUserId: PROCESSOR })
      await freezeInputs(tx, id, [row({ basic: L(25_000), hra: L(10_000), special: L(10_000) }, { calendar: 30, payable: 30, lop: 0 })], {}, statutoryId)
      const adhoc = (await tx.query<{ adhoc: unknown[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [id])).rows[0]!.adhoc
      expect(adhoc).toEqual([{ code: 'ARREARS_RECOVERY', amountPaise: L(5_000), type: 'deduction' }])
    })
  })
})
