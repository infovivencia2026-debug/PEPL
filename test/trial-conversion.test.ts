/**
 * A company that converts from trial is billed from the day it converts, and every path an operator
 * has for changing a plan goes through the one billing switch.
 *
 * `ops plan`, the console route and `ops create --activate` called `changePlan`, which only rewrites
 * plan_code: no period restart, no proration, no invoice, and an audit row with nothing behind it.
 * A production company was upgraded that way and never invoiced.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { signup, switchPlan, listInvoices } from '../src/control-plane/billing.ts'

const stamp = Date.now()
const made: string[] = []

const customer = async (label: string, plan = 'trial'): Promise<string> => {
  const { tenantId } = await signup({
    legalName: `Conversion ${label} ${stamp}`, adminEmail: `${label}-${stamp}@conversion.test`, adminName: 'Admin',
    password: 'a-long-customer-passphrase', planCode: plan, stateCode: 'TS',
  })
  made.push(tenantId)
  return tenantId
}
const sub = async (t: string) => (await controlDb.query<{ status: string; trial_ends_on: string | null; start: string; end: string; today: string; month_on: string }>(
  `SELECT status, trial_ends_on::text, current_period_start::text AS start, current_period_end::text AS end,
          CURRENT_DATE::text AS today, (CURRENT_DATE + interval '1 month')::date::text AS month_on
     FROM control_plane.subscriptions WHERE tenant_id = $1`, [t])).rows[0]!

afterAll(async () => {
  await controlDb.query(`DELETE FROM control_plane.invoices WHERE tenant_id = ANY($1::uuid[])`, [made])
  await controlDb.query(`DELETE FROM control_plane.subscriptions WHERE tenant_id = ANY($1::uuid[])`, [made])
  await closePools()
  await controlDb.end()
})

describe('converting from trial', () => {
  it('starts the paid period today, a full month long, and says it was a conversion', async () => {
    const t = await customer('trial')
    expect((await sub(t)).status).toBe('trialing')
    const summary = await switchPlan(t, 'growth')
    expect(summary.activatedFromTrial).toBe(true)
    const s = await sub(t)
    expect(s.status).toBe('active')
    expect(s.trial_ends_on).toBeNull()
    expect(s.start).toBe(s.today)
    expect(s.end).toBe(s.month_on)
    // Nothing is owed yet: the first period is billed at the plan it chose when it closes.
    expect(await listInvoices(t)).toHaveLength(0)
  })

  it('a company that is already paying is not "converted" and keeps its period', async () => {
    const t = await customer('paying', 'starter')
    await controlDb.query(`UPDATE control_plane.subscriptions SET status = 'active', trial_ends_on = NULL,
        current_period_start = CURRENT_DATE - 10, current_period_end = CURRENT_DATE + 20 WHERE tenant_id = $1`, [t])
    const before = await sub(t)
    const summary = await switchPlan(t, 'growth')
    expect(summary.activatedFromTrial).toBe(false)
    const after = await sub(t)
    expect([after.start, after.end]).toEqual([before.start, before.end])
  })
})

describe('the operator paths use the billing switch', () => {
  const read = (f: string) => readFileSync(f, 'utf8')
  it.each(['scripts/ops.ts', 'src/http/routes/platform.ts'])('%s never calls changePlan', (file) => {
    expect(read(file), `${file} must call switchPlan so an upgrade is prorated, invoiced and audited`).not.toMatch(/\bchangePlan\(/)
  })
})
