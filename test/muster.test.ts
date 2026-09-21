/**
 * The muster roll is the payroll classification rendered per day: cells sum
 * to exactly the payable/LOP that summarisePeriod freezes, codes follow the
 * day's status and mode, weekly offs and holidays fill unrecorded days, and
 * the CSV is Form-25 shaped (one column per day, then totals).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { applyCorrection, recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { musterRoll, musterCsv, monthBounds } from '../src/attendance/muster.ts'
import { summarisePeriod } from '../src/attendance/summary.ts'

let A: Tenant
const policy = { unmarkedDayIsLop: false, lateMarksPerHalfDay: 0, weekPattern: 'five_day' as const, defaultStateCode: 'KA' }
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    await tx.query(`INSERT INTO holidays (tenant_id, holiday_on, name) VALUES ($1, DATE '2026-10-02', 'Gandhi Jayanti')`, [A.id])
    // Mon 5 Oct: full day in the office; Tue 6: WFH; Wed 7: field duty; Thu 8: absent; Fri 9: half-day leave
    await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T03:30:00Z', localDate: '2026-10-05', direction: 'in', source: 'web' })
    await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T12:30:00Z', localDate: '2026-10-05', direction: 'out', source: 'web' })
    await recomputeDay(tx, A.employeeId, '2026-10-05')
    await applyCorrection(tx, { employeeId: A.employeeId, workDate: '2026-10-06', action: 'mark_remote', after: {}, reason: 'wfh' })
    await applyCorrection(tx, { employeeId: A.employeeId, workDate: '2026-10-07', action: 'mark_field_duty', after: {}, reason: 'site' })
    await applyCorrection(tx, { employeeId: A.employeeId, workDate: '2026-10-08', action: 'mark_absent', after: {}, reason: 'no show' })
    await applyCorrection(tx, { employeeId: A.employeeId, workDate: '2026-10-09', action: 'mark_leave', after: { dayFraction: 0.5 }, reason: 'half day CL' })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('muster roll', () => {
  it('bounds a month', () => {
    expect(monthBounds('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' })
    expect(monthBounds('2028-02')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
    expect(() => monthBounds('2026-13')).toThrow()
  })

  it('codes each day, fills offs and holidays, and its totals equal the payroll freeze', async () => {
    await withTenant(A.id, async (tx) => {
      const m = await musterRoll(tx, { month: '2026-10', policy, employeeIds: [A.employeeId] })
      expect(m.days.length).toBe(31)
      const row = m.rows[0]!
      const code = (d: string) => row.days.find((c) => c.date === d)!.code
      expect(code('2026-10-02')).toBe('H')      // Gandhi Jayanti
      expect(code('2026-10-03')).toBe('WO')     // Saturday
      expect(code('2026-10-04')).toBe('WO')     // Sunday
      expect(code('2026-10-05')).toBe('P')
      expect(code('2026-10-06')).toBe('WFH')
      expect(code('2026-10-07')).toBe('OD')
      expect(code('2026-10-08')).toBe('A')
      expect(code('2026-10-09')).toBe('LH')
      expect(code('2026-10-12')).toBe('–')      // no record, paid under this policy
      expect(row.days.find((c) => c.date === '2026-10-05')!.firstIn).toBeTruthy()
      expect(row.totals).toMatchObject({ present: 1, remote: 1, onDuty: 1, absent: 1, leave: 0.5, holiday: 1, weeklyOff: 9 })

      // the numbers payroll would freeze are the same numbers
      const [s] = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy, employeeIds: [A.employeeId] })
      expect(row.totals.payable).toBe(s!.payableDays)
      expect(row.totals.lop).toBe(s!.lopDays)
      expect(row.totals.lop).toBe(1.5)                      // the absent day and half the leave day
      const cellSum = row.days.reduce((n, c) => n + c.payable, 0)
      expect(Math.round(cellSum * 100) / 100).toBe(s!.payableDays)
    })
  })

  it('filters by department and is Form-25 shaped as CSV', async () => {
    await withTenant(A.id, async (tx) => {
      const none = await musterRoll(tx, { month: '2026-10', policy, department: 'Nowhere' })
      expect(none.rows).toEqual([])
      const m = await musterRoll(tx, { month: '2026-10', policy })
      const csv = musterCsv(m)
      const [head, first] = csv.trim().split('\n')
      expect(head!.split(',').slice(4, 35)).toEqual(Array.from({ length: 31 }, (_, i) => String(i + 1).padStart(2, '0')))
      expect(head).toContain('Payable,LOP')
      expect(first!.split(',').length).toBe(head!.split(',').length)
    })
  })
})
