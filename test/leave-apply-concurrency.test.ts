/**
 * Concurrent leave requests cannot overdraw a balance together.
 *
 * Each request below fits the balance on its own; only the SET of them does not. The balance check reads the
 * ledger and the pending requests, so without the per-employee lock every request read the same untouched
 * balance and all were accepted. All requests are released at one instant (a barrier), because requests sent
 * one after another would pass for the wrong reason.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createLeaveType } from '../src/leave/policy.ts'
import { appendEntry } from '../src/leave/ledger.ts'
import { applyLeave } from '../src/leave/apply.ts'
import { resolveConfig } from '../src/config/resolver.ts'

let A: Tenant
let cl: string
const USER = '90000000-0000-0000-0000-000000000009'
// Nine distinct weekdays in leave year 2026 (the year starts in April); none is a holiday in the seed.
const DAYS = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-09', '2026-11-10', '2026-11-11', '2026-11-12']

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    cl = (await createLeaveType(tx, { code: 'CL', name: 'Casual' })).id
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: cl, entryType: 'opening', deltaDays: 3, effectiveDate: '2026-04-01', cycleYear: 2026, idempotencyKey: 'opening-cl-concurrency' })
  })
}, 30_000)
afterAll(async () => { await closePools(); await controlPool.end() })

const apply = (day: string) => withTenant(A.id, async (tx) =>
  applyLeave(tx, await resolveConfig(tx, A.id), { employeeId: A.employeeId, requestedByUserId: USER, leaveTypeId: cl, startDate: day, endDate: day }))

describe('nine simultaneous one-day requests against a balance of three', () => {
  it('accepts exactly three, refuses the rest for the balance, and fails no other way', async () => {
    let release!: () => void
    const barrier = new Promise<void>((r) => { release = r })
    const attempts = DAYS.map((d) => barrier.then(() => apply(d).then((r) => ({ ok: true as const, r }), (e: { code?: string }) => ({ ok: false as const, code: e.code }))))
    await new Promise((r) => setTimeout(r, 50))   // let every connection reach the barrier
    release()
    const results = await Promise.all(attempts)
    const accepted = results.filter((x) => x.ok)
    const refused = results.filter((x) => !x.ok) as { ok: false; code?: string }[]
    expect(accepted).toHaveLength(3)
    expect(new Set(refused.map((x) => x.code))).toEqual(new Set(['INSUFFICIENT_BALANCE']))
    // The pending requests on record add up to what the balance allowed, never more.
    const { rows } = await controlPool.query(`SELECT coalesce(sum(total_days), 0)::float AS days FROM leave_requests WHERE tenant_id = $1 AND status = 'pending'`, [A.id])
    expect(rows[0].days).toBe(3)
  })
})
