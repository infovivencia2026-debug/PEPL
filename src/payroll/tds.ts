/**
 * TDS — income tax deducted at source.
 *
 * Replaces the flat-rate placeholder. The method is the standard one Indian
 * payroll uses: project the year's taxable income from what is known now,
 * compute the annual liability, subtract what has already been deducted, and
 * spread the remainder across the months left in the fiscal year.
 *
 * Slabs, the standard deduction, the 87A rebate, surcharge bands and cess are
 * all DATA with effective dates (tax_slabs / tax_rules), so a Finance Act change
 * is an INSERT rather than a deploy, and a locked run keeps the numbers it saw.
 *
 * NOT a substitute for a compliance review. Chapter VI-A deductions and the HRA
 * exemption arrive as `declaredDeductionsPaise`, resolved at freeze from the
 * VERIFIED declaration by payroll/chapter-via.ts. House property loss,
 * perquisites and marginal relief are out of scope here; see `limitations` on
 * the result, which the payslip and the API surface.
 */

export interface TaxSlab {
  income_from_paise: string
  income_to_paise: string | null
  rate: string
}

export interface TaxRules {
  standard_deduction_paise: string
  rebate_limit_paise: string
  rebate_max_paise: string
  cess_rate: string
  surcharge_bands: { above_paise: number; rate: number }[]
}

export interface TdsInput {
  /** Taxable earnings for THIS month, in paise. */
  monthlyTaxableGrossPaise: bigint
  /** Months remaining in the fiscal year, including this one. 1..12 */
  monthsRemaining: number
  /** Already-taxable income earned earlier in this fiscal year. */
  earnedToDatePaise?: bigint
  /** TDS already deducted earlier in this fiscal year. */
  deductedToDatePaise?: bigint
  /** Declared and proofed investments (old regime). */
  declaredDeductionsPaise?: bigint
  regime: 'old' | 'new'
}

export interface TdsResult {
  monthlyTdsPaise: bigint
  projectedAnnualIncomePaise: bigint
  taxableIncomePaise: bigint
  annualTaxPaise: bigint
  trace: Record<string, unknown>
  limitations: string[]
}

const toRupee = (paise: number): bigint => BigInt(Math.round(paise / 100) * 100)

/** Slab tax on an amount, applied band by band. */
export function taxOnIncome(incomePaise: number, slabs: readonly TaxSlab[]): number {
  let tax = 0
  for (const slab of slabs) {
    const from = Number(slab.income_from_paise)
    const to = slab.income_to_paise === null ? Infinity : Number(slab.income_to_paise)
    if (incomePaise <= from) continue
    const inBand = Math.min(incomePaise, to) - from
    tax += inBand * Number(slab.rate)
  }
  return tax
}

export function computeTds(
  input: TdsInput,
  slabs: readonly TaxSlab[],
  rules: TaxRules,
): TdsResult {
  const limitations = [
    'Chapter VI-A and HRA apply only from a declaration payroll has verified',
    'house property loss, perquisites and marginal relief are not modelled',
  ]

  if (slabs.length === 0) {
    return {
      monthlyTdsPaise: 0n,
      projectedAnnualIncomePaise: 0n,
      taxableIncomePaise: 0n,
      annualTaxPaise: 0n,
      trace: { reason: 'no slabs configured for this regime and fiscal year' },
      limitations,
    }
  }

  const months = Math.max(1, Math.min(12, input.monthsRemaining))
  const earned = Number(input.earnedToDatePaise ?? 0n)
  const monthly = Number(input.monthlyTaxableGrossPaise)

  // Project the year from what is known: earned so far, plus this month repeated
  // across the months that remain.
  const projected = earned + monthly * months

  const standardDeduction = Number(rules.standard_deduction_paise)
  // The old regime is where declared investments apply; the new regime trades
  // them for lower rates.
  const declared = input.regime === 'old' ? Number(input.declaredDeductionsPaise ?? 0n) : 0
  const taxable = Math.max(0, projected - standardDeduction - declared)

  let tax = taxOnIncome(taxable, slabs)

  // Section 87A: a full rebate at or below the threshold, which is why low
  // earners pay nothing rather than a small amount.
  const rebateLimit = Number(rules.rebate_limit_paise)
  const rebateMax = Number(rules.rebate_max_paise)
  let rebate = 0
  if (rebateLimit > 0 && taxable <= rebateLimit) {
    rebate = Math.min(tax, rebateMax)
    tax -= rebate
  }

  // Marginal relief on the 87A cliff.
  //
  // Without it, one rupee over the rebate threshold costs tens of thousands:
  // at 12,00,000 the rebate wipes the tax out, and at 12,00,001 the whole bill
  // lands. Relief caps the tax at the amount by which income exceeds the
  // threshold, so crossing it can never cost more than the crossing.
  if (rebateLimit > 0 && taxable > rebateLimit) {
    const excess = taxable - rebateLimit
    if (tax > excess) tax = excess
  }

  // Surcharge applies to the tax, not the income, above each band.
  const bands = [...(rules.surcharge_bands ?? [])].sort((a, b) => a.above_paise - b.above_paise)
  let surchargeRate = 0
  let bandFloor = 0
  let rateBelowBand = 0
  for (const band of bands) {
    if (taxable > band.above_paise) {
      rateBelowBand = surchargeRate   // what was payable just below this band
      surchargeRate = band.rate
      bandFloor = band.above_paise
    }
  }
  let surcharge = tax * surchargeRate

  // Marginal relief on surcharge: crossing a band must not cost more than the
  // amount by which it was crossed.
  //
  // The ceiling is the liability AT the threshold plus the extra income — and
  // the liability at the threshold INCLUDES the surcharge already payable
  // there at the previous band's rate. Leaving that term out made the ceiling
  // far too low: tax at 2.01Cr came out BELOW tax at 1.99Cr, because the
  // surcharge collapsed to almost nothing the moment the band was crossed.
  if (surchargeRate > 0 && bandFloor > 0) {
    const taxAtFloor = taxOnIncome(bandFloor, slabs)
    const liabilityAtFloor = taxAtFloor + taxAtFloor * rateBelowBand
    const ceiling = liabilityAtFloor + (taxable - bandFloor)
    if (tax + surcharge > ceiling) surcharge = Math.max(0, ceiling - tax)
  }

  const cess = (tax + surcharge) * Number(rules.cess_rate)
  const annualTax = Math.max(0, tax + surcharge + cess)

  const alreadyDeducted = Number(input.deductedToDatePaise ?? 0n)
  const remaining = Math.max(0, annualTax - alreadyDeducted)
  const monthlyTds = toRupee(remaining / months)

  return {
    monthlyTdsPaise: monthlyTds,
    projectedAnnualIncomePaise: BigInt(Math.round(projected)),
    taxableIncomePaise: BigInt(Math.round(taxable)),
    annualTaxPaise: BigInt(Math.round(annualTax)),
    trace: {
      regime: input.regime,
      projected,
      standardDeduction,
      declaredDeductions: declared,
      taxable,
      slabTax: Math.round(tax + rebate),
      rebate87A: Math.round(rebate),
      surchargeRate,
      surcharge: Math.round(surcharge),
      cessRate: Number(rules.cess_rate),
      cess: Math.round(cess),
      annualTax: Math.round(annualTax),
      alreadyDeducted,
      monthsRemaining: months,
    },
    limitations,
  }
}

/** Months left in the Indian fiscal year (April–March), including this one. */
export function monthsRemainingInFY(date: Date): number {
  const month = date.getMonth() // 0 = Jan
  // April (3) -> 12 remaining, March (2) -> 1 remaining
  return month >= 3 ? 12 - (month - 3) : 12 - (month + 9)
}

export function fiscalYearOf(date: Date): string {
  const year = date.getFullYear()
  const start = date.getMonth() >= 3 ? year : year - 1
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`
}
