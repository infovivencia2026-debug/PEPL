/**
 * The employer's PF is three numbers, and ESI does not round like the rest.
 *
 * PEPL booked the employer's whole 12% as one PF_ER line. The employee's
 * passbook is unaffected, but the ECR return has separate EPF and EPS columns
 * and there was nothing to put in the second — and EDLI, which is an employer
 * cost on top of the 12%, was not booked at all, so employer cost was
 * understated on every payslip.
 *
 * ESI rounds UP (Regulation 40). Everything else in this engine rounds to the
 * nearest rupee, which understated the contribution on about half of salaries.
 */
import { describe, it, expect } from 'vitest'
import { computePayroll, toRupeeUp, toRupee, type EngineOptions, type PayrollInput } from '../src/payroll/engine.ts'
import { gratuity, GRATUITY_CAP_PAISE } from '../src/payroll/settlement.ts'
import { ptFor } from '../src/payroll/statutory.ts'

const L = (rupees: number): number => rupees * 100

const STATUTORY = {
  pf_employee_rate: 0.12,
  pf_employer_rate: 0.12,
  pf_wage_ceiling_paise: BigInt(L(15_000)),
  esi_employee_rate: 0.0075,
  esi_employer_rate: 0.0325,
  esi_gross_threshold_paise: BigInt(L(21_000)),
  eps_rate: 0.0833,
  eps_wage_ceiling_paise: BigInt(L(15_000)),
  edli_rate: 0.005,
  edli_wage_ceiling_paise: BigInt(L(15_000)),
}

const OPTS: EngineOptions = {
  statutory: STATUTORY,
  ptAmountPaise: () => 0n,
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}

const input = (over: Partial<PayrollInput> = {}): PayrollInput => ({
  employeeId: 'e1', calendarDays: 30, payableDays: 30, lopDays: 0,
  monthlyComponents: { basic: L(20_000) },
  stateCode: 'TS',
  pfApplicable: true, esiApplicable: false, taxRegime: 'new', adhoc: [],
  ...over,
})

const lineOf = (result: { lines: Array<{ code: string; amountPaise: bigint }> }, code: string) =>
  result.lines.find((l) => l.code === code)

describe('the employer 12% is split into pension and provident fund', () => {
  const r = computePayroll(input(), OPTS)

  it('books the pension share separately', () => {
    // Basic 20,000 is over the 15,000 ceiling, so PF is on 15,000.
    // 8.33% of 15,000 = 1,249.50 -> 1,250 (the statutory pension cap).
    expect(lineOf(r, 'PF_EPS')?.amountPaise).toBe(BigInt(L(1_250)))
  })

  it('leaves the remainder in the provident fund line', () => {
    // 12% of 15,000 is 1,800; less 1,250 of pension leaves 550.
    expect(lineOf(r, 'PF_ER')?.amountPaise).toBe(BigInt(L(550)))
  })

  it('the two still add to the 12% that was computed', () => {
    // Derived as a REMAINDER on purpose: computing both independently lets
    // rounding drop a rupee into neither.
    const eps = lineOf(r, 'PF_EPS')!.amountPaise
    const epf = lineOf(r, 'PF_ER')!.amountPaise
    expect(eps + epf).toBe(BigInt(L(1_800)))
  })

  it('neither is deducted from the employee', () => {
    for (const code of ['PF_EPS', 'PF_ER', 'EDLI_ER']) {
      expect(r.lines.find((l) => l.code === code)?.type, code).toBe('employer_contribution')
    }
  })

  it('the employee still pays their own 12% and nothing more', () => {
    expect(lineOf(r, 'PF_EE')?.amountPaise).toBe(BigInt(L(1_800)))
  })
})

describe('EDLI is an employer cost on top of the 12%', () => {
  it('is booked at 0.5% of the capped wage', () => {
    const r = computePayroll(input(), OPTS)
    // 0.5% of 15,000 = 75.
    expect(lineOf(r, 'EDLI_ER')?.amountPaise).toBe(BigInt(L(75)))
  })

  it('does not change the employee net', () => {
    const withEdli = computePayroll(input(), OPTS)
    const withoutEdli = computePayroll(input(), { ...OPTS, statutory: { ...STATUTORY, edli_rate: 0 } })
    expect(withEdli.netPaise).toBe(withoutEdli.netPaise)
  })
})

describe('ESI rounds up, not to the nearest', () => {
  it('rounds a part-rupee up', () => {
    // 0.75% of 18,001 is 135.0075 -> 136, not 135.
    expect(toRupeeUp(L(18_001) * 0.0075)).toBe(BigInt(L(136)))
    expect(toRupee(L(18_001) * 0.0075)).toBe(BigInt(L(135)))
  })

  it('leaves an exact rupee alone', () => {
    expect(toRupeeUp(L(100))).toBe(BigInt(L(100)))
  })

  it('applies it to the contribution lines', () => {
    const r = computePayroll(input({ esiApplicable: true, monthlyComponents: { basic: L(18_001) } }), OPTS)
    const ee = lineOf(r, 'ESI_EE')!.amountPaise
    expect(ee % 100n).toBe(0n)
    expect(ee).toBe(toRupeeUp(L(18_001) * 0.0075))
  })
})

describe('ESI cover holds for the whole contribution period', () => {
  const overCeiling = { esiApplicable: true, monthlyComponents: { basic: L(25_000) } }

  it('someone over the ceiling is not covered when the period starts', () => {
    const r = computePayroll(input(overCeiling), OPTS)
    expect(lineOf(r, 'ESI_EE')).toBeUndefined()
  })

  it('but a raise mid-period does NOT drop someone already covered', () => {
    // The bug: the ceiling was re-tested every month, so a July raise ended
    // cover in July. Cover is settled at the START of a half-year period and
    // runs to its end.
    const r = computePayroll(input({ ...overCeiling, esiCoveredPeriod: true }), OPTS)
    expect(lineOf(r, 'ESI_EE')?.amountPaise).toBeGreaterThan(0n)
  })

  it('and the flag cannot cover someone ESI never applied to', () => {
    const r = computePayroll(input({ esiApplicable: false, esiCoveredPeriod: true }), OPTS)
    expect(lineOf(r, 'ESI_EE')).toBeUndefined()
  })
})

describe('gratuity under the Labour Codes', () => {
  const joined = new Date('2023-01-01')
  const left = new Date('2025-06-30')

  it('a fixed-term employee qualifies after one year, not five', () => {
    // Code on Social Security 2020, s.53(1) proviso. Before this, a fixed-term
    // employee of two and a half years was told they had no gratuity at all.
    const permanent = gratuity({ wagePaise: L(30_000), dateOfJoining: joined, lastWorkingDay: left })
    const fixedTerm = gratuity({ wagePaise: L(30_000), dateOfJoining: joined, lastWorkingDay: left, fixedTerm: true })
    expect(permanent.eligible).toBe(false)
    expect(fixedTerm.eligible).toBe(true)
    expect(fixedTerm.amountPaise).toBeGreaterThan(0)
  })

  it('still needs a full year, even fixed-term', () => {
    const r = gratuity({
      wagePaise: L(30_000), dateOfJoining: new Date('2025-01-01'),
      lastWorkingDay: new Date('2025-08-01'), fixedTerm: true,
    })
    expect(r.eligible).toBe(false)
  })

  it('raises wages to half of remuneration when the basic is shrunk', () => {
    // 30% basic, 70% allowances. The Codes cap excluded allowances at half of
    // remuneration, so gratuity computes on 50,000, not 30,000 -- the
    // provision exists precisely to stop the basic being shrunk.
    const shrunk = gratuity({
      wagePaise: L(30_000), totalRemunerationPaise: L(100_000),
      dateOfJoining: new Date('2015-01-01'), lastWorkingDay: new Date('2025-01-01'),
    })
    const asGiven = gratuity({
      wagePaise: L(30_000),
      dateOfJoining: new Date('2015-01-01'), lastWorkingDay: new Date('2025-01-01'),
    })
    expect(shrunk.amountPaise).toBeGreaterThan(asGiven.amountPaise)
    expect(shrunk.note).toContain('50% of remuneration')
  })

  it('leaves an honest structure alone', () => {
    // Basic already above half of remuneration: nothing to add back.
    const r = gratuity({
      wagePaise: L(60_000), totalRemunerationPaise: L(100_000),
      dateOfJoining: new Date('2015-01-01'), lastWorkingDay: new Date('2025-01-01'),
    })
    const same = gratuity({
      wagePaise: L(60_000),
      dateOfJoining: new Date('2015-01-01'), lastWorkingDay: new Date('2025-01-01'),
    })
    expect(r.amountPaise).toBe(same.amountPaise)
  })

  it('still caps at twenty lakh', () => {
    const r = gratuity({
      wagePaise: L(500_000), totalRemunerationPaise: L(1_000_000),
      dateOfJoining: new Date('1995-01-01'), lastWorkingDay: new Date('2025-01-01'),
    })
    expect(r.amountPaise).toBe(GRATUITY_CAP_PAISE)
    expect(r.computedPaise).toBeGreaterThan(GRATUITY_CAP_PAISE)
  })
})

describe('professional tax exemptions', () => {
  const MH_SLABS = [
    { state_code: 'MH', gross_from_paise: String(L(7_500)), gross_to_paise: String(L(10_000)), amount_paise: String(L(175)), month_override: null },
    { state_code: 'MH', gross_from_paise: String(L(10_000)), gross_to_paise: null, amount_paise: String(L(200)), month_override: null },
  ] as never
  const EXEMPTIONS = [{ state_code: 'MH', gender: 'female', gross_upto_paise: String(L(25_000)) }]

  it('exempts a woman in Maharashtra below the threshold', () => {
    // PEPL applied the general slab to everyone and the reference table said
    // so in a note. A note is not a deduction: this was money taken monthly
    // from people who did not owe it.
    expect(ptFor(MH_SLABS, 'MH', BigInt(L(20_000)), undefined, 'female', EXEMPTIONS)).toBe(0n)
  })

  it('still charges her above the threshold', () => {
    expect(ptFor(MH_SLABS, 'MH', BigInt(L(30_000)), undefined, 'female', EXEMPTIONS)).toBe(BigInt(L(200)))
  })

  it('charges everyone else at the same salary', () => {
    expect(ptFor(MH_SLABS, 'MH', BigInt(L(20_000)), undefined, 'male', EXEMPTIONS)).toBe(BigInt(L(200)))
    expect(ptFor(MH_SLABS, 'MH', BigInt(L(20_000)), undefined, null, EXEMPTIONS)).toBe(BigInt(L(200)))
  })

  it('does not leak the exemption into another state', () => {
    const tsSlabs = [{ state_code: 'TS', gross_from_paise: '0', gross_to_paise: null, amount_paise: String(L(200)), month_override: null }] as never
    expect(ptFor(tsSlabs, 'TS', BigInt(L(20_000)), undefined, 'female', EXEMPTIONS)).toBe(BigInt(L(200)))
  })

  it('behaves exactly as before when no exemptions are configured', () => {
    expect(ptFor(MH_SLABS, 'MH', BigInt(L(20_000)), undefined, 'female', [])).toBe(BigInt(L(200)))
  })
})
