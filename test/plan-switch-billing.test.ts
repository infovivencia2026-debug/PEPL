/**
 * Changing plan must bill once, on the day it says, or not at all.
 *
 * Three defects, found by an audit and reproduced here first:
 *
 *  1. DOUBLE BILLING. An upgrade raised a pro-rata top-up (the difference for the
 *     days remaining), and then the period invoice was written at the NEW plan for
 *     the WHOLE period -- which already includes those days. The customer paid the
 *     difference twice. A downgrade did the reverse of what docs/proration says:
 *     the cheaper price applied retroactively to the period already used.
 *
 *  2. A COLLISION THAT LOST AN INVOICE. The top-up was keyed (tenant, period_start)
 *     with period_start = today, the same key as the period invoice. Switching on the
 *     first day of a period made the period's real invoice `ON CONFLICT DO NOTHING` --
 *     silently skipped. Revenue simply not billed, with nothing to say so.
 *
 *  3. NOT ATOMIC. The plan, the entitlements, the top-up invoice and the audit row
 *     were separate statements on separate connections; a failure part-way left a
 *     customer on a new plan with no invoice for it.
 *
 * The policy (test/proration.test.ts): an upgrade is charged the difference for the days
 * remaining, at once; a downgrade takes effect at the next period. The period invoice
 * is therefore written at the plan the period STARTED on.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { signup, switchPlan, listInvoices, closePeriods } from '../src/control-plane/billing.ts'

const stamp = Date.now()
const made: string[] = []

async function customer(label: string, plan: string, period: { start: string; end: string }): Promise<string> {
  const { tenantId } = await signup({
    legalName: `PlanSwitch ${label} ${stamp}`, adminEmail: `${label}-${stamp}@planswitch.test`, adminName: 'Admin',
    password: 'a-long-customer-passphrase', planCode: plan, stateCode: 'TS',
  })
  made.push(tenantId)
  await controlDb.query(
    `UPDATE control_plane.subscriptions
        SET status = 'active', trial_ends_on = NULL,
            current_period_start = ${period.start}, current_period_end = ${period.end}
      WHERE tenant_id = $1`, [tenantId])
  return tenantId
}

const planOf = async (t: string) =>
  (await controlDb.query<{ plan_code: string }>(`SELECT plan_code FROM control_plane.subscriptions WHERE tenant_id = $1`, [t])).rows[0]!.plan_code
const endPeriodToday = (t: string, startOffsetDays: number) => controlDb.query(
  `UPDATE control_plane.subscriptions SET current_period_start = CURRENT_DATE - ${startOffsetDays}, current_period_end = CURRENT_DATE WHERE tenant_id = $1`, [t])
const basePrice = async (plan: string) =>
  (await controlDb.query<{ b: string }>(`SELECT base_price_paise::text AS b FROM control_plane.plans WHERE code = $1`, [plan])).rows[0]!.b

afterAll(async () => {
  // closePeriods() bills every tenant in the shared control plane: leave nothing that is due.
  await controlDb.query(`DELETE FROM control_plane.invoices WHERE tenant_id = ANY($1::uuid[])`, [made])
  await controlDb.query(`DELETE FROM control_plane.subscriptions WHERE tenant_id = ANY($1::uuid[])`, [made])
  await closePools()
  await controlDb.end()
})

describe('an upgrade is billed once', () => {
  it('the period closes at the plan it STARTED on; the top-up covers the difference for the days left', async () => {
    const t = await customer('once', 'starter', { start: 'CURRENT_DATE - 15', end: 'CURRENT_DATE + 15' })
    await switchPlan(t, 'growth')
    const topUp = (await listInvoices(t))[0]!
    expect(topUp.plan_code).toBe('growth')
    expect(Number(topUp.total_paise)).toBeGreaterThan(0)

    await endPeriodToday(t, 30)
    await closePeriods()
    const invoices = await listInvoices(t)
    const period = invoices.find((i) => i.id !== topUp.id)
    expect(period, 'the period invoice must exist').toBeDefined()
    // The period ran on Starter until the switch: it is billed at Starter, not at Growth.
    expect(period!.plan_code).toBe('starter')
    expect(period!.base_paise).toBe(await basePrice('starter'))
  })

  it('and the NEXT period is billed at the new plan', async () => {
    const t = await customer('next', 'starter', { start: 'CURRENT_DATE - 15', end: 'CURRENT_DATE + 15' })
    await switchPlan(t, 'growth')
    const topUpId = (await listInvoices(t))[0]!.id
    await endPeriodToday(t, 30)
    await closePeriods()                       // closes the period that started on Starter
    await endPeriodToday(t, 45)                // a different start, so it is a different period
    await closePeriods()                       // closes the first period that ran on Growth
    const periods = (await listInvoices(t)).filter((i) => i.id !== topUpId)
    expect(periods.map((i) => i.plan_code).sort()).toEqual(['growth', 'starter'])
    expect(periods.find((i) => i.plan_code === 'growth')!.base_paise).toBe(await basePrice('growth'))
  })
})

describe('a downgrade takes effect at the next period', () => {
  it('raises nothing now, bills the current period at the higher plan, then the lower one', async () => {
    const t = await customer('down', 'growth', { start: 'CURRENT_DATE - 15', end: 'CURRENT_DATE + 15' })
    await switchPlan(t, 'starter')
    expect(await listInvoices(t)).toHaveLength(0)

    await endPeriodToday(t, 30)
    await closePeriods()
    const first = (await listInvoices(t))[0]!
    expect(first.plan_code).toBe('growth')      // service already delivered at Growth is billed at Growth

    await endPeriodToday(t, 45)
    await closePeriods()
    const second = (await listInvoices(t)).find((i) => i.id !== first.id)!
    expect(second.plan_code).toBe('starter')
  })
})

describe('switching on the first day of a period', () => {
  it('does not swallow the period\'s own invoice', async () => {
    // The top-up carries period_start = today; so does the period that starts today.
    const t = await customer('sameday', 'starter', { start: 'CURRENT_DATE', end: 'CURRENT_DATE + 30' })
    await switchPlan(t, 'growth')
    expect(await listInvoices(t)).toHaveLength(1)                 // the top-up

    await endPeriodToday(t, 0)                                     // the period, which started today, is now due
    await controlDb.query(`UPDATE control_plane.subscriptions SET current_period_start = CURRENT_DATE WHERE tenant_id = $1`, [t])
    await closePeriods()
    expect(await listInvoices(t)).toHaveLength(2)                 // the top-up AND the period, not just the top-up
  })

  it('two upgrades on one day both succeed', async () => {
    const t = await customer('twice', 'starter', { start: 'CURRENT_DATE - 5', end: 'CURRENT_DATE + 25' })
    await switchPlan(t, 'growth')
    await switchPlan(t, 'enterprise')
    expect(await listInvoices(t)).toHaveLength(2)
    expect(await planOf(t)).toBe('enterprise')
  })
})

describe('going up, down and up again inside one period', () => {
  it('pays for the difference once: what a top-up covered is not charged again', async () => {
    const t = await customer('updownup', 'starter', { start: 'CURRENT_DATE - 10', end: 'CURRENT_DATE + 20' })
    await switchPlan(t, 'growth')                  // pays starter -> growth for 20 days
    expect(await listInvoices(t)).toHaveLength(1)
    await switchPlan(t, 'starter')                 // a downgrade: nothing
    expect(await listInvoices(t)).toHaveLength(1)
    await switchPlan(t, 'growth')                  // back to what was already paid for: nothing
    expect(await listInvoices(t)).toHaveLength(1)
    await switchPlan(t, 'enterprise')              // beyond it: only the step above growth
    const invoices = await listInvoices(t)
    expect(invoices).toHaveLength(2)
  })
})

describe('a switch is atomic', () => {
  it('a failure after the plan changed leaves the old plan and no invoice', async () => {
    const t = await customer('atomic', 'starter', { start: 'CURRENT_DATE - 10', end: 'CURRENT_DATE + 20' })
    // Make the LAST step of the switch fail, after everything before it has been written.
    await controlDb.query(`
      CREATE OR REPLACE FUNCTION control_plane.test_fail_plan_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'subscription.plan_changed' AND NEW.tenant_id = '${t}' THEN RAISE EXCEPTION 'injected failure'; END IF;
        RETURN NEW;
      END $$`)
    await controlDb.query(`CREATE TRIGGER test_fail_plan_change BEFORE INSERT ON control_plane.platform_audit
                             FOR EACH ROW EXECUTE FUNCTION control_plane.test_fail_plan_change()`)
    try {
      await expect(switchPlan(t, 'growth')).rejects.toThrow(/injected failure/)
    } finally {
      await controlDb.query(`DROP TRIGGER IF EXISTS test_fail_plan_change ON control_plane.platform_audit`)
      await controlDb.query(`DROP FUNCTION IF EXISTS control_plane.test_fail_plan_change()`)
    }
    expect(await planOf(t)).toBe('starter')
    expect(await listInvoices(t)).toHaveLength(0)
  })
})
