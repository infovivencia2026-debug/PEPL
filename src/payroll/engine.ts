/**
 * The payroll engine.
 *
 * Reads ONLY payroll_inputs. Never attendance, never leave, never live
 * compensation — those were resolved once, at freeze, and written as values.
 *
 * Calculation order is fixed and tested as a unit (docs/architecture/payroll.md §4):
 *   1  monthly gross from the frozen components
 *   2  prorate for a mid-period joiner or leaver
 *   3  apply LOP
 *   4  add ad-hoc earnings (OT, arrears, bonus, incentive)
 *   5  -> GROSS
 *   6  PF   on PF wages, capped at the ceiling unless the tenant contributes on full wages
 *   7  ESI  only below the threshold
 *   8  PT   by state slab
 *   9  TDS  (projected annual: slabs, 87A rebate, surcharge, cess)
 *  10  -> NET
 *
 * Rounding: every component rounds to the nearest rupee as it is written, and
 * gross is the SUM OF ROUNDED LINES — never a rounded sum — so a payslip always
 * adds up on screen.
 */

export interface StatutoryConfig {
  pf_employee_rate: number
  pf_employer_rate: number
  pf_wage_ceiling_paise: bigint
  esi_employee_rate: number
  esi_employer_rate: number
  esi_gross_threshold_paise: bigint
  /** Pension share of the employer's 12%, capped at its own ceiling. */
  eps_rate?: number
  eps_wage_ceiling_paise?: bigint
  /** Employer-only insurance levy on top of the 12%. */
  edli_rate?: number
  edli_wage_ceiling_paise?: bigint
}

export interface PayrollInput {
  employeeId: string
  calendarDays: number
  payableDays: number
  lopDays: number
  monthlyComponents: Record<string, number>
  stateCode: string
  pfApplicable: boolean
  esiApplicable: boolean
  /**
   * Already covered earlier in this ESI contribution period.
   *
   * Cover is settled at the START of a half-year period and holds until it
   * ends, so someone whose wage rises past the ceiling mid-period stays
   * covered. Resolved at freeze because the engine reads only payroll_inputs.
   */
  esiCoveredPeriod?: boolean
  /** Resolved at freeze. Used only for statutory exemptions that depend on it. */
  gender?: string | null
  taxRegime: 'old' | 'new'
  /** Allowed Chapter VI-A + HRA exemption for the year, resolved at freeze. */
  chapterViaPaise?: bigint
  /** Taxable gross and TDS already in locked runs this fiscal year, resolved at freeze. */
  ytdTaxablePaise?: bigint
  ytdTdsPaise?: bigint
  /** Months left in the fiscal year including this period's. From the period, not the clock. */
  monthsRemaining?: number
  /**
   * One-off lines. Earnings by default; `type: 'deduction'` for a recovery
   * (notice shortfall, unreturned asset). `taxable: false` keeps an exempt
   * payment — gratuity within the cap, encashment at exit — out of TDS.
   */
  adhoc: { code: string; amountPaise: number; taxable?: boolean; type?: 'earning' | 'deduction' }[]
  joinedMidPeriod?: boolean
  exitedMidPeriod?: boolean
}

export interface EngineOptions {
  statutory: StatutoryConfig
  /**
   * Professional tax. Takes gender because some states exempt on it --
   * Maharashtra exempts women up to Rs 25,000 a month -- and a wrong PT
   * deduction is money taken from someone who did not owe it.
   */
  ptAmountPaise: (stateCode: string, grossPaise: bigint, gender?: string | null) => bigint
  /**
   * Labour Welfare Fund for the run's month, by state: employee share (a
   * deduction) and employer share. Absent or zero means the state levies none
   * this month. Bound by the caller to the period, like PT is bound to slabs.
   */
  lwfAmountPaise?: (stateCode: string, grossPaise: bigint) => { employee: bigint; employer: bigint }
  /** payroll.pf_on_full_wage — contribute above the ceiling rather than capping. */
  pfOnFullWage: boolean
  /** payroll.lop_basis */
  lopBasis: 'calendar_days' | 'fixed_30' | 'working_days'
  /**
   * From the salary component master, when the company has one. Absent, the
   * convention applies: PF wages are basic + DA and every component is
   * taxable ESI gross.
   */
  components?: {
    pfWageCodes: ReadonlySet<string>
    nonTaxableCodes: ReadonlySet<string>
    nonEsiCodes: ReadonlySet<string>
  }
  /**
   * Real TDS: projects the year, applies slabs, 87A, surcharge and cess.
   * Supplied by the caller so the engine stays pure and the slab data stays
   * snapshotted on the run. Falls back to no deduction when unconfigured.
   */
  computeTds?: (args: {
    monthlyTaxableGrossPaise: bigint
    regime: 'old' | 'new'
    /** Allowed Chapter VI-A + HRA exemption for the year, resolved at freeze. */
    declaredDeductionsPaise: bigint
    earnedToDatePaise: bigint
    deductedToDatePaise: bigint
    monthsRemaining: number
  }) => { monthlyTdsPaise: bigint; trace: Record<string, unknown> }
}

export interface Line {
  code: string
  type: 'earning' | 'deduction' | 'employer_contribution' | 'informational'
  amountPaise: bigint
  note?: Record<string, unknown>
}

export interface Computed {
  lines: Line[]
  grossPaise: bigint
  deductionsPaise: bigint
  netPaise: bigint
}

/** Round to the nearest rupee. Every component passes through this exactly once. */
export const toRupee = (paise: number | bigint): bigint => {
  const n = typeof paise === 'bigint' ? Number(paise) : paise
  return BigInt(Math.round(n / 100) * 100)
}

/**
 * ESI rounds UP to the next rupee, not to the nearest.
 *
 * ESI (General) Regulation 40. It is the one component that does not follow
 * the house rule; using toRupee understated the contribution on roughly half
 * of all salaries -- by under a rupee each, and wrong on the return either way.
 */
export const toRupeeUp = (paise: number | bigint): bigint => {
  const n = typeof paise === 'bigint' ? Number(paise) : paise
  return BigInt(Math.ceil(n / 100) * 100)
}

const PF_WAGE_COMPONENTS = new Set(['basic', 'da'])

export function computePayroll(input: PayrollInput, opts: EngineOptions): Computed {
  const lines: Line[] = []

  // 1-2. Gross components, prorated for a partial month.
  const denominator =
    opts.lopBasis === 'fixed_30' ? 30
    : opts.lopBasis === 'working_days' ? Math.max(1, input.payableDays + input.lopDays)
    : input.calendarDays

  const presenceFactor =
    input.joinedMidPeriod || input.exitedMidPeriod
      ? Math.min(1, (input.payableDays + input.lopDays) / denominator)
      : 1

  const pfCodes = opts.components?.pfWageCodes ?? PF_WAGE_COMPONENTS
  const isPfWage = (code: string): boolean => pfCodes.has(code.toUpperCase()) || pfCodes.has(code.toLowerCase())
  const isTaxFree = (code: string): boolean => opts.components?.nonTaxableCodes.has(code.toUpperCase()) ?? false
  const isNonEsi = (code: string): boolean => opts.components?.nonEsiCodes.has(code.toUpperCase()) ?? false

  let earnings = 0n
  let taxFreeEarnings = 0n
  let nonEsiEarnings = 0n
  for (const [code, monthly] of Object.entries(input.monthlyComponents)) {
    const prorated = toRupee(monthly * presenceFactor)
    if (prorated === 0n) continue
    lines.push({
      code: code.toUpperCase(),
      type: 'earning',
      amountPaise: prorated,
      note: { monthly, presenceFactor, ...(isTaxFree(code) ? { taxExempt: true } : {}) },
    })
    earnings += prorated
    if (isTaxFree(code)) taxFreeEarnings += prorated
    if (isNonEsi(code)) nonEsiEarnings += prorated
  }

  // 3. Loss of pay.
  let lopAmount = 0n
  if (input.lopDays > 0) {
    lopAmount = toRupee(Number(earnings) * (input.lopDays / denominator))
    lines.push({
      code: 'LOP',
      type: 'deduction',
      amountPaise: lopAmount,
      note: { lopDays: input.lopDays, denominator, basis: opts.lopBasis },
    })
  }

  // 4. Ad-hoc lines: OT, arrears, bonus, incentive — and at exit, gratuity,
  // encashment and recoveries. Deductions are written now and counted at
  // step 10; they do not reduce gross.
  let adhocTotal = 0n
  let exemptAdhoc = 0n
  for (const a of input.adhoc) {
    const amt = toRupee(a.amountPaise)
    if (a.type === 'deduction') {
      lines.push({ code: a.code.toUpperCase(), type: 'deduction', amountPaise: amt, note: { adhoc: true } })
      continue
    }
    lines.push({ code: a.code.toUpperCase(), type: 'earning', amountPaise: amt,
      note: { adhoc: true, ...(a.taxable === false ? { taxExempt: true } : {}) } })
    adhocTotal += amt
    if (a.taxable === false) exemptAdhoc += amt
  }

  // 5. Gross is the sum of rounded lines, minus LOP.
  const grossPaise = earnings + adhocTotal - lopAmount

  // 6. Provident fund on PF wages.
  let pfEmployee = 0n
  if (input.pfApplicable) {
    let pfWage = 0n
    for (const [code, monthly] of Object.entries(input.monthlyComponents)) {
      if (isPfWage(code)) pfWage += toRupee(monthly * presenceFactor)
    }
    if (input.lopDays > 0) pfWage -= toRupee(Number(pfWage) * (input.lopDays / denominator))

    const ceiling = opts.statutory.pf_wage_ceiling_paise
    const pfBase = opts.pfOnFullWage ? pfWage : (pfWage > ceiling ? ceiling : pfWage)

    pfEmployee = toRupee(Number(pfBase) * opts.statutory.pf_employee_rate)
    const pfEmployer = toRupee(Number(pfBase) * opts.statutory.pf_employer_rate)

    lines.push({ code: 'PF_EE', type: 'deduction', amountPaise: pfEmployee,
      note: { pfWage: Number(pfWage), pfBase: Number(pfBase), capped: !opts.pfOnFullWage && pfWage > ceiling } })

    // The employer's 12% is split at source: 8.33% of PF wages to the PENSION
    // fund, capped at its own ceiling, and the remainder to the provident fund.
    // Booking it as one line leaves the ECR return -- which has separate EPF
    // and EPS columns -- with nothing to put in them.
    //
    // EPS is derived and EPF is the REMAINDER, so the two always add back to
    // the 12% actually computed. Deriving both independently would let rounding
    // drop a rupee into neither.
    const epsRate = opts.statutory.eps_rate
    if (epsRate && epsRate > 0) {
      const epsCeiling = opts.statutory.eps_wage_ceiling_paise ?? ceiling
      const epsBase = pfBase > epsCeiling ? epsCeiling : pfBase
      const eps = toRupee(Number(epsBase) * epsRate)
      lines.push({ code: 'PF_EPS', type: 'employer_contribution', amountPaise: eps,
        note: { epsBase: Number(epsBase), rate: epsRate } })
      lines.push({ code: 'PF_ER', type: 'employer_contribution', amountPaise: pfEmployer - eps,
        note: { pfBase: Number(pfBase), ofWhichPension: Number(eps) } })
    } else {
      lines.push({ code: 'PF_ER', type: 'employer_contribution', amountPaise: pfEmployer,
        note: { pfBase: Number(pfBase) } })
    }

    // EDLI sits ON TOP of the 12% and is the employer's alone, so it raises
    // employer cost without touching the payslip's net.
    const edliRate = opts.statutory.edli_rate
    if (edliRate && edliRate > 0) {
      const edliCeiling = opts.statutory.edli_wage_ceiling_paise ?? ceiling
      const edliBase = pfBase > edliCeiling ? edliCeiling : pfBase
      const edli = toRupee(Number(edliBase) * edliRate)
      if (edli > 0n) {
        lines.push({ code: 'EDLI_ER', type: 'employer_contribution', amountPaise: edli,
          note: { edliBase: Number(edliBase), rate: edliRate } })
      }
    }
  }

  // 7. ESI applies only below the gross threshold.
  let esiEmployee = 0n
  const esiGross = grossPaise - nonEsiEarnings
  // The ceiling decides cover at the START of a contribution period. Someone
  // already covered this period keeps it even after a raise takes them over --
  // re-testing every month dropped people out of ESI mid-period, which is both
  // a benefit they were entitled to and a shortfall on the return.
  const esiEligible = input.esiApplicable &&
    (input.esiCoveredPeriod === true || esiGross <= opts.statutory.esi_gross_threshold_paise)
  if (esiEligible) {
    // Rounded UP, per Regulation 40 -- the one component that does not round
    // to the nearest rupee like everything else.
    esiEmployee = toRupeeUp(Number(esiGross) * opts.statutory.esi_employee_rate)
    const esiEmployer = toRupeeUp(Number(esiGross) * opts.statutory.esi_employer_rate)
    lines.push({ code: 'ESI_EE', type: 'deduction', amountPaise: esiEmployee, note: { gross: Number(esiGross) } })
    lines.push({ code: 'ESI_ER', type: 'employer_contribution', amountPaise: esiEmployer })
  }

  // 8. Professional tax by state slab.
  const pt = opts.ptAmountPaise(input.stateCode, grossPaise, input.gender)
  if (pt > 0n) {
    lines.push({ code: 'PT', type: 'deduction', amountPaise: pt, note: { state: input.stateCode } })
  }

  // 8b. Labour Welfare Fund, in the months the state collects it.
  const lwf = opts.lwfAmountPaise?.(input.stateCode, grossPaise)
  if (lwf && lwf.employee > 0n) lines.push({ code: 'LWF_EE', type: 'deduction', amountPaise: lwf.employee, note: { state: input.stateCode } })
  if (lwf && lwf.employer > 0n) lines.push({ code: 'LWF_ER', type: 'employer_contribution', amountPaise: lwf.employer, note: { state: input.stateCode } })

  // 9. TDS. Taxable gross excludes the employee's own PF contribution, which is
  // deductible, and any exempt one-off; the projection and slab work live in
  // payroll/tds.ts.
  if (opts.computeTds) {
    const taxableGross = grossPaise - pfEmployee - exemptAdhoc - taxFreeEarnings
    const result = opts.computeTds({
      monthlyTaxableGrossPaise: taxableGross,
      regime: input.taxRegime,
      declaredDeductionsPaise: input.chapterViaPaise ?? 0n,
      earnedToDatePaise: input.ytdTaxablePaise ?? 0n,
      deductedToDatePaise: input.ytdTdsPaise ?? 0n,
      monthsRemaining: input.monthsRemaining ?? 12,
    })
    if (result.monthlyTdsPaise > 0n) {
      lines.push({
        code: 'TDS',
        type: 'deduction',
        amountPaise: result.monthlyTdsPaise,
        note: result.trace,
      })
    }
  }

  // 10. Net. Employer contributions are never deducted from the employee.
  const deductionsPaise = lines
    .filter((l) => l.type === 'deduction' && l.code !== 'LOP')
    .reduce((s, l) => s + l.amountPaise, 0n)

  return {
    lines,
    grossPaise,
    deductionsPaise,
    netPaise: grossPaise - deductionsPaise,
  }
}

export interface ValidationFinding {
  code: string
  employeeId: string
  message: string
}

export interface ValidationResult {
  blockers: ValidationFinding[]
  warnings: ValidationFinding[]
}

/** A run cannot advance from calculated to validated while any blocker stands. */
export function validateRun(
  rows: { input: PayrollInput; computed: Computed; previousNetPaise?: bigint }[],
  opts: { variancePct: number; taxTables?: { fiscalYear: string; regimes: Record<'old' | 'new', boolean> } },
): ValidationResult {
  const blockers: ValidationFinding[] = []
  const warnings: ValidationFinding[] = []

  // Zero tax because nobody loaded the year's slabs is not "no tax due"; it
  // is a payroll that pays out untaxed and is found at the TDS return.
  if (opts.taxTables) {
    for (const regime of ['new', 'old'] as const) {
      if (!opts.taxTables.regimes[regime] && rows.some((r) => r.input.taxRegime === regime)) {
        blockers.push({ code: 'NO_TAX_SLABS', employeeId: '*',
          message: `no income-tax tables for the ${regime} regime in FY ${opts.taxTables.fiscalYear}; run npm run seed:statutory after reconciling db/reference/income-tax.ts` })
      }
    }
  }

  for (const { input, computed, previousNetPaise } of rows) {
    const id = input.employeeId

    if (computed.netPaise < 0n) {
      blockers.push({ code: 'NEGATIVE_NET_PAY', employeeId: id,
        message: `net pay is ${computed.netPaise} paise` })
    }
    if (input.lopDays > input.calendarDays) {
      blockers.push({ code: 'LOP_EXCEEDS_PERIOD', employeeId: id,
        message: `${input.lopDays} LOP days in a ${input.calendarDays}-day period` })
    }
    if (Object.keys(input.monthlyComponents).length === 0) {
      blockers.push({ code: 'NO_SALARY_STRUCTURE', employeeId: id,
        message: 'no compensation was frozen for this employee' })
    }

    if (previousNetPaise !== undefined && previousNetPaise > 0n) {
      const change = Math.abs(Number(computed.netPaise - previousNetPaise)) / Number(previousNetPaise) * 100
      if (change > opts.variancePct) {
        warnings.push({ code: 'NET_PAY_VARIANCE', employeeId: id,
          message: `net pay moved ${change.toFixed(1)}% against the previous period` })
      }
    }
    if (input.lopDays > 15) {
      warnings.push({ code: 'HIGH_LOP', employeeId: id, message: `${input.lopDays} LOP days` })
    }
  }

  return { blockers, warnings }
}
