/**
 * TDS year-to-date: what was already earned and deducted in locked runs of the
 * same fiscal year is frozen into the next run, and the projection uses it —
 * so a mid-year hike is trued up over the months left rather than taxed as if
 * the new salary had been paid since April.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import {
  approve, calculate, createRun, freezeInputs, lock, revise, validate, yearToDate, type FreezeRow,
} from '../src/payroll/run.ts'
import { computeTds, monthsRemainingInFY, type TaxRules, type TaxSlab } from '../src/payroll/tds.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'

let A: Tenant
let statutoryId: string

const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: () => 0n,
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
  // A flat 10% "tax" on taxable gross so TDS lines exist and are easy to sum.
  computeTds: (a) => ({ monthlyTdsPaise: BigInt(Math.round(Number(a.monthlyTaxableGrossPaise) * 0.1 / 100) * 100), trace: {} }),
}

const row = (employeeId: string, basic: number): FreezeRow => ({
  employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
  monthlyComponents: { basic: L(basic) }, annualCtcPaise: L(basic * 12), stateCode: 'TS', pfApplicable: true,
})

async function period(tenantId: string, label: string, start: string, end: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [tenantId, label, start, end])
    return r.rows[0]!.id
  })
}

async function locked(tenantId: string, periodId: string, rows: FreezeRow[]): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, rows, {}, statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 1000 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    return runId
  })
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(L(15_000)), String(L(21_000))])
  statutoryId = rows[0]!.id
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('freeze carries the year to date', () => {
  it('sums LOCKED runs of the same fiscal year, excludes superseded ones, and takes months from the period', async () => {
    const apr = await period(A.id, '2026-04', '2026-04-01', '2026-04-30')
    const may = await period(A.id, '2026-05', '2026-05-01', '2026-05-31')
    const jun = await period(A.id, '2026-06', '2026-06-01', '2026-06-30')
    const marLastFy = await period(A.id, '2026-03', '2026-03-01', '2026-03-31')

    // Last fiscal year: must not count.
    await locked(A.id, marLastFy, [row(A.employeeId, 99_000)])
    // April: 50,000 basic. PF wage capped at 15,000 -> PF_EE 1,800. Taxable 48,200. TDS 4,820.
    await locked(A.id, apr, [row(A.employeeId, 50_000)])
    // May, then a revision of May that is ALSO locked: only the revision counts.
    const mayRun = await locked(A.id, may, [row(A.employeeId, 50_000)])
    await withTenant(A.id, async (tx) => {
      const rev = await revise(tx, mayRun, { reason: 'arrears', processedByUserId: PROCESSOR })
      await freezeInputs(tx, rev, [row(A.employeeId, 60_000)], {}, statutoryId)   // 58,200 taxable, TDS 5,820
      await calculate(tx, rev, OPTS)
      await validate(tx, rev, { ...OPTS, variancePct: 1000 })
      await approve(tx, rev, APPROVER, { requireSeparateApprover: true })
      await lock(tx, rev, APPROVER, { requireSeparateApprover: true })
    })

    const ytd = await withTenant(A.id, (tx) => yearToDate(tx, A.employeeId, new Date('2026-06-01')))
    expect(ytd).toEqual({
      taxablePaise: BigInt(L(48_200 + 58_200)),
      tdsPaise: BigInt(L(4_820 + 5_820)),
      runs: 2,
    })

    // June freeze writes those as values, with 10 months remaining (Jun..Mar).
    const seen: { earned: bigint; deducted: bigint; months: number }[] = []
    await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId: jun, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [row(A.employeeId, 60_000)], {}, statutoryId)
      const { rows } = await tx.query<{ t: string; d: string; m: number }>(
        `SELECT ytd_taxable_paise::text AS t, ytd_tds_paise::text AS d, months_remaining AS m
           FROM payroll_inputs WHERE run_id = $1`, [runId])
      expect(rows[0]).toEqual({ t: String(L(106_400)), d: String(L(10_640)), m: 10 })
      await calculate(tx, runId, {
        ...OPTS,
        computeTds: (a) => {
          seen.push({ earned: a.earnedToDatePaise, deducted: a.deductedToDatePaise, months: a.monthsRemaining })
          return { monthlyTdsPaise: 0n, trace: {} }
        },
      })
    })
    expect(seen).toEqual([{ earned: BigInt(L(106_400)), deducted: BigInt(L(10_640)), months: 10 }])
  })

  it('a caller-supplied figure wins (a corrected revision can override)', async () => {
    const jul = await period(A.id, '2026-07', '2026-07-01', '2026-07-31')
    await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId: jul, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [{ ...row(A.employeeId, 60_000), ytdTaxablePaise: L(1), ytdTdsPaise: L(2) }], {}, statutoryId)
      const { rows } = await tx.query<{ t: string; d: string }>(
        `SELECT ytd_taxable_paise::text AS t, ytd_tds_paise::text AS d FROM payroll_inputs WHERE run_id = $1`, [runId])
      expect(rows[0]).toEqual({ t: String(L(1)), d: String(L(2)) })
    })
  })
})

describe('the projection uses the year to date', () => {
  const slabs: TaxSlab[] = [
    { income_from_paise: '0', income_to_paise: String(L(300_000)), rate: '0' },
    { income_from_paise: String(L(300_000)), income_to_paise: null, rate: '0.1' },
  ]
  const rules: TaxRules = {
    standard_deduction_paise: '0', rebate_limit_paise: '0', rebate_max_paise: '0', cess_rate: '0', surcharge_bands: [],
  }

  it('months remaining come from the period, not the clock', () => {
    expect(monthsRemainingInFY(new Date('2026-04-15'))).toBe(12)
    expect(monthsRemainingInFY(new Date('2026-09-01'))).toBe(7)
    expect(monthsRemainingInFY(new Date('2027-03-31'))).toBe(1)
  })

  it('a hike in October is trued up over the six months left, not back-dated to April', () => {
    // Apr–Sep: 40,000/month = 2.4L earned; tax so far on a 4.8L projection = 18,000 -> 1,500/month deducted = 9,000.
    // Oct: 60,000/month. Real year: 2.4L + 3.6L = 6L. Tax 30,000. Remaining 21,000 over 6 months = 3,500.
    const r = computeTds({
      monthlyTaxableGrossPaise: BigInt(L(60_000)), monthsRemaining: 6, regime: 'new',
      earnedToDatePaise: BigInt(L(240_000)), deductedToDatePaise: BigInt(L(9_000)),
    }, slabs, rules)
    expect(r.projectedAnnualIncomePaise).toBe(BigInt(L(600_000)))
    expect(r.annualTaxPaise).toBe(BigInt(L(30_000)))
    expect(r.monthlyTdsPaise).toBe(BigInt(L(3_500)))

    // Without the year to date (the old behaviour) October would be taxed as 60k × 12.
    const naive = computeTds({ monthlyTaxableGrossPaise: BigInt(L(60_000)), monthsRemaining: 12, regime: 'new' }, slabs, rules)
    expect(naive.annualTaxPaise).toBe(BigInt(L(42_000)))
  })

  it('over-deduction earlier in the year means zero now, never a negative line', () => {
    const r = computeTds({
      monthlyTaxableGrossPaise: BigInt(L(10_000)), monthsRemaining: 2, regime: 'new',
      earnedToDatePaise: BigInt(L(200_000)), deductedToDatePaise: BigInt(L(50_000)),
    }, slabs, rules)
    expect(r.monthlyTdsPaise).toBe(0n)
  })
})
