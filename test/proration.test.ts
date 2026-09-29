/**
 * Proration.
 *
 * A customer who upgrades on the second day of a billing period used to get the
 * rest of that month on the old price — twenty-eight days of the better plan,
 * free, every time. The reverse is worse: a downgrade that took effect
 * immediately would hand back money for service already delivered.
 *
 * The policy this pins:
 *   - An UPGRADE is charged for the days remaining in the current period, at
 *     the difference between the two plans, invoiced at once.
 *   - A DOWNGRADE takes effect at the next period and raises nothing. No refund
 *     for service already given, and no credit note to chase.
 *   - Switching on the last day of a period charges nothing: there are no
 *     remaining days to charge for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { signup, switchPlan, listInvoices, prorationFor } from '../src/control-plane/billing.ts'

let tenantId: string
const stamp = Date.now()

beforeAll(async () => {
  const r = await signup({
    legalName: `ProrateCo ${stamp}`,
    adminEmail: `prorate-${stamp}@prorateco.test`,
    adminName: 'Test Admin',
    password: 'a-long-enough-passphrase',
    planCode: 'starter',
    stateCode: 'TS',
  })
  tenantId = r.tenantId
  await controlDb.query(
    `UPDATE control_plane.subscriptions
        SET status = 'active', trial_ends_on = NULL,
            current_period_start = CURRENT_DATE - 10, current_period_end = CURRENT_DATE + 20
      WHERE tenant_id = $1`, [tenantId])
})

afterAll(async () => {
  await closePools()
  await controlDb.end()
})

describe('the arithmetic', () => {
  const starter = { code: 'starter', name: 'Starter', base_price_paise: '200000', per_employee_price_paise: '5000', features: {}, limits: {} }
  const growth = { code: 'growth', name: 'Growth', base_price_paise: '500000', per_employee_price_paise: '8000', features: {}, limits: {} }

  it('charges the difference for the days that remain, not a whole period', () => {
    // 30-day period, 20 days left, 10 employees.
    // Starter 2,000 + 10x50 = 2,500. Growth 5,000 + 10x80 = 5,800. Difference 3,300.
    // Two thirds of the period remain, so 2,200 rupees.
    const p = prorationFor(starter, growth, 10, 20, 30)
    expect(p.subtotalPaise).toBe(220000n)
  })

  it('charges nothing on the last day of a period', () => {
    expect(prorationFor(starter, growth, 10, 0, 30).subtotalPaise).toBe(0n)
  })

  it('charges nothing for a downgrade', () => {
    // The cheaper plan starts next period. Refunding service already delivered
    // is a credit note, and a downgrade is not a billing error.
    expect(prorationFor(growth, starter, 10, 20, 30).subtotalPaise).toBe(0n)
  })

  it('charges nothing when the plan does not change', () => {
    expect(prorationFor(growth, growth, 10, 20, 30).subtotalPaise).toBe(0n)
  })
})

describe('switching plan mid-period', () => {
  it('an upgrade raises a pro-rata invoice immediately', async () => {
    const before = (await listInvoices(tenantId)).length
    await switchPlan(tenantId, 'growth')
    const after = await listInvoices(tenantId)
    expect(after.length).toBe(before + 1)

    const prorata = after[0]!
    expect(Number(prorata.total_paise)).toBeGreaterThan(0)
    // It is not a full period: it must cost less than a month of the new plan.
    expect(Number(prorata.subtotal_paise)).toBeLessThan(500000 + 8000 * 100)
    // INV/26-27/00020 -- its own invoice in the ordinary series, not a
    // footnote on the last one. CGST Rule 46(b): sixteen characters, unique
    // within the financial year.
    expect(prorata.number).toMatch(/^INV\/\d{2}-\d{2}\/\d{5}$/)
    expect(prorata.number.length).toBeLessThanOrEqual(16)
  })

  it('a downgrade raises nothing', async () => {
    const before = (await listInvoices(tenantId)).length
    await switchPlan(tenantId, 'starter')
    expect((await listInvoices(tenantId)).length).toBe(before)
  })
})
