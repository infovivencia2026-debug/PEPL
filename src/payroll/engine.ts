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
  taxRegime: 'old' | 'new'
  adhoc: { code: string; amountPaise: number; taxable?: boolean }[]
  joinedMidPeriod?: boolean
  exitedMidPeriod?: boolean
}

export interface EngineOptions {
  statutory: StatutoryConfig
  ptAmountPaise: (stateCode: string, grossPaise: bigint) => bigint
  /** payroll.pf_on_full_wage — contribute above the ceiling rather than capping. */
  pfOnFullWage: boolean
  /** payroll.lop_basis */
  lopBasis: 'calendar_days' | 'fixed_30' | 'working_days'
  /**
   * Real TDS: projects the year, applies slabs, 87A, surcharge and cess.
   * Supplied by the caller so the engine stays pure and the slab data stays
   * snapshotted on the run. Falls back to no deduction when unconfigured.
   */
  computeTds?: (args: {
    monthlyTaxableGrossPaise: bigint
    regime: 'old' | 'new'
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

  let earnings = 0n
  for (const [code, monthly] of Object.entries(input.monthlyComponents)) {
    const prorated = toRupee(monthly * presenceFactor)
    if (prorated === 0n) continue
    lines.push({
      code: code.toUpperCase(),
      type: 'earning',
      amountPaise: prorated,
      note: { monthly, presenceFactor },
    })
    earnings += prorated
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

  // 4. Ad-hoc earnings: OT, arrears, bonus, incentive.
  let adhocTotal = 0n
  for (const a of input.adhoc) {
    const amt = toRupee(a.amountPaise)
    lines.push({ code: a.code.toUpperCase(), type: 'earning', amountPaise: amt, note: { adhoc: true } })
    adhocTotal += amt
  }

  // 5. Gross is the sum of rounded lines, minus LOP.
  const grossPaise = earnings + adhocTotal - lopAmount

  // 6. Provident fund on PF wages.
  let pfEmployee = 0n
  if (input.pfApplicable) {
    let pfWage = 0n
    for (const [code, monthly] of Object.entries(input.monthlyComponents)) {
      if (PF_WAGE_COMPONENTS.has(code.toLowerCase())) pfWage += toRupee(monthly * presenceFactor)
    }
    if (input.lopDays > 0) pfWage -= toRupee(Number(pfWage) * (input.lopDays / denominator))

    const ceiling = opts.statutory.pf_wage_ceiling_paise
    const pfBase = opts.pfOnFullWage ? pfWage : (pfWage > ceiling ? ceiling : pfWage)

    pfEmployee = toRupee(Number(pfBase) * opts.statutory.pf_employee_rate)
    const pfEmployer = toRupee(Number(pfBase) * opts.statutory.pf_employer_rate)

    lines.push({ code: 'PF_EE', type: 'deduction', amountPaise: pfEmployee,
      note: { pfWage: Number(pfWage), pfBase: Number(pfBase), capped: !opts.pfOnFullWage && pfWage > ceiling } })
    lines.push({ code: 'PF_ER', type: 'employer_contribution', amountPaise: pfEmployer,
      note: { pfBase: Number(pfBase) } })
  }

  // 7. ESI applies only below the gross threshold.
  let esiEmployee = 0n
  const esiEligible = input.esiApplicable && grossPaise <= opts.statutory.esi_gross_threshold_paise
  if (esiEligible) {
    esiEmployee = toRupee(Number(grossPaise) * opts.statutory.esi_employee_rate)
    const esiEmployer = toRupee(Number(grossPaise) * opts.statutory.esi_employer_rate)
    lines.push({ code: 'ESI_EE', type: 'deduction', amountPaise: esiEmployee, note: { gross: Number(grossPaise) } })
    lines.push({ code: 'ESI_ER', type: 'employer_contribution', amountPaise: esiEmployer })
  }

  // 8. Professional tax by state slab.
  const pt = opts.ptAmountPaise(input.stateCode, grossPaise)
  if (pt > 0n) {
    lines.push({ code: 'PT', type: 'deduction', amountPaise: pt, note: { state: input.stateCode } })
  }

  // 9. TDS. Taxable gross excludes the employee's own PF contribution, which is
  // deductible; the projection and slab work live in payroll/tds.ts.
  if (opts.computeTds) {
    const taxableGross = grossPaise - pfEmployee
    const result = opts.computeTds({
      monthlyTaxableGrossPaise: taxableGross,
      regime: input.taxRegime,
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
  opts: { variancePct: number },
): ValidationResult {
  const blockers: ValidationFinding[] = []
  const warnings: ValidationFinding[] = []

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
