import { describe, it, expect } from 'vitest'
import {
  computeTds, fiscalYearOf, monthsRemainingInFY, taxOnIncome,
  type TaxRules, type TaxSlab,
} from '../src/payroll/tds.ts'

const L = (rupees: number): number => rupees * 100
const S = (from: number, to: number | null, rate: number): TaxSlab => ({
  income_from_paise: String(L(from)),
  income_to_paise: to === null ? null : String(L(to)),
  rate: String(rate),
})

/** A representative new-regime shape: a nil band, then rising slabs. */
const NEW_SLABS: TaxSlab[] = [
  S(0, 400_000, 0),
  S(400_000, 800_000, 0.05),
  S(800_000, 1_200_000, 0.10),
  S(1_200_000, 1_600_000, 0.15),
  S(1_600_000, 2_000_000, 0.20),
  S(2_000_000, 2_400_000, 0.25),
  S(2_400_000, null, 0.30),
]

const NEW_RULES: TaxRules = {
  standard_deduction_paise: String(L(75_000)),
  rebate_limit_paise: String(L(1_200_000)),
  rebate_max_paise: String(L(60_000)),
  cess_rate: '0.04',
  surcharge_bands: [
    { above_paise: L(5_000_000), rate: 0.10 },
    { above_paise: L(10_000_000), rate: 0.15 },
  ],
}

describe('slab arithmetic', () => {
  it('applies each band only to the income inside it', () => {
    // 10,00,000: nothing on the first 4L, 5% on the next 4L, 10% on the last 2L
    expect(taxOnIncome(L(1_000_000), NEW_SLABS)).toBe(L(20_000) + L(20_000))
  })

  it('is zero inside the nil band', () => {
    expect(taxOnIncome(L(350_000), NEW_SLABS)).toBe(0)
  })

  it('charges the open-ended top band', () => {
    const tax = taxOnIncome(L(3_000_000), NEW_SLABS)
    const upToTop = L(20_000) + L(40_000) + L(60_000) + L(80_000) + L(100_000)
    expect(tax).toBe(upToTop + L(600_000) * 0.30)
  })

  it('an empty slab set yields no tax rather than throwing', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(100_000)), monthsRemaining: 12, regime: 'new' },
      [], NEW_RULES)
    expect(r.monthlyTdsPaise).toBe(0n)
    expect(r.trace.reason).toMatch(/no slabs configured/)
  })
})

describe('the 87A rebate is why low earners pay nothing', () => {
  it('a salary under the rebate limit pays no TDS at all', () => {
    // 60,000/month = 7.2L projected, minus 75k standard deduction = 6.45L
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(60_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.taxableIncomePaise).toBe(BigInt(L(645_000)))
    expect(Number(r.trace.slabTax)).toBeGreaterThan(0)
    expect(r.monthlyTdsPaise).toBe(0n)
    expect(Number(r.trace.rebate87A)).toBeGreaterThan(0)
  })

  it('just above the limit, tax becomes payable', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(120_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.monthlyTdsPaise).toBeGreaterThan(0n)
    expect(Number(r.trace.rebate87A)).toBe(0)
  })
})

describe('projection and spreading', () => {
  it('spreads the annual liability across the months that remain', () => {
    const full = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    const half = computeTds(
      {
        monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 6,
        earnedToDatePaise: BigInt(L(1_200_000)),
        regime: 'new',
      },
      NEW_SLABS, NEW_RULES)
    // Same projected year, half the months left -> roughly double the monthly cut
    expect(full.projectedAnnualIncomePaise).toBe(half.projectedAnnualIncomePaise)
    expect(Number(half.monthlyTdsPaise)).toBeGreaterThan(Number(full.monthlyTdsPaise) * 1.8)
  })

  it('credits TDS already deducted this year', () => {
    const base = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 6,
        earnedToDatePaise: BigInt(L(1_200_000)), regime: 'new' },
      NEW_SLABS, NEW_RULES)
    const credited = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 6,
        earnedToDatePaise: BigInt(L(1_200_000)),
        deductedToDatePaise: BigInt(L(50_000)), regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(Number(credited.monthlyTdsPaise)).toBeLessThan(Number(base.monthlyTdsPaise))
  })

  it('never returns a negative deduction when too much was already taken', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(100_000)), monthsRemaining: 2,
        deductedToDatePaise: BigInt(L(10_000_000)), regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.monthlyTdsPaise).toBe(0n)
  })
})

describe('regime differences', () => {
  it('declared investments reduce tax under the OLD regime', () => {
    const withoutDecl = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(150_000)), monthsRemaining: 12, regime: 'old' },
      NEW_SLABS, NEW_RULES)
    const withDecl = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(150_000)), monthsRemaining: 12,
        declaredDeductionsPaise: BigInt(L(150_000)), regime: 'old' },
      NEW_SLABS, NEW_RULES)
    expect(Number(withDecl.monthlyTdsPaise)).toBeLessThan(Number(withoutDecl.monthlyTdsPaise))
  })

  it('declared investments are ignored under the NEW regime', () => {
    const a = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(150_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    const b = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(150_000)), monthsRemaining: 12,
        declaredDeductionsPaise: BigInt(L(150_000)), regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(b.monthlyTdsPaise).toBe(a.monthlyTdsPaise)
  })
})

describe('surcharge and cess', () => {
  it('applies surcharge above the band and cess on top', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(600_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.trace.surchargeRate).toBe(0.10)
    expect(Number(r.trace.cess)).toBeGreaterThan(0)
    expect(Number(r.trace.annualTax)).toBeGreaterThan(Number(r.trace.slabTax))
  })

  it('no surcharge below the first band', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.trace.surchargeRate).toBe(0)
  })
})

describe('the calculation is explainable', () => {
  it('records every step, because a disputed TDS figure is unanswerable otherwise', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(Object.keys(r.trace)).toEqual(expect.arrayContaining([
      'regime', 'projected', 'standardDeduction', 'taxable',
      'slabTax', 'rebate87A', 'surcharge', 'cess', 'annualTax', 'monthsRemaining',
    ]))
  })

  it('states what it does not model, rather than implying completeness', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(200_000)), monthsRemaining: 12, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(r.limitations.join(' ')).toMatch(/Chapter VI-A/)
  })

  it('rounds the monthly deduction to whole rupees', () => {
    const r = computeTds(
      { monthlyTaxableGrossPaise: BigInt(L(133_333)), monthsRemaining: 7, regime: 'new' },
      NEW_SLABS, NEW_RULES)
    expect(Number(r.monthlyTdsPaise) % 100).toBe(0)
  })
})

describe('fiscal year helpers', () => {
  it('April starts the year with 12 months remaining', () => {
    expect(monthsRemainingInFY(new Date('2026-04-15'))).toBe(12)
    expect(fiscalYearOf(new Date('2026-04-15'))).toBe('2026-27')
  })

  it('March is the last month', () => {
    expect(monthsRemainingInFY(new Date('2027-03-10'))).toBe(1)
    expect(fiscalYearOf(new Date('2027-03-10'))).toBe('2026-27')
  })

  it('September sits mid-year', () => {
    expect(monthsRemainingInFY(new Date('2026-09-09'))).toBe(7)
  })
})
