import type { FreezeRow } from './run.ts'

/**
 * The shape of the rows a caller sends to freeze a run. The v1 route passed the body straight through
 * (`as never`), so a negative day count, a string for an amount, a duplicate employee or a missing
 * component map reached the engine and surfaced as a wrong payslip -- or a crash -- instead of a 422.
 * Returns the list of problems; empty means every row is well formed.
 */
export function freezeRowProblems(rows: unknown): string[] {
  if (!Array.isArray(rows)) return ['rows must be an array']
  if (rows.length === 0) return ['rows is empty']
  if (rows.length > 5000) return ['too many rows (5000 at most per call)']
  const problems: string[] = []
  const seen = new Set<string>()
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  rows.forEach((raw, i) => {
    const at = `rows[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${at} must be an object`); return }
    const r = raw as Record<string, unknown>
    if (typeof r.employeeId !== 'string' || !UUID.test(r.employeeId)) problems.push(`${at}.employeeId must be a uuid`)
    else if (seen.has(r.employeeId)) problems.push(`${at}.employeeId appears twice`)
    else seen.add(r.employeeId)
    const num = (k: string, max = Number.MAX_SAFE_INTEGER): number | null => {
      const v = r[k]
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > max) { problems.push(`${at}.${k} must be a number from 0 to ${max}`); return null }
      return v
    }
    const cal = num('calendarDays', 31), pay = num('payableDays', 31), lop = num('lopDays', 31)
    if (cal !== null && pay !== null && lop !== null && pay + lop > cal + 1e-9) problems.push(`${at}: payableDays + lopDays exceeds calendarDays`)
    num('annualCtcPaise')
    const mc = r.monthlyComponents
    if (!mc || typeof mc !== 'object' || Array.isArray(mc) || Object.keys(mc).length === 0) problems.push(`${at}.monthlyComponents must be a non-empty object`)
    else for (const [k, v] of Object.entries(mc)) if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) problems.push(`${at}.monthlyComponents.${k} must be a non-negative number`)
    if (typeof r.stateCode !== 'string' || !/^[A-Z]{2}$/.test(r.stateCode)) problems.push(`${at}.stateCode must be a two-letter state code`)
  })
  return problems.slice(0, 20)
}

export type { FreezeRow }
