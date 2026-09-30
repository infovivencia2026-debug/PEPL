import type { PoolClient } from 'pg'
import { periodFor } from './index.ts'
import { today as localToday } from '../lib/timezone.ts'

/**
 * Which day a punch may belong to.
 *
 * The route took the day from the request body, so an in-punch dated any past or future day
 * marked that day present -- inside a period payroll had already closed. Now the SERVER decides
 * what today is, in the company's own timezone, and a punch belongs to it. The single
 * exception is the small hours after midnight: a night shift punching OUT belongs to the day it
 * started, and is accepted for yesterday when (and only when) there is an open in-punch to close.
 *
 * Whether the day's period still accepts changes is checked here too: recomputing a day never
 * asked, which is how a frozen period could be edited by punching into it.
 */
export class PunchWindowError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PunchWindowError'
  }
}

const shift = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

export async function assertPunchWindow(
  tx: PoolClient,
  args: { employeeId: string; localDate: string; direction: 'in' | 'out'; timezone: string; now?: Date },
): Promise<void> {
  const today = localToday(args.timezone, args.now)
  if (args.localDate !== today) {
    const closesYesterdaysShift =
      args.direction === 'out' && args.localDate === shift(today, -1) && await hasOpenIn(tx, args.employeeId, args.localDate)
    if (!closesYesterdaysShift) {
      throw new PunchWindowError('DATE_OUT_OF_WINDOW',
        `a punch belongs to today (${today}); ${args.localDate} is not open for punching. Ask HR to correct that day.`)
    }
  }
  const period = await periodFor(tx, args.localDate)
  if (period && period.status !== 'open') {
    throw new PunchWindowError('PERIOD_CLOSED', `the attendance period covering ${args.localDate} is ${period.status}`)
  }
}

/** The person's latest punch that day is an IN with nothing after it: a shift still running. */
async function hasOpenIn(tx: PoolClient, employeeId: string, localDate: string): Promise<boolean> {
  const { rows } = await tx.query<{ direction: string }>(
    `SELECT direction FROM attendance_punches WHERE employee_id = $1 AND local_date = $2 ORDER BY punched_at DESC LIMIT 1`,
    [employeeId, localDate])
  return rows[0]?.direction === 'in'
}
