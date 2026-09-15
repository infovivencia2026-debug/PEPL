/**
 * The company's clock: offsets come from Intl (so DST is right in both halves
 * of the year), "today" is local, and a shift's clock times are read in the
 * company's zone — a Dubai 09:00 is not an India 09:00.
 */
import { describe, it, expect } from 'vitest'
import { instantAt, isValidZone, localDate, offsetMinutes, today } from '../src/lib/timezone.ts'
import { evaluateShiftDay } from '../src/attendance/shifts.ts'

const GEN = {
  start_time: '09:00:00', end_time: '18:00:00', grace_in_min: 10, grace_out_min: 0, break_min: 60,
  full_day_min: 480, half_day_min: 240, ot_after_min: 30, ot_eligible: true, weekly_off_days: [0],
}

describe('offsets', () => {
  it('reads IANA zones, including half-hour and DST ones', () => {
    expect(offsetMinutes('Asia/Kolkata')).toBe(330)
    expect(offsetMinutes('Asia/Dubai')).toBe(240)
    expect(offsetMinutes('UTC')).toBe(0)
    expect(offsetMinutes('Asia/Kathmandu')).toBe(345)
    // New York is −5 in January and −4 in July; a fixed table gets one of them wrong
    expect(offsetMinutes('America/New_York', new Date('2027-01-15T12:00:00Z'))).toBe(-300)
    expect(offsetMinutes('America/New_York', new Date('2027-07-15T12:00:00Z'))).toBe(-240)
    // an unknown zone does not throw; it degrades to UTC
    expect(offsetMinutes('Mars/Olympus')).toBe(0)
    expect(isValidZone('Asia/Kolkata')).toBe(true)
    expect(isValidZone('Mars/Olympus')).toBe(false)
  })

  it('local dates and "today" follow the zone, not the server', () => {
    // 20:00 UTC on the 14th is already the 15th in India, still the 14th in New York
    const at = new Date('2026-09-14T20:00:00Z')
    expect(localDate(at, 'Asia/Kolkata')).toBe('2026-09-15')
    expect(localDate(at, 'UTC')).toBe('2026-09-14')
    expect(localDate(at, 'America/New_York')).toBe('2026-09-14')
    // and the reverse: 02:00 UTC is still yesterday evening in New York
    expect(localDate(new Date('2026-09-15T02:00:00Z'), 'America/New_York')).toBe('2026-09-14')
    expect(today('Asia/Kolkata', at)).toBe('2026-09-15')
  })

  it('a wall-clock time resolves to the right instant, in and out of DST', () => {
    expect(instantAt('2026-10-05', '09:30', 'Asia/Kolkata').toISOString()).toBe('2026-10-05T04:00:00.000Z')
    expect(instantAt('2026-10-05', '09:30', 'Asia/Dubai').toISOString()).toBe('2026-10-05T05:30:00.000Z')
    expect(instantAt('2027-01-15', '09:00', 'America/New_York').toISOString()).toBe('2027-01-15T14:00:00.000Z')
    expect(instantAt('2027-07-15', '09:00', 'America/New_York').toISOString()).toBe('2027-07-15T13:00:00.000Z')
  })
})

describe('shifts read the company clock', () => {
  it('the same punch is on time in one zone and late in another', () => {
    // 09:05 local in Dubai = 05:05Z; in India 09:05 local = 03:35Z
    const dubaiOnTime = new Date('2026-10-05T05:05:00Z')
    expect(evaluateShiftDay(GEN, '2026-10-05', { firstIn: dubaiOnTime, lastOut: null }, 'Asia/Dubai').lateMinutes).toBe(0)
    // the same instant, judged against an Indian 09:00, is 05:05 + 5:30 = 10:35 local — 85 late, 75 after grace
    expect(evaluateShiftDay(GEN, '2026-10-05', { firstIn: dubaiOnTime, lastOut: null }, 'Asia/Kolkata').lateMinutes).toBe(85)
  })

  it('a full day in Dubai measures the same minutes as in India, just shifted', () => {
    const d = evaluateShiftDay(GEN, '2026-10-05',
      { firstIn: instantAt('2026-10-05', '09:00', 'Asia/Dubai'), lastOut: instantAt('2026-10-05', '18:30', 'Asia/Dubai') }, 'Asia/Dubai')
    expect(d.lateMinutes).toBe(0)
    expect(d.netWorkedMinutes).toBe(9 * 60 + 30 - 60)
    expect(d.dayFraction).toBe(1)
    expect(d.otMinutes).toBe(30)
    // an explicit offset still works, which is what the older tests pass
    expect(evaluateShiftDay(GEN, '2026-10-05', { firstIn: instantAt('2026-10-05', '09:00', 'Asia/Kolkata'), lastOut: null }, 330).lateMinutes).toBe(0)
  })
})
