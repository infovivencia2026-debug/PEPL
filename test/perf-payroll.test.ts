/**
 * Payroll throughput. OFF unless PEPL_PERF is set: a timing assertion on a busy shared machine is a flaky test,
 * so it is run on purpose (`PEPL_PERF=1 npx vitest run test/perf-payroll.test.ts`), never by `npm test`.
 *
 * It measures the part a customer feels grow with headcount, the per-employee computation, and checks that
 * the cost is LINEAR: ten times the people must not take much more than ten times as long. The thresholds are
 * generous on purpose; they catch a quadratic mistake, not a slow disk. It times the computation only, not the
 * database round trips of a full run.
 */
import { describe, it, expect } from 'vitest'
import { computePayroll, type EngineOptions, type PayrollInput } from '../src/payroll/engine.ts'

const L = (r: number): number => r * 100
const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: (_state, gross) => (gross >= BigInt(L(20_000)) ? BigInt(L(200)) : 0n),
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}
const person = (i: number): PayrollInput => ({
  employeeId: `e${i}`, calendarDays: 30, payableDays: 30 - (i % 4), lopDays: i % 4,
  monthlyComponents: { basic: L(20_000 + (i % 50) * 500), hra: L(8_000), special: L(12_000) },
  stateCode: 'TS', pfApplicable: true, esiApplicable: i % 7 === 0, taxRegime: i % 3 === 0 ? 'old' : 'new', adhoc: [],
})

const run = (n: number): number => {
  const people = Array.from({ length: n }, (_, i) => person(i))
  const t0 = performance.now()
  for (const p of people) computePayroll(p, OPTS)
  return performance.now() - t0
}

describe.skipIf(!process.env.PEPL_PERF)('payroll computation scales linearly', () => {
  it('5,000 people compute in under 5 seconds, and 10x the people costs well under 20x the time', () => {
    run(200)                                  // warm up the JIT so the first measurement is not the slow one
    const small = Math.max(run(500), 1)
    const large = run(5_000)
    console.log(`500 people: ${small.toFixed(0)} ms, 5,000 people: ${large.toFixed(0)} ms (x${(large / small).toFixed(1)})`)
    expect(large).toBeLessThan(5_000)
    expect(large / small).toBeLessThan(20)
  })
})
