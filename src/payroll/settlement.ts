/**
 * Full and final settlement: what the company owes a leaver, and what the
 * leaver owes back.
 *
 *   gratuity      Payment of Gratuity Act 1972: 15/26 × last drawn (basic + DA)
 *                 × completed years, after five years of service, capped at
 *                 ₹20 lakh. Death or disablement waives the five years.
 *   encashment    Leave the person never took, from the types the policy marks
 *                 encashable, at (basic + DA) / divisor per day.
 *   notice        The shortfall between what the contract required and what
 *                 was served, recovered at gross / divisor per day unless waived.
 *   recoveries    Whatever HR added by hand: an unreturned laptop, a loan balance.
 *
 * Pure. The service in exit.ts gathers the inputs; freeze writes the result
 * as adhoc lines on the final run, so the payslip is the settlement statement.
 */

/** ₹20,00,000 — the Section 4(3) ceiling since the 2018 amendment. */
export const GRATUITY_CAP_PAISE = 20_00_000 * 100

export interface GratuityInput {
  /** Last drawn basic + DA per month. */
  wagePaise: number
  dateOfJoining: Date
  lastWorkingDay: Date
  /** Death or disablement: eligible from day one. */
  waiveMinimumService?: boolean
}

export interface GratuityResult {
  eligible: boolean
  yearsCounted: number
  amountPaise: number
  /** The uncapped figure, so the statement can show what the cap cut. */
  computedPaise: number
  note: string
}

const DAY = 86_400_000

/**
 * Completed years, with the Act's rounding: a fraction of six months or more
 * counts as a year. Eligibility is five years; the widely applied Madras High
 * Court reading (Mettur Beardsell, 1998) treats 4 years and 240 days as five,
 * and that is what payroll teams expect to see.
 */
export function gratuity(input: GratuityInput): GratuityResult {
  const days = Math.floor((input.lastWorkingDay.getTime() - input.dateOfJoining.getTime()) / DAY) + 1
  if (days <= 0) return { eligible: false, yearsCounted: 0, amountPaise: 0, computedPaise: 0, note: 'no service' }

  const wholeYears = Math.floor(days / 365.25)
  const remainderDays = days - Math.floor(wholeYears * 365.25)
  const eligibleByService = wholeYears >= 5 || (wholeYears === 4 && remainderDays >= 240)
  if (!eligibleByService && !input.waiveMinimumService) {
    return {
      eligible: false, yearsCounted: wholeYears, amountPaise: 0, computedPaise: 0,
      note: `${wholeYears} year(s) and ${remainderDays} day(s) of service; gratuity needs five years (4 years 240 days)`,
    }
  }

  const yearsCounted = wholeYears + (remainderDays >= 183 ? 1 : 0)
  if (yearsCounted === 0) {
    return { eligible: true, yearsCounted: 0, amountPaise: 0, computedPaise: 0,
      note: 'eligible, but under six months of service counts as zero years' }
  }
  const computed = Math.round(input.wagePaise * 15 / 26 * yearsCounted)
  const amount = Math.min(computed, GRATUITY_CAP_PAISE)
  return {
    eligible: true, yearsCounted, amountPaise: amount, computedPaise: computed,
    note: computed > GRATUITY_CAP_PAISE
      ? `${yearsCounted} years × 15/26 × last drawn; capped at ₹20,00,000`
      : `${yearsCounted} years × 15/26 × last drawn`,
  }
}

export interface EncashmentInput {
  /** Balance per encashable leave type, in days. */
  balances: { leaveTypeCode: string; days: number }[]
  wagePaise: number
  /** 30 by convention; some companies use 26 working days. */
  divisor: number
  /** A policy may cap what is paid out at exit. */
  maxDays?: number
}

export function leaveEncashment(input: EncashmentInput): { days: number; amountPaise: number; byType: { leaveTypeCode: string; days: number; amountPaise: number }[] } {
  const perDay = input.wagePaise / input.divisor
  let remaining = input.maxDays ?? Number.POSITIVE_INFINITY
  const byType: { leaveTypeCode: string; days: number; amountPaise: number }[] = []
  let days = 0
  for (const b of input.balances) {
    const d = Math.max(0, Math.min(b.days, remaining))
    if (d === 0) continue
    remaining -= d
    days += d
    byType.push({ leaveTypeCode: b.leaveTypeCode, days: d, amountPaise: Math.round(perDay * d) })
  }
  return { days, amountPaise: byType.reduce((n, b) => n + b.amountPaise, 0), byType }
}

export interface NoticeInput {
  requiredDays: number
  resignedOn: Date
  lastWorkingDay: Date
  /** Gross monthly pay; recovery is on gross, encashment on basic. */
  grossMonthlyPaise: number
  divisor: number
  waived?: boolean
}

export function noticeRecovery(input: NoticeInput): { servedDays: number; shortfallDays: number; amountPaise: number } {
  const served = Math.max(0, Math.floor((input.lastWorkingDay.getTime() - input.resignedOn.getTime()) / DAY))
  const shortfall = Math.max(0, input.requiredDays - served)
  if (input.waived || shortfall === 0) return { servedDays: served, shortfallDays: shortfall, amountPaise: 0 }
  return { servedDays: served, shortfallDays: shortfall,
    amountPaise: Math.round(input.grossMonthlyPaise / input.divisor * shortfall) }
}

export interface Settlement {
  gratuity: GratuityResult
  encashment: ReturnType<typeof leaveEncashment>
  notice: ReturnType<typeof noticeRecovery>
  recoveriesPaise: number
  /** What the final run adds to the leaver's payslip. */
  adhoc: { code: string; amountPaise: number; taxable?: boolean; type?: 'earning' | 'deduction' }[]
}

/** Assembles the payslip lines. Gratuity within the cap and exit encashment are exempt under s.10(10) and s.10(10AA). */
export function settlementLines(s: Omit<Settlement, 'adhoc'>): Settlement['adhoc'] {
  const lines: Settlement['adhoc'] = []
  if (s.gratuity.amountPaise > 0) lines.push({ code: 'GRATUITY', amountPaise: s.gratuity.amountPaise, taxable: false })
  if (s.encashment.amountPaise > 0) lines.push({ code: 'LEAVE_ENCASH', amountPaise: s.encashment.amountPaise, taxable: false })
  if (s.notice.amountPaise > 0) lines.push({ code: 'NOTICE_RECOVERY', amountPaise: s.notice.amountPaise, type: 'deduction' })
  if (s.recoveriesPaise > 0) lines.push({ code: 'RECOVERY', amountPaise: s.recoveriesPaise, type: 'deduction' })
  return lines
}
