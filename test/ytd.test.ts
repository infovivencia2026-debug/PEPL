/** "YTD" tiles summed ONE run's payslips. They must sum the financial year (UI1-03). */
import { describe, it, expect } from 'vitest'
import { financialYearStart, ytdTotals } from '../web/src/pay/ytd.ts'

const slip = (period_start: string, g: number, n: number) => ({ period_start, gross_paise: String(g), net_paise: String(n) })

describe('year to date', () => {
  it('the financial year starts on 1 April', () => {
    expect(financialYearStart('2026-09-30')).toBe('2026-04-01')
    expect(financialYearStart('2027-02-10')).toBe('2026-04-01')
    expect(financialYearStart('2026-04-01')).toBe('2026-04-01')
  })
  it('sums every payslip in the year, and none from the last one', () => {
    const t = ytdTotals([slip('2026-03-01', 999, 999), slip('2026-04-01', 100, 80), slip('2026-05-01', 100, 80), slip('2026-09-01', 120, 90)], '2026-09-30')
    expect(t).toEqual({ gross: 320n, net: 250n, count: 3 })
  })
});
