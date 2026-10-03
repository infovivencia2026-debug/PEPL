/**
 * A leave request that the balance cannot cover is refused when it is made.
 *
 * applyLeave counted the days and checked overlap, but never looked at the balance: a request for 10
 * days against a balance of 2 was accepted, routed through the whole approval chain, and failed only at
 * the very end (INSUFFICIENT_BALANCE when the last approver clicked) -- after everyone's time was spent.
 * Two pending requests could also each fit the balance alone while together overdrawing it.
 *
 * The rule is the one approval already applies, unchanged: the leave ledger for the leave year, and the
 * company's `leave.allow_negative_balance` setting. Nothing here is a new HR policy.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createLeaveType } from '../src/leave/policy.ts'
import { appendEntry } from '../src/leave/ledger.ts'
import { applyLeave } from '../src/leave/apply.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { setSetting } from '../src/config/write.ts'

let A: Tenant
let el: string, cl: string
const USER = '90000000-0000-0000-0000-000000000009'
// Mon 12 Oct 2026 .. : plain working days in leave year 2026 (the year starts in April)
const apply = (leaveTypeId: string, startDate: string, endDate: string) => withTenant(A.id, async (tx) =>
  applyLeave(tx, await resolveConfig(tx, A.id), { employeeId: A.employeeId, requestedByUserId: USER, leaveTypeId, startDate, endDate }))

afterAll(async () => { await closePools(); await controlPool.end() })

beforeEach(async () => {
  A = (await resetAndSeed()).a                       // the sanctioned reset: nothing from another test remains
  await withTenant(A.id, async (tx) => {
    el = (await createLeaveType(tx, { code: 'EL', name: 'Earned' })).id
    cl = (await createLeaveType(tx, { code: 'CL', name: 'Casual' })).id
    for (const [id, key] of [[el, 'el'], [cl, 'cl']] as const) {
      await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: id, entryType: 'opening', deltaDays: 2, effectiveDate: '2026-04-01', cycleYear: 2026, idempotencyKey: `open-${key}-${Math.random()}` })
    }
  })
})

describe('applying for more than the balance', () => {
  it('is refused up front, naming the balance', async () => {
    await expect(apply(el, '2026-10-12', '2026-10-14')).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })    // 3 days against 2
    expect((await controlPool.query(`SELECT 1 FROM leave_requests WHERE tenant_id = $1`, [A.id])).rowCount).toBe(0) // nothing was created
  })

  it('is allowed exactly up to the balance', async () => {
    expect((await apply(el, '2026-10-12', '2026-10-13')).totalDays).toBe(2)
  })

  it('counts requests that are still pending: two that fit alone may not overdraw together', async () => {
    await apply(el, '2026-10-12', '2026-10-13')                                                                    // uses the 2 days
    await expect(apply(el, '2026-10-19', '2026-10-19')).rejects.toMatchObject({ code: 'INSUFFICIENT_BALANCE' })
  })

  it('is judged per leave type: a balance in one does not cover another', async () => {
    await apply(el, '2026-10-12', '2026-10-13')
    expect((await apply(cl, '2026-10-19', '2026-10-20')).totalDays).toBe(2)                                       // casual has its own 2
  })

  it('is judged per leave year: a pending request in another year is not counted', async () => {
    await withTenant(A.id, (tx) => appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el, entryType: 'opening', deltaDays: 2, effectiveDate: '2027-04-01', cycleYear: 2027, idempotencyKey: `open-2027-${Math.random()}` }))
    await apply(el, '2026-10-12', '2026-10-13')                                                                    // year 2026 exhausted
    expect((await apply(el, '2027-04-05', '2027-04-06')).totalDays).toBe(2)                                       // year 2027 is separate
  })

  it('respects the company setting that permits a negative balance', async () => {
    await withTenant(A.id, (tx) => setSetting(tx, { key: 'leave.allow_negative_balance', value: true, reason: 'test', effectiveFrom: '2026-01-01' }))
    expect((await apply(el, '2026-10-12', '2026-10-16')).totalDays).toBe(5)                                       // 5 days against 2: allowed
  })

  it('a withdrawn or rejected request frees its days', async () => {
    const first = await apply(el, '2026-10-12', '2026-10-13')
    await controlPool.query(`UPDATE leave_requests SET status = 'rejected' WHERE id = $1`, [first.id])
    expect((await apply(el, '2026-10-19', '2026-10-20')).totalDays).toBe(2)
  })
})
