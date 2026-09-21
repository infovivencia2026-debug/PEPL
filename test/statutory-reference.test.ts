/**
 * Statutory reference data ships with the product, not the demo: the seeder
 * loads PF/ESI and every fiscal year's tax tables idempotently, and a run in a
 * year with no tables is BLOCKED at validation instead of paying zero tax.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { seedTaxTables } from '../scripts/seed-statutory.ts'
import { INCOME_TAX } from '../db/reference/income-tax.ts'
import { loadStatutory } from '../src/payroll/statutory.ts'
import { calculate, createRun, freezeInputs, validate } from '../src/payroll/run.ts'
import { ensurePeriod } from '../src/payroll/periods.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

const L = (r: number): number => r * 100
let A: Tenant
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, tax_slabs, tax_rules CASCADE')
})
afterAll(async () => { await closePools(); await controlPool.end(); await controlDb.end() })

describe('reference data', () => {
  it('the seeder loads PF/ESI and every fiscal year, and running it twice changes nothing', async () => {
    const first = await seedTaxTables()
    expect(first.fiscalYears).toBe(INCOME_TAX.length)
    const count = async () => (await controlPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM tax_slabs`)).rows[0]!.n
    const before = await count()
    await seedTaxTables()
    expect(await count()).toBe(before)
    const cfg = await withTenant(A.id, (tx) => loadStatutory(tx, '2026-09-01'))
    expect(cfg.config.pf_employee_rate).toBe(0.12)
    expect(cfg.fiscalYear).toBe('2026-27')
    expect(cfg.taxSlabs.new.length).toBeGreaterThan(5)
    expect(cfg.taxRules.old).toBeTruthy()
  })

  it('a run in a fiscal year with no tables is blocked, not paid untaxed', async () => {
    await withTenant(A.id, async (tx) => {
      // a period far enough ahead that no reference year covers it
      const { payroll } = await ensurePeriod(tx, { month: '2031-05', payDay: 1 })
      const statutory = await loadStatutory(tx, '2031-05-01')
      expect(statutory.taxSlabs.new).toEqual([])
      const runId = await createRun(tx, { periodId: payroll.id, processedByUserId: '50000000-0000-0000-0000-000000000005' })
      await freezeInputs(tx, runId, [{
        employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0,
        monthlyComponents: { BASIC: L(200_000) }, annualCtcPaise: L(2_400_000), stateCode: 'TS', pfApplicable: true, taxRegime: 'new',
      }], {}, statutory.id)
      const opts: Omit<EngineOptions, 'statutory'> & { statutory: typeof statutory.config } = {
        statutory: statutory.config, ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
      }
      await calculate(tx, runId, opts)
      const withCheck = await validate(tx, runId, { ...opts, variancePct: 1000,
        taxTables: { fiscalYear: statutory.fiscalYear, regimes: { new: statutory.taxSlabs.new.length > 0, old: statutory.taxSlabs.old.length > 0 } } })
      expect(withCheck.blockers.map((b) => b.code)).toContain('NO_TAX_SLABS')
      const { rows } = await tx.query<{ status: string }>(`SELECT status::text FROM payroll_runs WHERE id = $1`, [runId])
      expect(rows[0]!.status).toBe('calculated')             // did not advance

      // the same run in a covered year validates clean
      const covered = await loadStatutory(tx, '2026-09-01')
      const ok = await validate(tx, runId, { ...opts, variancePct: 1000,
        taxTables: { fiscalYear: covered.fiscalYear, regimes: { new: covered.taxSlabs.new.length > 0, old: covered.taxSlabs.old.length > 0 } } })
      expect(ok.blockers).toEqual([])
    })
  })
})
