/** The v1 freeze route trusted its body (`as never`). Malformed rows are now a 422, not a wrong payslip (PAY-13). */
import { describe, it, expect } from 'vitest'
import { freezeRowProblems } from '../src/payroll/freeze-rows.ts'

const good = { employeeId: '11111111-1111-1111-1111-111111111111', calendarDays: 30, payableDays: 28, lopDays: 2,
  monthlyComponents: { basic: 2000000 }, annualCtcPaise: 24000000, stateCode: 'TS', pfApplicable: true }

describe('freeze row validation', () => {
  it('accepts a well-formed row', () => expect(freezeRowProblems([good])).toEqual([]))
  it('rejects non-arrays and empty input', () => {
    expect(freezeRowProblems(undefined)).not.toEqual([])
    expect(freezeRowProblems([])).not.toEqual([])
  })
  it('rejects negative, non-numeric and impossible day counts', () => {
    expect(freezeRowProblems([{ ...good, lopDays: -1 }])).not.toEqual([])
    expect(freezeRowProblems([{ ...good, payableDays: '28' }])).not.toEqual([])
    expect(freezeRowProblems([{ ...good, payableDays: 30, lopDays: 5 }])).not.toEqual([])
  })
  it('rejects bad components, state codes, ids and duplicates', () => {
    expect(freezeRowProblems([{ ...good, monthlyComponents: {} }])).not.toEqual([])
    expect(freezeRowProblems([{ ...good, monthlyComponents: { basic: 'x' } }])).not.toEqual([])
    expect(freezeRowProblems([{ ...good, stateCode: 'Telangana' }])).not.toEqual([])
    expect(freezeRowProblems([{ ...good, employeeId: 'nope' }])).not.toEqual([])
    expect(freezeRowProblems([good, good]).some((p) => /twice/.test(p))).toBe(true)
  })
})
