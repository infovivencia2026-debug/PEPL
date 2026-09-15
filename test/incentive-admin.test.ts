/**
 * Incentive administration: plan configs are checked for the calc type,
 * versions never backdate into a calculated period, targets and sales only
 * land in an open period, and a plan built here pays out through the engine.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createPeriod, listPlans, listTargets, publishPlan, recordSales, retirePlan, setTargets, validatePlanConfig } from '../src/work/incentive-admin.ts'
import { calculatePeriod, closePeriod } from '../src/work/incentives.ts'

const L = (r: number): number => r * 100
let A: Tenant
beforeAll(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

describe('validatePlanConfig', () => {
  it('slabs must tile, rates are fractions, one of rate/flat per slab', () => {
    expect(() => validatePlanConfig('slab', { slabs: [] })).toThrow(/at least one/)
    expect(() => validatePlanConfig('slab', { slabs: [{ fromPct: 0, toPct: 80, ratePct: 0 }, { fromPct: 90, ratePct: 0.02 }] })).toThrow(/tile/)
    expect(() => validatePlanConfig('slab', { slabs: [{ fromPct: 0, ratePct: 2 }] })).toThrow(/fraction/)
    expect(() => validatePlanConfig('slab', { slabs: [{ fromPct: 0, ratePct: 0.02, flatPaise: 100 }] })).toThrow(/not both/)
    const ok = validatePlanConfig('slab', { slabs: [{ fromPct: 80, toPct: 100, ratePct: 0.02 }, { fromPct: 0, toPct: 80, ratePct: 0 }, { fromPct: 100, ratePct: 0.04 }], capPaise: L(50_000) })
    expect(ok.slabs!.map((s) => s.fromPct)).toEqual([0, 80, 100])        // sorted
    expect(ok.capPaise).toBe(L(50_000))
  })

  it('each calc type needs its own figure', () => {
    expect(() => validatePlanConfig('percent_of_metric', {})).toThrow(/ratePct/)
    expect(() => validatePlanConfig('flat_on_target', {})).toThrow(/flatPaise/)
    expect(() => validatePlanConfig('per_unit', { perUnitPaise: 1.5 })).toThrow(/perUnitPaise/)
    expect(() => validatePlanConfig('bogus' as never, {})).toThrow(/calcType/)
    expect(validatePlanConfig('percent_of_metric', { ratePct: 0.03 })).toEqual({ ratePct: 0.03 })
  })
})

describe('plans, periods, targets, sales — through to a payout', () => {
  it('versions a plan, refuses backdating, sets targets, records sales idempotently, calculates', async () => {
    await withTenant(A.id, async (tx) => {
      const v1 = await publishPlan(tx, { name: 'Field sales', calcType: 'slab', effectiveFrom: '2026-11-01',
        config: { slabs: [{ fromPct: 0, toPct: 80, ratePct: 0 }, { fromPct: 80, toPct: 100, ratePct: 0.02 }, { fromPct: 100, ratePct: 0.04 }] } }, { today: '2026-10-15' })
      expect(v1.version).toBe(1)
      await expect(publishPlan(tx, { name: 'Field sales', calcType: 'slab', effectiveFrom: '2026-10-01', config: { slabs: [{ fromPct: 0, ratePct: 0.01 }] } }, { today: '2026-10-15' }))
        .rejects.toMatchObject({ code: 'PLAN_NOT_BACKDATABLE' })
      const v2 = await publishPlan(tx, { name: 'Field sales', calcType: 'slab', effectiveFrom: '2027-01-01',
        config: { slabs: [{ fromPct: 0, ratePct: 0.01 }] } }, { today: '2026-10-15' })
      expect(v2.version).toBe(2)
      const all = await listPlans(tx, { includeClosed: true })
      expect(all.find((p) => p.version === 1)!.effective_to).toBe('2026-12-31')
      expect((await listPlans(tx, { asOf: '2026-11-15' })).map((p) => p.version)).toEqual([1])
      expect((await listPlans(tx, { asOf: '2027-02-01' })).map((p) => p.version)).toEqual([2])

      const period = await createPeriod(tx, { label: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30' })
      await expect(createPeriod(tx, { label: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30' })).rejects.toMatchObject({ code: 'PERIOD_EXISTS' })
      // v2 is not in force in November
      await expect(setTargets(tx, period.id, [{ employeeId: A.employeeId, planId: v2.id, targetValue: 100_000 }]))
        .rejects.toMatchObject({ code: 'PLAN_NOT_IN_FORCE' })
      expect(await setTargets(tx, period.id, [{ employeeId: A.employeeId, planId: v1.id, targetValue: 100_000 }])).toEqual({ set: 1 })
      // replaced, not duplicated
      await setTargets(tx, period.id, [{ employeeId: A.employeeId, planId: v1.id, targetValue: 200_000 }])
      const targets = await listTargets(tx, period.id)
      expect(targets).toHaveLength(1)
      expect(targets[0]!.target_value).toBe('200000.000')     // the metric's unit: rupees

      const sales = [
        { employeeId: A.employeeId, occurredOn: '2026-11-05', valuePaise: L(150_000), externalRef: 'INV-1' },
        { employeeId: A.employeeId, occurredOn: '2026-11-20', valuePaise: L(90_000), externalRef: 'INV-2' },
      ]
      expect(await recordSales(tx, period.id, sales, 'crm')).toEqual({ recorded: 2, duplicates: 0 })
      expect(await recordSales(tx, period.id, sales, 'crm')).toEqual({ recorded: 0, duplicates: 2 })
      await expect(recordSales(tx, period.id, [{ employeeId: A.employeeId, occurredOn: '2026-12-01', valuePaise: 1 }])).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      // close, calculate: ₹2.4L on ₹2L = 120% -> top slab 4% of 2.4L = ₹9,600
      await closePeriod(tx, period.id)
      await expect(recordSales(tx, period.id, [{ employeeId: A.employeeId, occurredOn: '2026-11-25', valuePaise: 1 }])).rejects.toMatchObject({ code: 'PERIOD_CLOSED' })
      await calculatePeriod(tx, period.id)
      const { rows } = await tx.query<{ final_incentive_paise: string; achieved_value: string }>(
        `SELECT final_incentive_paise::text, achieved_value::text FROM incentive_calculations WHERE period_id = $1`, [period.id])
      expect(rows[0]!.achieved_value).toBe('240000.000')
      expect(rows[0]!.final_incentive_paise).toBe(String(L(9_600)))

      // a version cannot start inside the calculated period
      await expect(publishPlan(tx, { name: 'Other', calcType: 'flat_on_target', effectiveFrom: '2026-11-15', config: { flatPaise: L(1) } }, { today: '2026-11-10' }))
        .rejects.toMatchObject({ code: 'PLAN_NOT_BACKDATABLE' })
      // retiring ends the open version
      const ended = await retirePlan(tx, 'Field sales', '2027-06-30')
      expect(ended).toMatchObject({ version: 2, effective_to: '2027-06-30' })
    })
  })
})
