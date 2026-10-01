/**
 * Approved UNPAID leave must not be paid.
 *
 * Approving leave marked each charged day `on_leave` with a paid fraction of 1, whatever the leave
 * type: `leave_types.is_paid` was read by nothing downstream. So a day of "leave without pay" came
 * out of the attendance summary -- and therefore the payroll freeze -- as a fully paid day. Reported
 * by an audit (HR-08).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createLeaveType } from '../src/leave/policy.ts'
import { settleLeaveDecision } from '../src/leave/apply.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { setSetting } from '../src/config/write.ts'

let A: Tenant
const ACTOR = '90000000-0000-0000-0000-000000000009'

beforeAll(async () => {
  ;({ a: A } = await resetAndSeed())
  await withTenant(A.id, (tx) => setSetting(tx, { key: 'leave.allow_negative_balance', value: true, reason: 'test', effectiveFrom: '2026-01-01' }))
})
afterAll(async () => { await closePools(); await controlPool.end() })

/** A pending request for one type, settled as approved; returns what the day ended up as. */
async function approve(code: string, isPaid: boolean, date: string, part: 'full' | 'half') {
  return withTenant(A.id, async (tx) => {
    const type = await createLeaveType(tx, { code, name: code, isPaid })
    const id = (await tx.query<{ id: string }>(
      `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, day_parts, total_days)
       VALUES ($1,$2,$3,$4,$4,$5::jsonb,$6) RETURNING id`,
      [A.id, A.employeeId, type.id, date, JSON.stringify({ [date]: part }), part === 'full' ? 1 : 0.5])).rows[0]!.id
    await settleLeaveDecision(tx, await resolveConfig(tx, A.id), { leaveRequestId: id, status: 'approved', actorUserId: ACTOR })
    return (await tx.query<{ status: string; day_fraction: string }>(
      `SELECT status, day_fraction::text FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`, [A.employeeId, date])).rows[0]!
  })
}

describe('what an approved leave day is worth', () => {
  it('a PAID leave day counts as a paid day', async () => {
    const day = await approve('EL', true, '2026-10-05', 'full')
    expect(day.status).toBe('on_leave')
    expect(Number(day.day_fraction)).toBe(1)
  })

  it('an UNPAID leave day is loss of pay, not a paid day', async () => {
    const day = await approve('LWP', false, '2026-10-06', 'full')
    expect(day.status).toBe('on_leave')
    expect(Number(day.day_fraction)).toBe(0)           // paid fraction 0: the whole day is LOP
  })

  it('half a day of unpaid leave pays the half that was worked', async () => {
    const day = await approve('LWPH', false, '2026-10-07', 'half')
    expect(Number(day.day_fraction)).toBe(0.5)
  })
})
