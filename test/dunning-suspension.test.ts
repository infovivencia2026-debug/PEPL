/**
 * The nightly dunning job must not undo what an operator did on purpose.
 *
 * Dunning suspends a customer who has not paid, and reactivates them once nothing
 * is owed. Its reactivation rule was "suspended, trial over, no invoice due" --
 * which is ALSO true of a customer an operator suspended deliberately (a contract
 * dispute, an abuse complaint, a customer who asked to be paused). The next night
 * the job found no unpaid invoice and switched them back on. Reported by the audit;
 * reproduced here first.
 *
 * The fix records WHO suspended: only a suspension the job itself made is one the
 * job may lift.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { controlDb, setSubscriptionStatus } from '../src/control-plane/index.ts'
import { signup, runDunning, markInvoicePaid } from '../src/control-plane/billing.ts'
import { closePools } from '../src/db/pool.ts'

const stamp = Date.now()
/** Every tenant this suite makes, so it can clear away only its own billing rows. */
const made: string[] = []
const statusOf = async (tenantId: string) =>
  (await controlDb.query<{ status: string }>(`SELECT status FROM control_plane.subscriptions WHERE tenant_id = $1`, [tenantId])).rows[0]!.status

/** A customer past its trial, on a paid plan, with nothing owed. */
async function payingCustomer(label: string): Promise<string> {
  const { tenantId } = await signup({
    legalName: `Dunning ${label} ${stamp}`, adminEmail: `${label}-${stamp}@dunning.test`, adminName: 'Admin',
    password: 'a-long-customer-passphrase', planCode: 'starter', stateCode: 'TS',
  })
  made.push(tenantId)
  await controlDb.query(`UPDATE control_plane.subscriptions SET status = 'active', trial_ends_on = NULL WHERE tenant_id = $1`, [tenantId])
  return tenantId
}

afterAll(async () => {
  // closePeriods() bills EVERY tenant in the shared control plane, so anything left with
  // an expired period is picked up by whichever billing suite runs next. That is how this
  // suite broke another's "closing again invoices nothing new". Leave nothing behind.
  await controlDb.query(`DELETE FROM control_plane.invoices WHERE tenant_id = ANY($1::uuid[])`, [made])
  await controlDb.query(`DELETE FROM control_plane.subscriptions WHERE tenant_id = ANY($1::uuid[])`, [made])
  await closePools()
  await controlDb.end()
})

describe('a suspension made by a person', () => {
  it('survives the dunning job', async () => {
    const tenantId = await payingCustomer('operator')
    await setSubscriptionStatus(tenantId, 'suspended')
    expect(await statusOf(tenantId)).toBe('suspended')

    // Nothing is owed and the trial is over: exactly what used to trigger the switch-on.
    await runDunning()
    expect(await statusOf(tenantId)).toBe('suspended')
  })

  it('survives it every night, not just the first', async () => {
    const tenantId = await payingCustomer('operator-nightly')
    await setSubscriptionStatus(tenantId, 'suspended')
    for (let night = 0; night < 3; night++) await runDunning()
    expect(await statusOf(tenantId)).toBe('suspended')
  })

  it('ends only when a person ends it', async () => {
    const tenantId = await payingCustomer('operator-lifted')
    await setSubscriptionStatus(tenantId, 'suspended')
    await setSubscriptionStatus(tenantId, 'active')
    expect(await statusOf(tenantId)).toBe('active')
    await runDunning()
    expect(await statusOf(tenantId)).toBe('active')
  })

  it('is treated as deliberate even for a row that predates the cause being recorded', async () => {
    // A suspended row with NO recorded cause is a legacy one. Reactivating it would be
    // the very bug, so an unrecorded cause counts as a person's decision.
    const tenantId = await payingCustomer('legacy')
    await controlDb.query(`UPDATE control_plane.subscriptions SET status = 'suspended', suspension_cause = NULL WHERE tenant_id = $1`, [tenantId])
    await runDunning()
    expect(await statusOf(tenantId)).toBe('suspended')
  })
})

describe('a suspension the job made itself', () => {
  it('is still lifted once the customer has paid', async () => {
    // The control: the behaviour that must NOT change. Overdue -> suspended -> paid -> active.
    const tenantId = await payingCustomer('nonpayer')
    // An overdue invoice made DIRECTLY for this tenant. closePeriods() would bill every
    // tenant in the shared database, which is not this suite's to do.
    const invoiceId = (await controlDb.query<{ id: string }>(
      `INSERT INTO control_plane.invoices
         (tenant_id, number, period_start, period_end, plan_code, employees, base_paise, per_employee_paise,
          subtotal_paise, gst_rate, gst_paise, total_paise, status, due_on)
       VALUES ($1, $2, CURRENT_DATE - 100, CURRENT_DATE - 70, 'starter', 1, 100000, 0, 100000, 0, 0, 100000, 'due', CURRENT_DATE - 60)
       RETURNING id`, [tenantId, `TEST/${stamp}/${made.length}`])).rows[0]!.id

    await runDunning()
    expect(await statusOf(tenantId)).toBe('suspended')

    await markInvoicePaid(invoiceId, `UTR-${stamp}`)
    await runDunning()
    expect(await statusOf(tenantId)).toBe('active')
  })
})
