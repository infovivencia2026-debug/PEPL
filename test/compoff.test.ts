/**
 * Comp-off: work on a Sunday or holiday credits the CO leave type (full or
 * half), once per date; the credit is spendable through a normal leave
 * request; an unspent credit lapses at expiry; HR can grant one manually.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { creditFromMuster, grantCompOff, lapseExpired, listCredits } from '../src/leave/compoff.ts'
import { balance } from '../src/leave/ledger.ts'

let A: Tenant
let co: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    const t = await tx.query<{ id: string }>(`INSERT INTO leave_types (tenant_id, code, name, is_paid, affects_lop) VALUES ($1,'CO','Compensatory Off',true,false) ON CONFLICT (tenant_id, code) DO UPDATE SET status='active' RETURNING id`, [A.id])
    co = t.rows[0]!.id
    await tx.query(`INSERT INTO holidays (tenant_id, holiday_on, name) VALUES ($1, DATE '2026-08-15', 'Independence Day')`, [A.id])
    // Sunday 2026-08-16 full day (9h), holiday 15 Aug half (3h), Monday 17 Aug (working day, no credit), Sunday 23 Aug too short (1h)
    for (const [d, mins] of [['2026-08-16', 540], ['2026-08-15', 180], ['2026-08-17', 540], ['2026-08-23', 60]] as const) {
      await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status, worked_minutes, day_fraction) VALUES ($1,$2,$3,'present',$4,1)`, [A.id, A.employeeId, d, mins])
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('comp-off', () => {
  it('credits off-day work from the muster once, full or half, and shows in the CO balance', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      expect(await creditFromMuster(tx, cfg, { from: '2026-08-10', to: '2026-08-31' })).toBe(2)     // 16th full, 15th half; 17th is a workday; 23rd too short
      expect(await creditFromMuster(tx, cfg, { from: '2026-08-10', to: '2026-08-31' })).toBe(0)     // idempotent
      const credits = await listCredits(tx, A.employeeId)
      expect(credits.map((c) => [c.work_date, c.status])).toEqual([['2026-08-16', 'available'], ['2026-08-15', 'available_half']])
      expect(credits[0]!.expires_on).toBe('2026-11-14')                                              // 90 days
      const b = await balance(tx, A.employeeId, co, 2026)
      expect(b.available).toBe(1.5)
    })
  })

  it('HR grants a missed one; a second grant for the same date is refused; expiry lapses what is unspent', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      const g = await grantCompOff(tx, cfg, { employeeId: A.employeeId, workDate: '2026-07-05', days: 1, note: 'client site on Sunday' })
      expect(g.granted).toBe(true)
      expect((await grantCompOff(tx, cfg, { employeeId: A.employeeId, workDate: '2026-07-05', days: 1 })).granted).toBe(false)
      expect((await balance(tx, A.employeeId, co, 2026)).available).toBe(2.5)
      // the July credit expires on 3 Oct; on 4 Oct it lapses — the August ones do not
      expect(await lapseExpired(tx, cfg, '2026-10-04')).toBe(1)
      expect((await balance(tx, A.employeeId, co, 2026)).available).toBe(1.5)
      expect((await listCredits(tx, A.employeeId)).find((c) => c.work_date === '2026-07-05')!.status).toBe('expired')
      expect(await lapseExpired(tx, cfg, '2026-10-04')).toBe(0)
    })
  })
})
