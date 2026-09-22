/**
 * Anomaly guards (D1). Payroll: a shared bank account, a shared PAN, a
 * leaver still paid, a joiner paid a full month, and a total-net jump are
 * found on a calculated run; approval refuses while a blocking one is open;
 * dismissing needs a reason; a re-run does not duplicate; findings are never
 * deleted by the app role. Attendance: an overlong day is flagged nightly.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { createRun, freezeInputs, calculate, validate, approve, lock } from '../src/payroll/run.ts'
import { runPayrollGuards, listFindings, dismissFinding, runAttendanceGuards, assertNoOpenBlockers } from '../src/payroll/guards.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let A: Tenant; let hrUser: string; let approver: string; let statutoryId: string
const L = (r: number): number => r * 100
const others: string[] = []
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(`INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise) VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'ghr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['payroll_admin'] })
    approver = await createUser(tx, { tenantId: A.id, email: 'gap@acme.test', fullName: 'Approver', password: 'a-long-password-1', roles: ['payroll_admin'] })
    for (let i = 1; i <= 3; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining, date_of_exit, status) VALUES ($1,$2,$3,$4::date,$5::date,$6) RETURNING id`,
        [A.id, `A-G${i}`, `G${i}`, i === 3 ? '2026-10-20' : '2024-01-01', i === 2 ? '2026-08-31' : null, i === 2 ? 'exited' : 'active'])).rows[0]!.id
      others.push(id)
    }
    // G1 shares Rahul's bank account and PAN
    for (const e of [A.employeeId, others[0]!]) {
      await tx.query(`INSERT INTO employee_bank_accounts (tenant_id, employee_id, beneficiary_name, account_number, ifsc) VALUES ($1,$2,'Joint','123456789012','HDFC0000001')`, [A.id, e])
    }
    // a duplicate PAN cannot even be stored (032 has a unique index) — the guard is belt to that brace
    await tx.query(`INSERT INTO employee_statutory_ids (tenant_id, employee_id, pan) VALUES ($1,$2,'ABCPE1234F')`, [A.id, A.employeeId])
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

const OPTS: EngineOptions = { statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)), esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) }, ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days' }
const row = (employeeId: string, basic: number, extra: Partial<{ payableDays: number; lopDays: number }> = {}): Parameters<typeof freezeInputs>[2][number] => ({ employeeId, calendarDays: 31, payableDays: extra.payableDays ?? 31, lopDays: extra.lopDays ?? 0, monthlyComponents: { basic: L(basic) }, annualCtcPaise: L(basic * 12), stateCode: 'KA' })

describe('payroll guards', () => {
  it('finds the anomalies, blocks approval, dismisses with a reason, does not duplicate', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      // September, locked: the baseline for the jump checks (2 people, 60k net-ish)
      const sep = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])).rows[0]!.id
      const r0 = await createRun(tx, { periodId: sep, processedByUserId: hrUser })
      await freezeInputs(tx, r0, [row(A.employeeId, 30_000), row(others[0]!, 30_000)], {}, statutoryId)
      await calculate(tx, r0, OPTS); await validate(tx, r0, { ...OPTS, variancePct: 25 })
      await approve(tx, r0, approver, { requireSeparateApprover: true }); await lock(tx, r0, approver, { requireSeparateApprover: true })
      // October: everyone, including the leaver and the mid-month joiner paid in full, and a doubled salary
      const oct = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01') RETURNING id`, [A.id])).rows[0]!.id
      const r1 = await createRun(tx, { periodId: oct, processedByUserId: hrUser })
      await expect(runPayrollGuards(tx, cfg, r1)).rejects.toMatchObject({ code: 'RUN_NOT_CALCULATED' })
      await freezeInputs(tx, r1, [row(A.employeeId, 60_000), row(others[0]!, 60_000), row(others[1]!, 30_000), row(others[2]!, 30_000)], {}, statutoryId)
      await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status) VALUES ($1,$2,DATE '2026-10-05','absent')`, [A.id, others[0]])
      await calculate(tx, r1, OPTS); await validate(tx, r1, { ...OPTS, variancePct: 500 })
      const g = await runPayrollGuards(tx, cfg, r1)
      const codes = g.findings.map((f) => f.code).sort()
      expect(codes).toContain('DUPLICATE_BANK_ACCOUNT')
      expect(codes).toContain('EXITED_STILL_PAID')
      expect(codes).toContain('JOINER_FULL_MONTH')
      expect(codes).toContain('TOTAL_NET_JUMP')
      expect(codes).toContain('HEADCOUNT_JUMP')
      expect(codes).toContain('ABSENT_BUT_FULL_PAY')
      expect(g.blocking).toBeGreaterThanOrEqual(3)
      // approval refuses
      await expect(approve(tx, r1, approver, { requireSeparateApprover: true })).rejects.toMatchObject({ code: 'ANOMALIES_OPEN' })
      // a re-run refreshes, never duplicates
      const again = await runPayrollGuards(tx, cfg, r1)
      expect(again.opened).toBe(0)
      expect(again.findings.length).toBe(g.findings.length)
      // dismiss every blocker with a reason
      await expect(dismissFinding(tx, { id: g.findings[0]!.id, reason: 'ok', userId: approver })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      for (const f of g.findings.filter((x) => x.severity === 'blocking')) await dismissFinding(tx, { id: f.id, reason: 'Reviewed with finance; intentional for the test', userId: approver })
      await expect(assertNoOpenBlockers(tx, r1)).resolves.toBeUndefined()
      await approve(tx, r1, approver, { requireSeparateApprover: true })
      expect((await listFindings(tx, { runId: r1, status: 'dismissed' })).every((f) => f.dismiss_reason && f.dismissed_by_user_id === approver)).toBe(true)
      expect((await listFindings(tx, { runId: r1, status: 'open' })).every((f) => f.severity !== 'blocking')).toBe(true)
    })
    await expect(withTenant(A.id, (tx) => tx.query(`DELETE FROM anomaly_findings`))).rejects.toThrow(/permission denied/i)
  })
})

describe('attendance guards', () => {
  it('flags an overlong day once', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status, worked_minutes) VALUES ($1,$2,current_date - 1,'present',16*60)`, [A.id, A.employeeId])
      expect((await runAttendanceGuards(tx, cfg)).opened).toBe(1)
      expect((await runAttendanceGuards(tx, cfg)).opened).toBe(0)
      const f = (await listFindings(tx, { area: 'attendance' }))[0]!
      expect(f).toMatchObject({ code: 'OVERLONG_DAY', severity: 'warning', employee_id: A.employeeId })
      expect(f.message).toMatch(/16\.0 h/)
    })
  })
})
