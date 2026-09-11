/**
 * Chapter VI-A deductions and the HRA exemption.
 *
 * What an employee declares is not what they get. Every section has a ceiling,
 * the HRA exemption is a formula rather than a claim, and under the new regime
 * almost none of it applies. This turns a declaration into the number the TDS
 * projection may actually subtract, and says exactly what was capped and why —
 * because "your tax went up" with no breakdown is the payroll query HR dreads.
 *
 * Pure: no database, no dates read from the clock. The caps are statutory and
 * change rarely; they are keyed by fiscal year so a change is a new row, not an
 * edit that silently rewrites last year's payslips.
 */

export type Regime = 'old' | 'new'

/** Amounts the employee declares, in paise, for one fiscal year. */
export interface Declaration {
  /** 80C: PF (own), PPF, ELSS, LIC, tuition, principal on home loan… */
  section80cPaise?: number
  /** 80CCD(1B): additional NPS, own contribution. */
  section80ccd1bPaise?: number
  /** 80D: health insurance premium, self and family. */
  section80dSelfPaise?: number
  /** 80D: health insurance premium, parents. */
  section80dParentsPaise?: number
  /** Whether the parents covered are 60 or over — changes their 80D ceiling. */
  parentsSenior?: boolean
  /** 80E: interest on an education loan. No ceiling. */
  section80ePaise?: number
  /** 24(b): interest on a home loan, self-occupied property. */
  section24bPaise?: number
  /** 80G: donations. Declared but NEVER auto-allowed; see the note in caps. */
  section80gPaise?: number
  /** Annual rent actually paid, for the HRA exemption. */
  rentPaidAnnualPaise?: number
  /** Whether the person lives in a metro (Delhi, Mumbai, Kolkata, Chennai). */
  metro?: boolean
}

/** What the exemption formula needs from the salary side. */
export interface SalaryFacts {
  /** Annual basic (plus DA where it forms part of retirement benefits). */
  basicAnnualPaise: number
  /** Annual HRA the employer actually pays. Zero means no HRA, so no exemption. */
  hraAnnualPaise: number
}

export interface Caps {
  section80c: number
  section80ccd1b: number
  section80dSelf: number
  section80dParents: number
  section80dParentsSenior: number
  section24b: number
}

/** Ceilings by fiscal year. Each entry is a fact about the Act, not a policy. */
const CAPS_BY_FY: Record<string, Caps> = {
  '2025-26': {
    section80c: 150_000_00,
    section80ccd1b: 50_000_00,
    section80dSelf: 25_000_00,
    section80dParents: 25_000_00,
    section80dParentsSenior: 50_000_00,
    section24b: 200_000_00,
  },
  '2026-27': {
    section80c: 150_000_00,
    section80ccd1b: 50_000_00,
    section80dSelf: 25_000_00,
    section80dParents: 25_000_00,
    section80dParentsSenior: 50_000_00,
    section24b: 200_000_00,
  },
}

export function capsFor(fiscalYear: string): Caps {
  const caps = CAPS_BY_FY[fiscalYear]
  if (caps) return caps
  // A year not yet entered uses the latest known: the ceilings drift by years,
  // and refusing to compute tax at all in April is the worse failure.
  const latest = Object.keys(CAPS_BY_FY).sort().pop()!
  return CAPS_BY_FY[latest]!
}

export interface AllowedLine {
  section: string
  declaredPaise: number
  allowedPaise: number
  /** Present when the allowed figure is less than declared, and why. */
  note?: string
}

export interface Allowance {
  regime: Regime
  totalPaise: number
  hraExemptionPaise: number
  lines: AllowedLine[]
  /** What the employee should know about how this was arrived at. */
  notes: string[]
}

/**
 * The HRA exemption under section 10(13A): the least of
 *   a. HRA actually received
 *   b. rent paid minus 10% of basic
 *   c. 50% of basic in a metro, 40% elsewhere
 * and never negative. No rent, no HRA, or no basic all give zero.
 */
export function hraExemption(decl: Declaration, salary: SalaryFacts): number {
  const rent = Math.max(0, decl.rentPaidAnnualPaise ?? 0)
  if (rent === 0 || salary.hraAnnualPaise <= 0 || salary.basicAnnualPaise <= 0) return 0
  const a = salary.hraAnnualPaise
  const b = rent - salary.basicAnnualPaise * 0.10
  const c = salary.basicAnnualPaise * (decl.metro ? 0.50 : 0.40)
  return Math.max(0, Math.round(Math.min(a, b, c)))
}

/**
 * Turns a declaration into what may be deducted.
 *
 * Under the new regime the answer is zero: it trades every Chapter VI-A
 * deduction and the HRA exemption for lower slab rates. That is stated in the
 * notes rather than silently returned, because an employee who declared 1.5
 * lakh of 80C and sees no effect will otherwise open a ticket.
 */
export function allowableDeductions(
  decl: Declaration,
  salary: SalaryFacts,
  fiscalYear: string,
  regime: Regime,
): Allowance {
  if (regime === 'new') {
    return {
      regime,
      totalPaise: 0,
      hraExemptionPaise: 0,
      lines: [],
      notes: [
        'the new tax regime does not allow Chapter VI-A deductions or the HRA exemption; ' +
        'it applies lower slab rates instead',
      ],
    }
  }

  const caps = capsFor(fiscalYear)
  const lines: AllowedLine[] = []
  const notes: string[] = []

  const cap = (section: string, declared: number | undefined, ceiling: number): void => {
    const value = Math.max(0, Math.round(declared ?? 0))
    if (value === 0) return
    const allowed = Math.min(value, ceiling)
    lines.push({
      section, declaredPaise: value, allowedPaise: allowed,
      ...(allowed < value ? { note: `capped at the ${section} ceiling of ${ceiling / 100}` } : {}),
    })
  }

  cap('80C', decl.section80cPaise, caps.section80c)
  cap('80CCD(1B)', decl.section80ccd1bPaise, caps.section80ccd1b)
  cap('80D self', decl.section80dSelfPaise, caps.section80dSelf)
  cap('80D parents', decl.section80dParentsPaise,
    decl.parentsSenior ? caps.section80dParentsSenior : caps.section80dParents)
  cap('24(b)', decl.section24bPaise, caps.section24b)

  // 80E has no ceiling in the Act.
  if ((decl.section80ePaise ?? 0) > 0) {
    const value = Math.round(decl.section80ePaise!)
    lines.push({ section: '80E', declaredPaise: value, allowedPaise: value })
  }

  // 80G depends on the donee's registration and a per-donation 50/100% rule
  // the employer cannot verify from a payslip. It is recorded, never allowed
  // here; the employee claims it in their own return.
  if ((decl.section80gPaise ?? 0) > 0) {
    lines.push({
      section: '80G', declaredPaise: Math.round(decl.section80gPaise!), allowedPaise: 0,
      note: 'donations are claimed in the personal return, not through payroll',
    })
    notes.push('80G donations were declared but are not deducted at source')
  }

  const hra = hraExemption(decl, salary)
  if (hra > 0) {
    lines.push({ section: 'HRA 10(13A)', declaredPaise: decl.rentPaidAnnualPaise ?? 0, allowedPaise: hra })
  } else if ((decl.rentPaidAnnualPaise ?? 0) > 0) {
    notes.push(
      salary.hraAnnualPaise <= 0
        ? 'rent was declared but the salary carries no HRA component, so no exemption applies'
        : 'rent was declared but the exemption formula yields nothing at this rent and basic',
    )
  }

  const totalPaise = lines.reduce((sum, l) => sum + l.allowedPaise, 0)
  return { regime, totalPaise, hraExemptionPaise: hra, lines, notes }
}
