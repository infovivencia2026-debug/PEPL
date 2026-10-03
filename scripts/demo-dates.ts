/**
 * Dates for the demo company's pending leave requests.
 *
 * The seed asked for "today + N days". Whenever that fell on a Saturday or Sunday -- a single-day
 * request like 'Passport appointment' on a weekend -- applyLeave answered LEAVE_NO_WORKING_DAYS and the
 * whole seed aborted, so the demo could be built on some days of the week and not on others.
 * Requests now start and end on working days, whatever day the seed runs.
 */
const DAY = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)
const at = (date: string): number => Date.parse(`${date}T00:00:00Z`)

/** The date itself if it is Monday-Friday, otherwise the following Monday. */
export function nextWorkday(date: string): string {
  const dow = new Date(at(date)).getUTCDay()           // 0 Sun .. 6 Sat
  return iso(at(date) + (dow === 6 ? 2 : dow === 0 ? 1 : 0) * DAY)
}

/** The Friday-or-earlier working day on or before `date` (a range must not END on a weekend). */
export function previousWorkday(date: string): string {
  const dow = new Date(at(date)).getUTCDay()
  return iso(at(date) - (dow === 6 ? 1 : dow === 0 ? 2 : 0) * DAY)
}

/** A leave range from `today + from` to `today + to`, shrunk or moved so it begins and ends on working days. */
export function leaveRange(today: string, from: number, to: number): { startDate: string; endDate: string } {
  const startDate = nextWorkday(iso(at(today) + from * DAY))
  const endCandidate = previousWorkday(iso(at(today) + to * DAY))
  return { startDate, endDate: endCandidate < startDate ? startDate : endCandidate }
}
