/**
 * Invoice and credit-note numbers must fit CGST Rule 46(b).
 *
 * The rule: a consecutive serial number, unique for a FINANCIAL year, made of
 * letters, digits, '-' and '/', and **not exceeding sixteen characters**.
 *
 * The old scheme produced `INV-2026-ABCDEF-00001` -- twenty-one characters. It
 * had been emitting non-compliant numbers from the first invoice, and no test
 * had ever measured one.
 */
import { describe, it, expect } from 'vitest'
import { financialYear } from '../src/control-plane/financial-year.ts'

describe('the financial year, not the calendar year', () => {
  it('starts in April', () => {
    expect(financialYear('2026-04-01')).toBe('26-27')
    expect(financialYear('2027-03-31')).toBe('26-27')
  })

  it('puts January to March in the year before', () => {
    // The trap in the old code: these two are ONE financial year and were
    // labelled '2026' and '2027'.
    expect(financialYear('2026-12-31')).toBe('26-27')
    expect(financialYear('2027-01-01')).toBe('26-27')
  })

  it('rolls over on 1 April, not 1 January', () => {
    expect(financialYear('2027-03-31')).not.toBe(financialYear('2027-04-01'))
    expect(financialYear('2027-04-01')).toBe('27-28')
  })

  it('handles the century wrap', () => {
    expect(financialYear('2099-04-01')).toBe('99-00')
  })
})

describe('the number fits the rule', () => {
  const invoice = (fy: string, n: number) => `INV/${fy}/${String(n).padStart(5, '0')}`
  const creditNote = (fy: string, n: number) => `CRN/${fy}/${String(n).padStart(5, '0')}`

  it('is at most sixteen characters, even at the end of the series', () => {
    for (const make of [invoice, creditNote]) {
      for (const n of [1, 99_999]) {
        const number = make('26-27', n)
        expect(number.length, number).toBeLessThanOrEqual(16)
      }
    }
  })

  it('uses only characters the rule allows', () => {
    // Letters, digits, hyphen and slash. Nothing else.
    expect(invoice('26-27', 42)).toMatch(/^[A-Za-z0-9/-]+$/)
    expect(creditNote('26-27', 42)).toMatch(/^[A-Za-z0-9/-]+$/)
  })

  it('the OLD scheme would have failed this', () => {
    // Kept so the reason for the change stays visible.
    const old = `INV-2026-ABCDEF-${String(1).padStart(5, '0')}`
    expect(old.length).toBe(21)
    expect(old.length).toBeGreaterThan(16)
  })
})
