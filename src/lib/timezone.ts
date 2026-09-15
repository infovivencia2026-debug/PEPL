/**
 * The company's clock.
 *
 * Every date PEPL stores for a human — the day a punch belongs to, the day a
 * leave starts, "today" in a correction window — is a LOCAL date in the
 * company's timezone, not UTC. The product was written for India and hard-coded
 * +05:30 in one place (shift evaluation) while using `toISOString()` for
 * "today" everywhere else, which is the same thing until 05:30 IST, when a
 * punch at 05:00 belongs to yesterday by one rule and today by the other.
 *
 * This resolves an IANA zone to its offset ON A GIVEN INSTANT (so a company in
 * a DST zone is right in both halves of the year) using Intl, which Node has
 * built in — no tz database to ship or keep current.
 */

/** Minutes east of UTC for `zone` at `at`. Asia/Kolkata → 330. */
export function offsetMinutes(zone: string, at: Date = new Date()): number {
  try {
    // 'shortOffset' gives "GMT+5:30"; parse it rather than trusting a fixed table.
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
      .formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? 'GMT+0'
    const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name)
    if (!m) return 0
    const sign = m[1] === '-' ? -1 : 1
    return sign * (Number(m[2]) * 60 + Number(m[3] ?? 0))
  } catch {
    // An unknown zone is a misconfiguration, not a reason to stop payroll.
    return 0
  }
}

export function isValidZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    return true
  } catch {
    return false
  }
}

/** The local calendar date of an instant, in `zone`. */
export function localDate(at: Date, zone: string): string {
  return new Date(at.getTime() + offsetMinutes(zone, at) * 60_000).toISOString().slice(0, 10)
}

/** Today, in the company's zone. What every "is this in the window" check should use. */
export function today(zone: string, now: Date = new Date()): string {
  return localDate(now, zone)
}

/** The instant a local wall-clock time falls on, e.g. 09:30 on 2026-10-05 in Asia/Kolkata. */
export function instantAt(date: string, hhmm: string, zone: string): Date {
  const guess = new Date(`${date}T${hhmm.length === 5 ? hhmm + ':00' : hhmm}Z`)
  // Offset depends on the instant (DST), so resolve once against the guess and
  // once against the result; two passes settle every real zone.
  const first = new Date(guess.getTime() - offsetMinutes(zone, guess) * 60_000)
  return new Date(guess.getTime() - offsetMinutes(zone, first) * 60_000)
}
