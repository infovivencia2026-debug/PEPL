/**
 * Reports read the same rows as the payslip and the ledger, so they cannot
 * disagree with them. Locked runs only; superseded runs excluded; CSV quotes
 * what needs quoting.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import { headcount, leaveBalances, salaryRegister, statutorySummary } from '../src/reports/index.ts'
import { createLeaveType } from '../src/leave/policy.ts'
import { appendEntry } from '../src/leave/ledger.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
let A: Tenant
let statutoryId: string
let secondEmp: string
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) },
  ptAmountPaise: () => BigInt(L(200)), pfOnFullWage: false, lopBasis: 'calendar_days',
  computeTds: (a) => ({ monthlyTdsPaise: BigInt(Math.round(Number(a.monthlyTaxableGrossPaise) * 0.1 / 100) * 100), trace: {} }),
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    await tx.query(`UPDATE employees SET date_of_joining = DATE '2026-01-15' WHERE id = $1`, [A.employeeId])
    secondEmp = (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining, date_of_exit, status)
       VALUES ($1,'A-002','Meera','O''Brien, Jr',DATE '2025-06-01',DATE '2026-09-10','exited') RETURNING id`, [A.id])).rows[0]!.id
    const p = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])
    const run = await createRun(tx, { periodId: p.rows[0]!.id, processedByUserId: PROCESSOR })
    await freezeInputs(tx, run, [
      { employeeId: A.employeeId, calendarDays: 30, payableDays: 28, lopDays: 2, monthlyComponents: { BASIC: L(20_000), HRA: L(8_000) }, annualCtcPaise: L(336_000), stateCode: 'TS', pfApplicable: true },
      { employeeId: secondEmp, calendarDays: 30, payableDays: 10, lopDays: 0, monthlyComponents: { BASIC: L(30_000) }, annualCtcPaise: L(360_000), stateCode: 'TS', pfApplicable: true, exitedMidPeriod: true },
    ], {}, statutoryId)
    await calculate(tx, run, OPTS); await validate(tx, run, { ...OPTS, variancePct: 1000 })
    await approve(tx, run, APPROVER, { requireSeparateApprover: true }); await lock(tx, run, APPROVER, { requireSeparateApprover: true })
    // an unlocked run in October must not appear
    const p2 = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01') RETURNING id`, [A.id])
    const draft = await createRun(tx, { periodId: p2.rows[0]!.id, processedByUserId: PROCESSOR })
    await freezeInputs(tx, draft, [{ employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0, monthlyComponents: { BASIC: L(20_000) }, annualCtcPaise: L(240_000), stateCode: 'TS', pfApplicable: true }], {}, statutoryId)
    await calculate(tx, draft, OPTS)
    const el = await createLeaveType(tx, { code: 'EL', name: 'Earned' })
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el.id, entryType: 'opening', deltaDays: 10, effectiveDate: '2026-01-01', cycleYear: 2026, idempotencyKey: 'o' })
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el.id, entryType: 'accrual', deltaDays: 1.5, effectiveDate: '2026-02-01', cycleYear: 2026, idempotencyKey: 'a' })
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el.id, entryType: 'consumption', deltaDays: -2, effectiveDate: '2026-03-01', cycleYear: 2026, idempotencyKey: 'c' })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('salary register', () => {
  it('one row per employee per locked run, components as columns, earnings before deductions, CSV quoted', async () => {
    const r = await withTenant(A.id, (tx) => salaryRegister(tx, { from: '2026-09-01', to: '2026-10-31' }))
    expect(r.rows).toHaveLength(2)                                   // October is not locked
    expect(r.columns.slice(0, 7)).toEqual(['period', 'employee_number', 'name', 'department', 'designation', 'payable_days', 'lop_days'])
    const comps = r.columns.slice(7, -3)
    expect(comps.indexOf('BASIC')).toBeLessThan(comps.indexOf('PF_EE'))
    expect(comps.indexOf('PF_EE')).toBeLessThan(comps.indexOf('PF_ER'))
    const rahul = r.rows.find((x) => x.employee_number === 'A-001')!
    // 28,000 gross less 2/30 LOP = 26,133 rupees, matches the payslip
    expect(rahul.gross).toBe(26_133)
    expect(rahul.LOP).toBe(1_867)
    expect(rahul.PF_EE).toBe(1_800)
    expect(rahul.net).toBe(Number(rahul.gross) - Number(rahul.deductions))
    expect(r.csv.split('\n')[0]!.startsWith('period,employee_number,name')).toBe(true)
    expect(r.csv).toContain('"Meera O\'Brien, Jr"')                    // the comma forces quoting
  })
})

describe('statutory summary', () => {
  it('totals per run agree with the lines', async () => {
    const r = await withTenant(A.id, (tx) => statutorySummary(tx, { from: '2026-09-01', to: '2026-12-31' }))
    expect(r.rows).toHaveLength(1)
    const s = r.rows[0]!
    expect(s.employees).toBe(2)
    expect(s.pf_employee).toBe(1_800 + 1_200)                        // second: 30,000 × 10/30 = 10,000 basic, 12%
    expect(s.pf_total).toBe(Number(s.pf_employee) + Number(s.pf_employer))
    expect(s.pt).toBe(400)
    expect(Number(s.tds)).toBeGreaterThan(0)
  })
})

describe('statutory summary: employer provident fund is EPF + EPS, with EDLI on top', () => {
  // The engine splits the employer's 12% into PF_ER (the EPF share) and PF_EPS (the pension
  // share), and adds EDLI_ER on top. The summary read PF_ER alone, so "pf_employer" reported
  // only the EPF share (here Rs 600 of an employer cost of Rs 1,800) and dropped EDLI, and
  // the existing test asserted pf_total = pf_employee + pf_employer, which restates the code.
  // The expected figures here are worked from the rates, not read back from the report.
  it('reports the whole employer contribution, EDLI separately, and a total that includes both', async () => {
    const OPTS_SPLIT: EngineOptions = {
      ...OPTS,
      statutory: { ...OPTS.statutory, eps_rate: 0.08, edli_rate: 0.005 },
      computeTds: undefined,
    }
    await withTenant(A.id, async (tx) => {
      const p = await tx.query<{ id: string }>(
        `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-11',DATE '2026-11-01',DATE '2026-11-30',DATE '2026-12-01') RETURNING id`, [A.id])
      const run = await createRun(tx, { periodId: p.rows[0]!.id, processedByUserId: PROCESSOR })
      // Basic exactly at the Rs 15,000 wage ceiling, a full month: no LOP arithmetic to muddy the oracle.
      await freezeInputs(tx, run, [{ employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { BASIC: L(15_000) }, annualCtcPaise: L(180_000), stateCode: 'TS', pfApplicable: true }], {}, statutoryId)
      await calculate(tx, run, OPTS_SPLIT); await validate(tx, run, { ...OPTS_SPLIT, variancePct: 1000 })
      await approve(tx, run, APPROVER, { requireSeparateApprover: true }); await lock(tx, run, APPROVER, { requireSeparateApprover: true })
    })
    const r = await withTenant(A.id, (tx) => statutorySummary(tx, { from: '2026-11-01', to: '2026-11-30' }))
    const s = r.rows[0]!
    expect(s.pf_employee).toBe(1_800)                  // 12% of 15,000
    expect(s.pf_employer).toBe(1_800)                  // EPF 600 + EPS 1,200 (8%): the employer's 12%, not just the 600
    expect(s.edli_employer).toBe(75)                   // 0.5% of 15,000, on top
    expect(s.pf_total).toBe(3_675)                     // 1,800 + 1,800 + 75: what is remitted to the EPFO
    expect(r.columns).toContain('edli_employer')
  })
})

describe('headcount', () => {
  it('counts joiners, leavers and the active total at month end', async () => {
    const r = await withTenant(A.id, (tx) => headcount(tx, { from: '2026-01-01', to: '2026-10-31' }))
    const by = Object.fromEntries(r.rows.map((x) => [x.month, x]))
    expect(by['2026-01']).toMatchObject({ joined: 1, left: 0, active_at_end: 2 })
    expect(by['2026-09']).toMatchObject({ joined: 0, left: 1, active_at_end: 1, attrition_pct: 50 })
    expect(by['2026-10']).toMatchObject({ active_at_end: 1 })
  })
})

describe('leave balances', () => {
  it('opening + accrued − consumed, per type, as of a date', async () => {
    const r = await withTenant(A.id, (tx) => leaveBalances(tx, { cycleYear: 2026 }))
    expect(r.rows).toEqual([expect.objectContaining({ employee_number: 'A-001', leave_type: 'EL', opening: 10, accrued: 1.5, consumed: 2, available: 9.5 })])
    const early = await withTenant(A.id, (tx) => leaveBalances(tx, { cycleYear: 2026, asOf: '2026-02-15' }))
    expect(early.rows[0]!.available).toBe(11.5)
    expect(r.csv.trim().split('\n')).toHaveLength(2)
  })
})
