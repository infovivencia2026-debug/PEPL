/**
 * The Indian financial year: 1 April to 31 March.
 *
 * Invoice numbering must be unique within a FINANCIAL year (CGST Rule 46(b)),
 * and the old code took a calendar year off the period end date. That is a
 * different unit: an invoice for the period ending 31 March 2027 and one
 * ending 30 April 2027 are in different financial years while sharing the
 * calendar label "2027", and one ending December 2026 shares a financial year
 * with March 2027 while carrying a different label.
 */

/** '2027-03-31' -> '26-27'; '2027-04-01' -> '27-28'. */
export function financialYear(isoDate: string): string {
  const [y, m] = isoDate.split('-').map(Number)
  if (!y || !m) throw new Error(`not a date: ${isoDate}`)
  // April starts it. January to March belong to the year before.
  const start = m >= 4 ? y : y - 1
  const two = (n: number) => String(n % 100).padStart(2, '0')
  return `${two(start)}-${two(start + 1)}`
}
