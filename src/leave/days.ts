/**
 * How many days a leave request actually costs.
 *
 * This used to be a number the browser sent. That is a trust problem — a
 * request spanning a week could claim half a day — and it made
 * `leave.sandwich_holidays` impossible to honour, because a rule about holidays
 * inside a leave needs to know which days are holidays.
 *
 * The count is derived here, from the dates, the company's working week, its
 * holiday calendar and its sandwich rule. The client may still send a number;
 * the server compares and rejects a mismatch rather than trusting it.
 */
import type { PoolClient } from 'pg'
import { isWeeklyOff, type DayPolicy } from '../attendance/index.ts'

export class LeaveCountError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'LeaveCountError'
  }
}

/** What a single date costs. */
export type DayPart = 'full' | 'first_half' | 'second_half' | 'none'

export interface CountInput {
  startDate: string
  endDate: string
  /** Per-date overrides: {"2026-09-15":"first_half"}. Absent means a full day. */
  dayParts?: Record<string, string>
  weekPattern: DayPolicy['weekPattern']
  /** Dates the company is closed, as YYYY-MM-DD. */
  holidays: ReadonlySet<string>
  /**
   * When true, a weekly off or holiday BETWEEN two leave days is itself
   * deducted — the "sandwich" rule. Leading and trailing non-working days are
   * never charged under either setting: nobody takes leave on a Sunday to start
   * a holiday on Monday.
   */
  sandwich: boolean
}

export interface CountResult {
  totalDays: number
  workingDays: string[]
  /** Non-working dates inside the range, and whether each was charged. */
  skipped: { date: string; reason: 'weekly_off' | 'holiday'; charged: boolean }[]
}

const MAX_RANGE_DAYS = 366

function eachDate(startDate: string, endDate: string): string[] {
  const out: string[] = []
  const start = Date.parse(`${startDate}T00:00:00Z`)
  const end = Date.parse(`${endDate}T00:00:00Z`)
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new LeaveCountError('INVALID_DAYS', 'start and end must be YYYY-MM-DD dates')
  }
  if (end < start) {
    throw new LeaveCountError('INVALID_DAYS', 'the end date is before the start date')
  }
  for (let t = start; t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10))
    if (out.length > MAX_RANGE_DAYS) {
      throw new LeaveCountError('INVALID_DAYS', `a leave request cannot span more than ${MAX_RANGE_DAYS} days`)
    }
  }
  return out
}

function costOf(part: string | undefined): number {
  if (part === 'none') return 0
  if (part === 'first_half' || part === 'second_half' || part === 'half') return 0.5
  return 1
}

/**
 * Counts the request.
 *
 * A non-working day is skipped unless the sandwich rule applies AND it sits
 * between two charged days — the leading/trailing case is deliberately never
 * charged, because deducting a Sunday at the front of a Monday holiday is the
 * behaviour employees rightly complain about.
 */
export function countLeaveDays(input: CountInput): CountResult {
  const dates = eachDate(input.startDate, input.endDate)
  const skipped: CountResult['skipped'] = []

  const nonWorking = (date: string): 'weekly_off' | 'holiday' | null => {
    if (input.holidays.has(date)) return 'holiday'
    if (isWeeklyOff(date, input.weekPattern)) return 'weekly_off'
    return null
  }

  // First pass: which dates are workable at all, and what each costs.
  const working: string[] = []
  const cost = new Map<string, number>()
  for (const date of dates) {
    const reason = nonWorking(date)
    if (reason) continue
    const dayCost = costOf(input.dayParts?.[date])
    if (dayCost > 0) {
      working.push(date)
      cost.set(date, dayCost)
    }
  }

  if (working.length === 0) {
    throw new LeaveCountError(
      'INVALID_DAYS',
      'this range contains no working days — nothing would be deducted',
      { startDate: input.startDate, endDate: input.endDate },
    )
  }

  let total = 0
  for (const value of cost.values()) total += value

  // Second pass: the sandwich rule, applied only between the first and last
  // charged day.
  const firstWorking = working[0]!
  const lastWorking = working[working.length - 1]!
  for (const date of dates) {
    const reason = nonWorking(date)
    if (!reason) continue
    const inside = date > firstWorking && date < lastWorking
    const charged = input.sandwich && inside
    if (charged) total += 1
    skipped.push({ date, reason, charged })
  }

  return { totalDays: Math.round(total * 100) / 100, workingDays: working, skipped }
}

/** The company's holiday dates in a range, for a location if one is given. */
export async function holidaysBetween(
  tx: PoolClient,
  args: { startDate: string; endDate: string; location?: string | null },
): Promise<Set<string>> {
  const { rows } = await tx.query<{ holiday_on: string }>(
    `SELECT holiday_on::text FROM holidays
      WHERE holiday_on BETWEEN $1::date AND $2::date
        AND NOT is_optional
        AND (location IS NULL OR location = $3)`,
    [args.startDate, args.endDate, args.location ?? null],
  )
  return new Set(rows.map((r) => r.holiday_on))
}
