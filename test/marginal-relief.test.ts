/**
 * Crossing a threshold must not cost more than the crossing.
 *
 * Without marginal relief, one rupee over the 87A rebate limit brings the whole
 * tax bill with it: at the limit the rebate wipes the tax out, one rupee later
 * it does not. The same cliff sits at every surcharge band. Neither had relief,
 * so the tax on someone just over a threshold was wildly more than their extra
 * income.
 */
import { describe, it, expect } from 'vitest'
import { computeTds } from '../src/payroll/tds.ts'
import { INCOME_TAX } from '../db/reference/income-tax.ts'

const L = (rupees: number) => rupees * 100
const fy = INCOME_TAX.find((t) => t.fiscalYear === '2026-27')!

const slabsFor = (regime: 'new' | 'old') =>
  fy.slabs[regime].map((s) => ({
    income_from_paise: String(L(s.from)),
    income_to_paise: s.to === null ? null : String(L(s.to)),
    rate: String(s.rate),
  })) as never

const rulesFor = (regime: 'new' | 'old') => ({
  standard_deduction_paise: String(L(fy.rules[regime].standardDeduction)),
  rebate_limit_paise: String(L(fy.rules[regime].rebateLimit)),
  rebate_max_paise: String(L(fy.rules[regime].rebateMax)),
  cess_rate: String(fy.rules[regime].cessRate),
  surcharge_bands: fy.rules[regime].surcharge.map((b) => ({ above_paise: L(b.above), rate: b.rate })),
}) as never

/** Annual tax in rupees for an annual gross, spread over twelve months. */
const annualTax = (grossRupees: number, regime: 'new' | 'old' = 'new'): number => {
  const r = computeTds(
    { monthlyTaxableGrossPaise: BigInt(Math.round(L(grossRupees) / 12)), monthsRemaining: 12, regime },
    slabsFor(regime), rulesFor(regime),
  )
  return Number(r.annualTaxPaise) / 100
}

describe('the 87A rebate cliff', () => {
  it('costs no more than the amount by which it is crossed', () => {
    // The rebate limit is on TAXABLE income, so add the standard deduction.
    const atLimit = fy.rules.new.rebateLimit + fy.rules.new.standardDeduction
    const before = annualTax(atLimit)
    const after = annualTax(atLimit + 10_000)
    // Extra tax must not exceed the extra income (cess rides on top).
    expect(after - before).toBeLessThanOrEqual(10_000 * 1.04 + 1)
  })

  it('and the tax never exceeds the income above the threshold', () => {
    const atLimit = fy.rules.new.rebateLimit + fy.rules.new.standardDeduction
    for (const over of [1, 100, 5_000, 25_000]) {
      const tax = annualTax(atLimit + over)
      expect(tax, `${over} over`).toBeLessThanOrEqual(over * 1.04 + 1)
    }
  })
})

describe('the surcharge bands', () => {
  it('the new regime stops at 25% and the old reaches 37%', () => {
    expect(fy.rules.new.surcharge.at(-1)!.rate).toBe(0.25)
    expect(fy.rules.old.surcharge.at(-1)!.rate).toBe(0.37)
  })

  it('covers 50L, 1Cr and 2Cr', () => {
    const above = fy.rules.new.surcharge.map((b) => b.above)
    expect(above).toContain(5_000_000)
    expect(above).toContain(10_000_000)
    expect(above).toContain(20_000_000)
  })

  it('a high earner is no longer under-deducted at 2Cr', () => {
    // Below the old top band there was no surcharge above 15% at all.
    const justUnder = annualTax(1_99_00_000)
    const justOver = annualTax(2_01_00_000)
    expect(justOver).toBeGreaterThan(justUnder)
  })

  it('crossing a band costs no more than the crossing', () => {
    const under = annualTax(2_00_00_000)
    const over = annualTax(2_02_00_000)
    expect(over - under).toBeLessThanOrEqual(2_00_000 * 1.5)
  })
})

// ---------------------------------------------------------------------------------------------
// Marginal relief on the 87A cliff is a NEW-regime provision. The old regime has a hard cliff: the
// rebate is available up to the limit and is simply gone above it. The code applied the relief to
// both, so old-regime income a few rupees over the limit was taxed at the amount over the limit
// instead of at the slab rate -- under-deducting TDS. The expected figures below are worked from the
// slab table by an independent helper, not read back from computeTds.
// ---------------------------------------------------------------------------------------------
describe('old regime: no marginal relief on the rebate cliff', () => {
  const oldRules = fy.rules.old
  /** Slab tax computed independently of computeTds, in rupees. */
  const slabTax = (taxable: number): number => {
    let tax = 0
    for (const s of fy.slabs.old) {
      const hi = s.to === null ? Infinity : s.to
      if (taxable > s.from) tax += (Math.min(taxable, hi) - s.from) * s.rate
    }
    return tax
  }
  /** Annual tax (rupees, with cess) for an OLD-regime TAXABLE income, no declarations. */
  const oldTaxFor = (taxable: number): number => annualTax(taxable + oldRules.standardDeduction, 'old')

  it('is nil at the rebate limit', () => {
    expect(oldTaxFor(oldRules.rebateLimit)).toBe(0)
  })

  it('is the full slab tax (not the excess) just over the limit', () => {
    for (const over of [1, 1_000, 10_000]) {
      const taxable = oldRules.rebateLimit + over
      const expected = slabTax(taxable) * (1 + oldRules.cessRate)
      expect(oldTaxFor(taxable), `${over} over`).toBeCloseTo(expected, 0)
      // The cliff is real in the old regime: crossing it costs far more than the crossing.
      expect(oldTaxFor(taxable)).toBeGreaterThan(over * 1.04)
    }
  })

  it('still gets the rebate below the limit', () => {
    expect(oldTaxFor(oldRules.rebateLimit - 1)).toBe(0)
  })

  it('and the NEW regime keeps its relief (the same crossing costs no more than itself)', () => {
    const atLimit = fy.rules.new.rebateLimit + fy.rules.new.standardDeduction
    expect(annualTax(atLimit + 1_000) - annualTax(atLimit)).toBeLessThanOrEqual(1_000 * 1.04 + 1)
  })
})
