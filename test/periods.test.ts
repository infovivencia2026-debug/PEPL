/**
 * A fresh company can create the calendar payroll runs on — and the job does
 * it for them before the month arrives. Nothing here depends on the demo seed.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { ensurePeriod, listPayrollPeriods, updatePayDate, deletePeriod, monthBounds, payDateFor, upcomingMonth } from '../src/payroll/periods.ts'
import { runPeriodRollForward } from '../src/jobs/index.ts'
import { createRun } from '../src/payroll/run.ts'

let A: Tenant
beforeAll(async () => {
  A = (await resetAndSeed()).a
  // the job only rolls periods for tenants whose plan sells payroll
  await controlPool.query(
    `INSERT INTO tenant_entitlements (tenant_id, plan_code, features, limits)
     VALUES ($1, 'test', '{"payroll":true}'::jsonb, '{"employees": 100}'::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features`, [A.id])
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('month arithmetic', () => {
  it('bounds, pay dates and the upcoming month', () => {
    expect(monthBounds('2026-02')).toEqual({ start: '2026-02-01', end: '2026-02-28', label: '2026-02' })
    expect(monthBounds('2028-02').end).toBe('2028-02-29')
    expect(() => monthBounds('2026-13')).toThrow()
    expect(payDateFor('2026-12', 1)).toBe('2027-01-01')
    expect(payDateFor('2026-01', 31)).toBe('2026-02-28')      // clamped to the next month's length
    expect(payDateFor('2026-03', 0)).toBe('2026-03-31')
    expect(upcomingMonth(new Date('2026-10-25T00:00:00Z'), 7)).toBe('2026-11')
    expect(upcomingMonth(new Date('2026-10-20T00:00:00Z'), 7)).toBe('2026-10')
  })
})

describe('periods', () => {
  it('creates payroll + attendance periods once, lists them with their run, moves the pay date, and refuses to delete a used one', async () => {
    await withTenant(A.id, async (tx) => {
      const first = await ensurePeriod(tx, { month: '2026-11', payDay: 1 })
      expect(first.created).toBe(true)
      expect(first.payroll).toMatchObject({ label: '2026-11', period_start: '2026-11-01', period_end: '2026-11-30', pay_date: '2026-12-01' })
      expect(first.attendance).toMatchObject({ period_start: '2026-11-01', period_end: '2026-11-30', status: 'open' })

      const again = await ensurePeriod(tx, { month: '2026-11', payDay: 7 })
      expect(again.created).toBe(false)
      expect(again.payroll.id).toBe(first.payroll.id)                 // idempotent, pay date untouched
      expect(again.payroll.pay_date).toBe('2026-12-01')

      await expect(ensurePeriod(tx, { month: '2026-12', payDay: 1, payDate: '2026-12-15' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      const moved = await updatePayDate(tx, first.payroll.id, '2026-12-03')
      expect(moved.pay_date).toBe('2026-12-03')

      const runId = await createRun(tx, { periodId: first.payroll.id, processedByUserId: '50000000-0000-0000-0000-000000000005' })
      const listed = await listPayrollPeriods(tx)
      expect(listed.find((p) => p.id === first.payroll.id)).toMatchObject({ run_id: runId, run_status: 'draft' })
      await expect(deletePeriod(tx, first.payroll.id)).rejects.toMatchObject({ code: 'PERIOD_IN_USE' })

      const spare = await ensurePeriod(tx, { month: '2027-01', payDay: 1 })
      await deletePeriod(tx, spare.payroll.id)
      expect((await listPayrollPeriods(tx)).some((p) => p.label === '2027-01')).toBe(false)
    })
  })

  it('the job creates this month and next month for every tenant, and is idempotent', async () => {
    const now = new Date('2026-10-26T03:00:00Z')
    const r1 = await runPeriodRollForward(now)
    expect(r1.errors).toEqual([])
    expect(r1.affected).toBeGreaterThanOrEqual(1)          // 2026-11 already exists from the test above; 2026-10 is new
    await withTenant(A.id, async (tx) => {
      const labels = (await listPayrollPeriods(tx)).map((p) => p.label)
      expect(labels).toContain('2026-10')
      expect(labels).toContain('2026-11')
    })
    const r2 = await runPeriodRollForward(now)
    expect(r2.errors).toEqual([])
    expect(r2.affected).toBe(0)
  })
})
