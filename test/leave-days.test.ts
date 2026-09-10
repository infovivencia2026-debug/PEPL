/**
 * Counting a leave request.
 *
 * The number used to come from the browser. These pin the rules that replaced
 * it — especially the sandwich rule, which is the one employees notice and
 * argue about, and which was impossible to honour without a holiday calendar.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { countLeaveDays, holidaysBetween, LeaveCountError } from '../src/leave/days.ts'

let A: Tenant
let B: Tenant

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const count = (over: Partial<Parameters<typeof countLeaveDays>[0]> = {}) =>
  countLeaveDays({
    startDate: '2026-09-14',      // Monday
    endDate: '2026-09-16',        // Wednesday
    weekPattern: 'six_day',
    holidays: new Set<string>(),
    sandwich: false,
    ...over,
  })

describe('a plain request', () => {
  it('counts every working day', () => {
    expect(count().totalDays).toBe(3)
  })

  it('counts a single day', () => {
    expect(count({ startDate: '2026-09-14', endDate: '2026-09-14' }).totalDays).toBe(1)
  })

  it('refuses a range that runs backwards', () => {
    expect(() => count({ startDate: '2026-09-16', endDate: '2026-09-14' }))
      .toThrow(/end date is before/)
  })

  it('refuses an absurd range rather than looping', () => {
    expect(() => count({ startDate: '2020-01-01', endDate: '2030-01-01' }))
      .toThrow(/cannot span more than/)
  })
})

describe('half days', () => {
  it('charges a half day as 0.5', () => {
    expect(count({ dayParts: { '2026-09-15': 'first_half' } }).totalDays).toBe(2.5)
  })

  it('lets a day be excluded entirely', () => {
    expect(count({ dayParts: { '2026-09-15': 'none' } }).totalDays).toBe(2)
  })
})

describe('the working week is the company’s own', () => {
  it('skips Sunday on a six-day week', () => {
    // Sat 12th to Mon 14th: Sunday the 13th is not charged.
    const result = count({ startDate: '2026-09-12', endDate: '2026-09-14' })
    expect(result.totalDays).toBe(2)
    expect(result.skipped).toEqual([{ date: '2026-09-13', reason: 'weekly_off', charged: false }])
  })

  it('skips the whole weekend on a five-day week', () => {
    expect(count({ startDate: '2026-09-11', endDate: '2026-09-14', weekPattern: 'five_day' }).totalDays)
      .toBe(2)
  })

  it('charges every day on a roster, having no pattern to go by', () => {
    expect(count({ startDate: '2026-09-12', endDate: '2026-09-14', weekPattern: 'roster' }).totalDays)
      .toBe(3)
  })
})

describe('company holidays', () => {
  it('does not charge a holiday', () => {
    const result = count({ holidays: new Set(['2026-09-15']) })
    expect(result.totalDays).toBe(2)
    expect(result.skipped[0]).toEqual({ date: '2026-09-15', reason: 'holiday', charged: false })
  })

  it('refuses a request made entirely of non-working days', () => {
    expect(() => count({
      startDate: '2026-09-13', endDate: '2026-09-13', weekPattern: 'six_day',
    })).toThrow(LeaveCountError)
  })
})

describe('the sandwich rule', () => {
  // Fri 11th to Mon 14th, six-day week: Sunday the 13th sits between two leave days.
  const around = (sandwich: boolean) =>
    count({ startDate: '2026-09-11', endDate: '2026-09-14', sandwich })

  it('does not charge the day in between when the rule is off', () => {
    const result = around(false)
    expect(result.totalDays).toBe(3)   // Fri, Sat, Mon
    expect(result.skipped[0]!.charged).toBe(false)
  })

  it('charges it when the rule is on', () => {
    const result = around(true)
    expect(result.totalDays).toBe(4)
    expect(result.skipped[0]).toEqual({ date: '2026-09-13', reason: 'weekly_off', charged: true })
  })

  it('never charges a non-working day at the START of a leave', () => {
    // Sunday 13th then Monday 14th: the leave begins on Monday.
    const result = count({ startDate: '2026-09-13', endDate: '2026-09-14', sandwich: true })
    expect(result.totalDays).toBe(1)
    expect(result.skipped[0]!.charged).toBe(false)
  })

  it('never charges a non-working day at the END of a leave', () => {
    const result = count({ startDate: '2026-09-12', endDate: '2026-09-13', sandwich: true })
    expect(result.totalDays).toBe(1)
    expect(result.skipped[0]!.charged).toBe(false)
  })

  it('charges a holiday in the middle too, not just a weekly off', () => {
    const result = count({ sandwich: true, holidays: new Set(['2026-09-15']) })
    expect(result.totalDays).toBe(3)
  })
})

describe('the holiday calendar is per company', () => {
  const addHoliday = (tenantId: string, date: string, name: string, location?: string) =>
    withTenant(tenantId, (tx) =>
      tx.query(
        `INSERT INTO holidays (tenant_id, holiday_on, name, location) VALUES ($1,$2,$3,$4)`,
        [tenantId, date, name, location ?? null]))

  it('reads only this company’s holidays', async () => {
    await addHoliday(A.id, '2026-10-02', 'Gandhi Jayanti')
    await addHoliday(B.id, '2026-10-20', 'Diwali')

    const inA = await withTenant(A.id, (tx) =>
      holidaysBetween(tx, { startDate: '2026-10-01', endDate: '2026-10-31' }))
    expect([...inA]).toEqual(['2026-10-02'])

    const inB = await withTenant(B.id, (tx) =>
      holidaysBetween(tx, { startDate: '2026-10-01', endDate: '2026-10-31' }))
    expect([...inB]).toEqual(['2026-10-20'])
  })

  it('applies a location holiday only to that location', async () => {
    await addHoliday(A.id, '2026-11-01', 'Karnataka Rajyotsava', 'Bengaluru')

    const everyone = await withTenant(A.id, (tx) =>
      holidaysBetween(tx, { startDate: '2026-11-01', endDate: '2026-11-01' }))
    expect([...everyone]).toEqual([])

    const bengaluru = await withTenant(A.id, (tx) =>
      holidaysBetween(tx, { startDate: '2026-11-01', endDate: '2026-11-01', location: 'Bengaluru' }))
    expect([...bengaluru]).toEqual(['2026-11-01'])
  })

  it('leaves an optional holiday out of the count', async () => {
    await withTenant(A.id, (tx) =>
      tx.query(
        `INSERT INTO holidays (tenant_id, holiday_on, name, is_optional)
         VALUES ($1,'2026-12-24','Christmas Eve (optional)',true)`, [A.id]))

    const dates = await withTenant(A.id, (tx) =>
      holidaysBetween(tx, { startDate: '2026-12-24', endDate: '2026-12-24' }))
    expect([...dates]).toEqual([])
  })

  it('refuses the same date twice for the same audience', async () => {
    await addHoliday(A.id, '2026-10-02', 'Gandhi Jayanti')
    await expect(addHoliday(A.id, '2026-10-02', 'Duplicate'))
      .rejects.toThrow(/duplicate key|unique/i)
  })
})
