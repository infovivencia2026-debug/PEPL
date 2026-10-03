/** The demo seed must build on any day of the week (leave dates used to land on weekends and abort it). */
import { describe, it, expect } from 'vitest'
import { nextWorkday, previousWorkday, leaveRange } from '../scripts/demo-dates.ts'

const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay()
const REQUESTS: Array<[number, number]> = [[21, 23], [28, 28], [35, 39]]   // as in scripts/seed-demo.ts

describe('working-day helpers', () => {
  it('nextWorkday moves a weekend forward to Monday and leaves weekdays alone', () => {
    expect(nextWorkday('2026-10-03')).toBe('2026-10-05')     // Saturday -> Monday
    expect(nextWorkday('2026-10-04')).toBe('2026-10-05')     // Sunday -> Monday
    expect(nextWorkday('2026-10-05')).toBe('2026-10-05')
    expect(nextWorkday('2026-10-09')).toBe('2026-10-09')     // Friday
  })
  it('previousWorkday moves a weekend back to Friday', () => {
    expect(previousWorkday('2026-10-03')).toBe('2026-10-02')
    expect(previousWorkday('2026-10-04')).toBe('2026-10-02')
    expect(previousWorkday('2026-10-07')).toBe('2026-10-07')
  })
})

describe('the demo leave requests', () => {
  it('begin and end on working days whichever day of the week the seed runs, across a full year', () => {
    const start = Date.parse('2026-01-01T00:00:00Z')
    for (let i = 0; i < 400; i++) {
      const today = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
      for (const [from, to] of REQUESTS) {
        const r = leaveRange(today, from, to)
        expect([0, 6], `${today} ${from}-${to} starts ${r.startDate}`).not.toContain(dow(r.startDate))
        expect([0, 6], `${today} ${from}-${to} ends ${r.endDate}`).not.toContain(dow(r.endDate))
        expect(r.endDate >= r.startDate).toBe(true)
      }
    }
  })
  it('a single-day request on a weekend becomes one working day, never an empty range', () => {
    const r = leaveRange('2026-09-05', 28, 28)                 // 28 days after a Saturday = a Saturday
    expect(r.startDate).toBe(r.endDate)
    expect(dow(r.startDate)).toBe(1)
  })
})
