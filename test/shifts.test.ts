/**
 * Shifts: the day is judged against the schedule (grace, break, half/full,
 * OT, night shifts), the roster decides who is judged that way, and the
 * period summary turns the muster into freeze rows — with the late rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { createShift, evaluateShiftDay, listShifts, retireShift, rosterEmployee, shiftFor } from '../src/attendance/shifts.ts'
import { summarisePeriod } from '../src/attendance/summary.ts'
import { changeCompensation } from '../src/people/history.ts'

const L = (r: number): number => r * 100
// IST: a 09:30 local start is 04:00Z.
const ist = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+05:30`)

const GEN = {
  start_time: '09:30:00', end_time: '18:30:00', grace_in_min: 15, grace_out_min: 0, break_min: 60,
  full_day_min: 480, half_day_min: 240, ot_after_min: 30, ot_eligible: true, weekly_off_days: [0],
}

describe('evaluateShiftDay', () => {
  it('on time within grace: no late; a full day after the break; OT past the threshold', () => {
    const d = evaluateShiftDay(GEN, '2026-10-05', { firstIn: ist('2026-10-05', '09:40'), lastOut: ist('2026-10-05', '19:15') })
    expect(d.lateMinutes).toBe(0)                 // 10 min late, 15 grace
    expect(d.earlyMinutes).toBe(0)
    expect(d.netWorkedMinutes).toBe(9 * 60 + 35 - 60)
    expect(d.dayFraction).toBe(1)
    expect(d.otMinutes).toBe(45)                  // 19:15 − 18:30 = 45 ≥ 30
    expect(d.isWeeklyOff).toBe(false)
  })

  it('late beyond grace, early out, half day, no OT under the threshold', () => {
    const d = evaluateShiftDay(GEN, '2026-10-05', { firstIn: ist('2026-10-05', '10:10'), lastOut: ist('2026-10-05', '15:30') })
    expect(d.lateMinutes).toBe(25)                // 40 late − 15 grace
    expect(d.earlyMinutes).toBe(180)
    expect(d.netWorkedMinutes).toBe(320 - 60)
    expect(d.dayFraction).toBe(0.5)
    expect(d.otMinutes).toBe(0)
    const tiny = evaluateShiftDay(GEN, '2026-10-05', { firstIn: ist('2026-10-05', '09:30'), lastOut: ist('2026-10-05', '12:00') })
    expect(tiny.dayFraction).toBe(0)              // 90 net < 240
    const ot = evaluateShiftDay(GEN, '2026-10-05', { firstIn: ist('2026-10-05', '09:30'), lastOut: ist('2026-10-05', '18:55') })
    expect(ot.otMinutes).toBe(0)                  // 25 < 30 threshold
  })

  it('a night shift ends the next day and Sunday is off', () => {
    const night = { ...GEN, start_time: '22:00:00', end_time: '06:00:00', full_day_min: 420, half_day_min: 210 }
    const d = evaluateShiftDay(night, '2026-10-05', { firstIn: ist('2026-10-05', '22:05'), lastOut: ist('2026-10-06', '06:40') })
    expect(d.lateMinutes).toBe(0)
    expect(d.netWorkedMinutes).toBe(8 * 60 + 35 - 60)
    expect(d.dayFraction).toBe(1)
    expect(d.otMinutes).toBe(40)
    expect(evaluateShiftDay(GEN, '2026-10-04', { firstIn: null, lastOut: null }).isWeeklyOff).toBe(true)   // Sunday
    expect(evaluateShiftDay(GEN, '2026-10-05', { firstIn: ist('2026-10-05', '09:30'), lastOut: null }).dayFraction).toBe(1) // in, no out
  })
})

// ---------------------------------------------------------------------------
let A: Tenant
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    await tx.query(`UPDATE employees SET date_of_joining = DATE '2026-01-01' WHERE id = $1`, [A.employeeId])
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000), components: { basic: L(25_000), hra: L(10_000), special: L(15_000) }, effectiveFrom: '2026-01-01' })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('roster and recompute', () => {
  it('a rostered person is judged by the shift; before the roster the company pattern applies', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(createShift(tx, { code: 'X', name: 'x', startTime: '09:00', endTime: '09:00', fullDayMin: 480, halfDayMin: 240 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createShift(tx, { code: 'X', name: 'x', startTime: '09:00', endTime: '18:00', fullDayMin: 200, halfDayMin: 240 }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const gen = await createShift(tx, { code: 'gen', name: 'General', startTime: '09:30', endTime: '18:30',
        graceInMin: 15, breakMin: 60, fullDayMin: 480, halfDayMin: 240, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] })
      expect(gen.code).toBe('GEN')
      await rosterEmployee(tx, { employeeId: A.employeeId, shiftId: gen.id, effectiveFrom: '2026-10-01' })
      await expect(rosterEmployee(tx, { employeeId: A.employeeId, shiftId: gen.id, effectiveFrom: '2026-09-15' }))
        .rejects.toMatchObject({ code: 'ROSTER_NOT_AFTER_CURRENT' })
      expect(await shiftFor(tx, A.employeeId, '2026-09-30')).toBeNull()
      expect((await shiftFor(tx, A.employeeId, '2026-10-05'))?.code).toBe('GEN')

      // Oct 5 (Mon): late by 40, out 19:15 -> late 25, OT 45, full day
      for (const [dir, at] of [['in', '10:10'], ['out', '19:15']] as const) {
        await recordPunch(tx, { employeeId: A.employeeId, punchedAt: ist('2026-10-05', at).toISOString(), localDate: '2026-10-05', direction: dir, source: 'mobile' })
      }
      await recomputeDay(tx, A.employeeId, '2026-10-05', { weekPattern: 'six_day' })
      // Oct 6: short day -> half
      for (const [dir, at] of [['in', '09:30'], ['out', '14:30']] as const) {   // 300 gross − 60 break = 240 = half
        await recordPunch(tx, { employeeId: A.employeeId, punchedAt: ist('2026-10-06', at).toISOString(), localDate: '2026-10-06', direction: dir, source: 'mobile' })
      }
      await recomputeDay(tx, A.employeeId, '2026-10-06', { weekPattern: 'six_day' })
      // Oct 7, 8: late again (three late marks in the month with Oct 5 — no, Oct 6 was on time)
      for (const date of ['2026-10-07', '2026-10-08']) {
        for (const [dir, at] of [['in', '09:50'], ['out', '18:50']] as const) {   // 540 − 60 = 480 = full
          await recordPunch(tx, { employeeId: A.employeeId, punchedAt: ist(date, at).toISOString(), localDate: date, direction: dir, source: 'mobile' })
        }
        await recomputeDay(tx, A.employeeId, date, { weekPattern: 'six_day' })
      }
      // Oct 4 (Sunday): no punch -> weekly off from the SHIFT even under a six_day company pattern
      await recomputeDay(tx, A.employeeId, '2026-10-04', { weekPattern: 'six_day' })
      // Oct 10 (Saturday): shift says working; no punch -> absent
      await recomputeDay(tx, A.employeeId, '2026-10-10', { weekPattern: 'six_day' })

      const { rows } = await tx.query<{ work_date: string; status: string; day_fraction: string; late_minutes: number; ot_minutes: number; fraction_source: string }>(
        `SELECT work_date::text, status, day_fraction::text, late_minutes, ot_minutes, fraction_source FROM daily_attendance
          WHERE employee_id = $1 AND work_date BETWEEN '2026-10-01' AND '2026-10-31' ORDER BY work_date`, [A.employeeId])
      const by = Object.fromEntries(rows.map((r) => [r.work_date, r]))
      expect(by['2026-10-04']).toMatchObject({ status: 'weekly_off' })
      expect(by['2026-10-05']).toMatchObject({ status: 'present', day_fraction: '1.00', late_minutes: 25, ot_minutes: 45, fraction_source: 'shift' })
      expect(by['2026-10-06']).toMatchObject({ status: 'present', day_fraction: '0.50', late_minutes: 0 })
      expect(by['2026-10-07']).toMatchObject({ late_minutes: 5 })
      expect(by['2026-10-10']).toMatchObject({ status: 'absent' })
    })
  })

  it('the period summary proposes freeze rows: payable, LOP, OT, the late rule, and warnings', async () => {
    const policy = { unmarkedDayIsLop: false, lateMarksPerHalfDay: 3, weekPattern: 'six_day' as const, defaultStateCode: 'TS' }
    const [s] = await withTenant(A.id, (tx) => summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy }))
    expect(s!.calendarDays).toBe(31)
    // recorded: 4th off (paid), 5th full, 6th half (0.5 LOP), 7th, 8th full, 10th absent (1 LOP).
    // 25 unrecorded days: 3 are Sundays (off, paid), 22 are working days presumed paid.
    // three late marks (5th, 7th, 8th) -> one half day moves from payable to LOP
    expect(s!.lateMarks).toBe(3)
    expect(s!.lateHalfDays).toBe(0.5)
    expect(s!.lopDays).toBe(2)                     // 0.5 + 1 + 0.5
    expect(s!.payableDays).toBe(29)
    expect(s!.otMinutes).toBe(45)
    expect(s!.unmarkedDays).toBe(22)
    expect(s!.warnings.some((w) => /22 day/.test(w))).toBe(true)
    expect(s!.row).toMatchObject({ payableDays: 29, lopDays: 2, otMinutes: 45, stateCode: 'TS', monthlyComponents: { basic: L(25_000) } })

    const strict = await withTenant(A.id, (tx) => summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy: { ...policy, unmarkedDayIsLop: true, lateMarksPerHalfDay: 0 } }))
    // unrecorded working days become LOP; Sundays stay paid
    expect(strict[0]!.lopDays).toBe(1.5 + 22)
    expect(strict[0]!.lateHalfDays).toBe(0)
  })

  it('retiring a shift closes its roster rows and the person falls back to company policy', async () => {
    await withTenant(A.id, async (tx) => {
      const [gen] = await listShifts(tx)
      const r = await retireShift(tx, gen!.id, '2026-10-15')
      expect(r.rosteredNow).toBe(1)
      expect((await shiftFor(tx, A.employeeId, '2026-10-10'))?.code).toBe('GEN')   // history kept
      expect(await shiftFor(tx, A.employeeId, '2026-10-20')).toBeNull()
    })
  })
})
