/** Year-to-date for a person's payslips: the Indian financial year (1 April) that `today` falls in. */
export const financialYearStart = (today: string): string => {
  const [y, m] = today.split('-').map(Number) as [number, number]
  return `${m >= 4 ? y : y - 1}-04-01`
}

export function ytdTotals(
  payslips: ReadonlyArray<{ period_start: string; gross_paise: string; net_paise: string }>, today: string,
): { gross: bigint; net: bigint; count: number } {
  const from = financialYearStart(today)
  const inYear = payslips.filter((s) => s.period_start >= from && s.period_start <= today)
  return {
    gross: inYear.reduce((n, s) => n + BigInt(s.gross_paise), 0n),
    net: inYear.reduce((n, s) => n + BigInt(s.net_paise), 0n),
    count: inYear.length,
  }
}
