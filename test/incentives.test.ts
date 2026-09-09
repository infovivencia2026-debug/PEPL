import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  achievement, approvePeriod, calculatePeriod, clawback, closePeriod,
  computeIncentive, pushToPayroll, IncentiveError,
} from '../src/work/incentives.ts'
import { createRun, freezeInputs } from '../src/payroll/run.ts'

let A: Tenant
let B: Tenant
let planId: string
let sepPeriod: string
let octPeriod: string
let payrollPeriodId: string

const APPROVER = 'c0000000-0000-0000-0000-00000000000c'
const L = (rupees: number): number => rupees * 100

const SLABS = {
  slabs: [
    { fromPct: 0, toPct: 80 },
    { fromPct: 80, toPct: 100, ratePct: 0.01 },
    { fromPct: 100, toPct: 120, ratePct: 0.02 },
    { fromPct: 120, ratePct: 0.03 },
  ],
  floorAchievementPct: 80,
}

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b

  const ids = await withTenant(A.id, async (tx) => {
    const plan = (await tx.query<{ id: string }>(
      `INSERT INTO incentive_plans (tenant_id, name, calc_type, config, effective_from)
       VALUES ($1, 'Sales slab', 'slab', $2::jsonb, DATE '2026-01-01') RETURNING id`,
      [A.id, JSON.stringify(SLABS)],
    )).rows[0]!.id

    const mkPeriod = async (label: string, start: string, end: string): Promise<string> =>
      (await tx.query<{ id: string }>(
        `INSERT INTO incentive_periods (tenant_id, label, period_start, period_end)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [A.id, label, start, end],
      )).rows[0]!.id

    const sep = await mkPeriod('2026-09', '2026-09-01', '2026-09-30')
    const oct = await mkPeriod('2026-10', '2026-10-01', '2026-10-31')

    await tx.query(
      `INSERT INTO incentive_targets (tenant_id, employee_id, plan_id, period_id, target_value)
       VALUES ($1,$2,$3,$4,$5)`,
      [A.id, A.employeeId, plan, sep, 1_000_000],
    )

    const pp = (await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01') RETURNING id`,
      [A.id],
    )).rows[0]!.id

    return { plan, sep, oct, pp }
  })
  planId = ids.plan
  sepPeriod = ids.sep
  octPeriod = ids.oct
  payrollPeriodId = ids.pp
})

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const addSale = (periodId: string, valueRupees: number, ref?: string) =>
  withTenant(A.id, async (tx) =>
    tx.query(
      `INSERT INTO sales_records (tenant_id, employee_id, period_id, occurred_on, value_paise, source, external_ref)
       VALUES ($1,$2,$3,DATE '2026-09-15',$4,'import',$5)
       ON CONFLICT (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
      [A.id, A.employeeId, periodId, L(valueRupees), ref ?? null],
    ),
  )

const calcRow = () =>
  withTenant(A.id, async (tx) =>
    (await tx.query(
      `SELECT achievement_pct::float8 AS pct, gross_incentive_paise::text AS gross,
              final_incentive_paise::text AS final, status, calc_trace
         FROM incentive_calculations WHERE period_id = $1`,
      [sepPeriod],
    )).rows[0],
  )

describe('the slab engine, and why calc_trace exists', () => {
  it('pays nothing below the floor', () => {
    const r = computeIncentive({ calcType: 'slab', config: SLABS, targetValue: 1_000_000, achievedValue: 700_000 })
    expect(r.grossIncentivePaise).toBe(0n)
    expect(r.trace.reason).toMatch(/below the 80% floor/)
  })

  it('picks the slab the achievement falls in and records it', () => {
    const r = computeIncentive({ calcType: 'slab', config: SLABS, targetValue: 1_000_000, achievedValue: 1_100_000 })
    expect(r.achievementPct).toBe(110)
    // 110% falls in the 100-120 band at 2% of achieved value
    expect(Number(r.grossIncentivePaise)).toBe(L(22_000))
    expect(r.trace.slab).toMatchObject({ fromPct: 100, toPct: 120, ratePct: 0.02 })
  })

  it('applies the boundary slab exactly at 100%', () => {
    const r = computeIncentive({ calcType: 'slab', config: SLABS, targetValue: 1_000_000, achievedValue: 1_000_000 })
    expect(Number(r.grossIncentivePaise)).toBe(L(20_000))
  })

  it('prorates for a partial month', () => {
    const r = computeIncentive({
      calcType: 'slab', config: SLABS, targetValue: 1_000_000, achievedValue: 1_100_000,
      prorationFactor: 0.5,
    })
    expect(Number(r.grossIncentivePaise)).toBe(L(11_000))
  })

  it('caps a payout and records what it would have been', () => {
    const r = computeIncentive({
      calcType: 'slab',
      config: { ...SLABS, capPaise: L(15_000) },
      targetValue: 1_000_000, achievedValue: 1_100_000,
    })
    expect(Number(r.grossIncentivePaise)).toBe(L(15_000))
    expect(r.trace.capped).toMatchObject({ at: L(15_000) })
  })

  it('supports the other calc types', () => {
    expect(Number(computeIncentive({
      calcType: 'percent_of_metric', config: { ratePct: 0.05 },
      targetValue: 100, achievedValue: 200_000,
    }).grossIncentivePaise)).toBe(L(10_000))

    expect(Number(computeIncentive({
      calcType: 'flat_on_target', config: { flatPaise: L(5_000) },
      targetValue: 100, achievedValue: 100,
    }).grossIncentivePaise)).toBe(L(5_000))

    expect(Number(computeIncentive({
      calcType: 'flat_on_target', config: { flatPaise: L(5_000) },
      targetValue: 100, achievedValue: 99,
    }).grossIncentivePaise)).toBe(0)

    expect(Number(computeIncentive({
      calcType: 'per_unit', config: { perUnitPaise: L(50) },
      targetValue: 10, achievedValue: 12,
    }).grossIncentivePaise)).toBe(L(600))
  })
})

describe('achievement is derived and re-runnable', () => {
  it('sums non-reversed sales', async () => {
    await addSale(sepPeriod, 600_000, 'inv-1')
    await addSale(sepPeriod, 500_000, 'inv-2')
    expect(await withTenant(A.id, (tx) => achievement(tx, sepPeriod, A.employeeId))).toBe(1_100_000)
  })

  it('a re-run of the same import does not double-count', async () => {
    await addSale(sepPeriod, 600_000, 'inv-1')
    await addSale(sepPeriod, 600_000, 'inv-1')
    expect(await withTenant(A.id, (tx) => achievement(tx, sepPeriod, A.employeeId))).toBe(600_000)
  })

  it('excludes a reversed sale', async () => {
    await addSale(sepPeriod, 600_000, 'inv-1')
    await addSale(sepPeriod, 500_000, 'inv-2')
    await withTenant(A.id, async (tx) =>
      tx.query(`UPDATE sales_records SET is_reversed = true WHERE external_ref = 'inv-2'`),
    )
    expect(await withTenant(A.id, (tx) => achievement(tx, sepPeriod, A.employeeId))).toBe(600_000)
  })
})

describe('the period must be closed before calculation', () => {
  it('refuses to calculate an open period', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    const err = await withTenant(A.id, async (tx) =>
      calculatePeriod(tx, sepPeriod).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(IncentiveError)
    expect((err as IncentiveError).code).toBe('PERIOD_OPEN')
  })

  it('calculates once closed, storing the trace', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    await withTenant(A.id, async (tx) => {
      await closePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
    })
    const row = await calcRow()
    expect(row.pct).toBe(110)
    expect(Number(row.gross)).toBe(L(22_000))
    expect(row.calc_trace.slab).toMatchObject({ ratePct: 0.02 })
  })

  it('recalculating is idempotent', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    await withTenant(A.id, async (tx) => {
      await closePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
    })
    const n = await withTenant(A.id, async (tx) =>
      Number((await tx.query('SELECT count(*)::int AS n FROM incentive_calculations')).rows[0].n),
    )
    expect(n).toBe(1)
  })
})

describe('pushing to payroll respects the freeze boundary', () => {
  async function approvedSep(): Promise<void> {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    await withTenant(A.id, async (tx) => {
      await closePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
      await approvePeriod(tx, sepPeriod, APPROVER)
    })
  }

  it('pushes into a draft run', async () => {
    await approvedSep()
    const result = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId: payrollPeriodId, processedByUserId: APPROVER })
      return pushToPayroll(tx, sepPeriod, runId)
    })
    expect(result.pushed).toBe(1)
    expect((await calcRow()).status).toBe('pushed')
  })

  it('refuses a run whose inputs are already frozen', async () => {
    await approvedSep()
    const err = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId: payrollPeriodId, processedByUserId: APPROVER })
      await freezeInputs(tx, runId, [{
        employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0,
        monthlyComponents: { basic: L(20_000) }, annualCtcPaise: L(240_000), stateCode: 'TS',
      }], {}, null as unknown as string)
      return pushToPayroll(tx, sepPeriod, runId).catch((e: unknown) => e)
    })
    expect(err).toBeInstanceOf(IncentiveError)
    expect((err as IncentiveError).code).toBe('RUN_NOT_DRAFT')
    expect((err as IncentiveError).message).toMatch(/next period as an arrear/)
  })

  it('does not push an unapproved calculation', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    await withTenant(A.id, async (tx) => {
      await closePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
    })
    const result = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId: payrollPeriodId, processedByUserId: APPROVER })
      return pushToPayroll(tx, sepPeriod, runId)
    })
    expect(result.pushed).toBe(0)
  })
})

describe('clawback is a next-period adjustment, never a retroactive edit', () => {
  it('leaves the paid period untouched and debits the next one', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    await withTenant(A.id, async (tx) => {
      await closePeriod(tx, sepPeriod)
      await calculatePeriod(tx, sepPeriod)
      await approvePeriod(tx, sepPeriod, APPROVER)
      const runId = await createRun(tx, { periodId: payrollPeriodId, processedByUserId: APPROVER })
      await pushToPayroll(tx, sepPeriod, runId)

      await clawback(tx, {
        employeeId: A.employeeId, planId, nextPeriodId: octPeriod,
        amountPaise: L(6_000), note: 'invoice inv-1 cancelled by the customer',
      })
    })

    // September, already paid, is unchanged.
    expect(Number((await calcRow()).final)).toBe(L(22_000))

    const oct = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT final_incentive_paise::text AS final, calc_trace FROM incentive_calculations WHERE period_id = $1`,
        [octPeriod],
      )).rows[0],
    )
    expect(Number(oct.final)).toBe(-L(6_000))
    expect(oct.calc_trace.clawback).toMatch(/cancelled by the customer/)
  })

  it('rejects a non-positive clawback', async () => {
    await expect(
      withTenant(A.id, (tx) =>
        clawback(tx, { employeeId: A.employeeId, planId, nextPeriodId: octPeriod, amountPaise: 0, note: 'x' }),
      ),
    ).rejects.toThrow(/must be positive/)
  })
})

describe('incentives stay tenant-isolated', () => {
  it('another company sees no plans, sales or calculations', async () => {
    await addSale(sepPeriod, 1_100_000, 'inv-1')
    const counts = await withTenant(B.id, async (tx) => ({
      plans: (await tx.query('SELECT * FROM incentive_plans')).rows.length,
      sales: (await tx.query('SELECT * FROM sales_records')).rows.length,
      calcs: (await tx.query('SELECT * FROM incentive_calculations')).rows.length,
    }))
    expect(counts).toEqual({ plans: 0, sales: 0, calcs: 0 })
  })
})
