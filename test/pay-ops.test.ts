/**
 * Pay operations (B5). The journal for a locked run balances to the paisa
 * and posts cost centres on expense heads only; Tally XML renders and refuses
 * an unbalanced journal; a bank return file settles or fails instructions by
 * reference with the UTR; per-diem prices itself from the rate table and
 * needs no receipt; project profitability nets revenue against CTC-based cost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { generateBankFile } from '../src/payments/bank-file.ts'
import { buildJournal, journalCsv, journalTallyXml, listMappings, upsertMapping, reconcileBatch, paymentStatus } from '../src/payroll/journal.ts'
import { seedDefaultCategories, listCategories, upsertPerDiemRate, submitClaim } from '../src/work/expenses.ts'
import { upsertProject, allocate, getWeek, setHours, submitWeek, profitabilityReport } from '../src/work/timesheets.ts'
import { changeCompensation } from '../src/people/history.ts'
import { act } from '../src/approvals/index.ts'
import { settleDecision } from '../src/approvals/settle.ts'
import { resolveConfig } from '../src/config/resolver.ts'

let A: Tenant
let hrUser: string; let empUser: string; let mgrUser: string
const PROCESSOR = 'a1000000-0000-0000-0000-0000000000a1'
const APPROVER = 'b1000000-0000-0000-0000-0000000000b1'
const L = (r: number): number => r * 100
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)), esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}
let runId = ''
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(`INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise) VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])
  const statutoryId = rows[0]!.id
  await withTenant(A.id, async (tx) => {
    const mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-PMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, mgr])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'pmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'phr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'pemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await tx.query(`INSERT INTO employee_bank_accounts (tenant_id, employee_id, beneficiary_name, account_number, ifsc, bank_name) VALUES ($1,$2,'Rahul Sharma','50100123456789','HDFC0001234','HDFC Bank')`, [A.id, A.employeeId])
    const periodId = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])).rows[0]!.id
    runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [{ employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { basic: L(20_000), hra: L(8_000) }, annualCtcPaise: L(336_000), stateCode: 'TS' }], {}, statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 25 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('journal', () => {
  it('refuses an unlocked run; balances to the paisa once locked; cost centres sit on expense heads only; Tally XML renders', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(buildJournal(tx, runId)).rejects.toMatchObject({ code: 'RUN_NOT_LOCKED' })
      await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
      expect((await listMappings(tx)).length).toBeGreaterThanOrEqual(11)
      const j = await buildJournal(tx, runId)
      expect(j.balanced).toBe(true)
      expect(j.unmapped).toEqual([])
      expect(j.totalDebitPaise).toBe(j.totalCreditPaise)
      expect(j.totalDebitPaise).toBeGreaterThan(0n)
      const wages = j.lines.filter((l) => l.account === 'Salaries & Wages')
      expect(wages.every((l) => l.costCentre === 'Engineering')).toBe(true)          // expense by department
      const payable = j.lines.filter((l) => l.account === 'Salary Payable')
      expect(payable.every((l) => l.costCentre === null)).toBe(true)                    // a liability, never split
      const pf = j.lines.find((l) => l.account === 'PF Payable')!
      expect(pf.creditPaise).toBe(BigInt(L(1_800) * 2))                                 // 12% employee + 12% employer on ₹15,000 ceiling
      // net pay is what remains payable: gross − employee deductions
      const payableNet = payable.reduce((s, l) => s + l.creditPaise - l.debitPaise, 0n)
      const net = (await tx.query<{ n: string }>(`SELECT net_paise::text AS n FROM payslips WHERE run_id = $1`, [runId])).rows[0]!.n
      expect(payableNet).toBe(BigInt(net))
      expect(journalCsv(j)).toContain('TOTAL')
      const xml = journalTallyXml(j, 'Alpha Technologies Pvt Ltd')
      expect(xml).toContain('<VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>')
      expect(xml).toContain('<LEDGERNAME>PF Payable</LEDGERNAME>')
      // a remapped component still balances; an unbalanced journal cannot render
      await upsertMapping(tx, { componentCode: 'HRA', debitAccount: 'House Rent Allowance', creditAccount: 'Salary Payable' })
      const j2 = await buildJournal(tx, runId)
      expect(j2.balanced).toBe(true)
      expect(j2.lines.some((l) => l.account === 'House Rent Allowance')).toBe(true)
      expect(() => journalTallyXml({ ...j2, balanced: false }, 'x')).toThrow(/balance/)
    })
  })

  it('reconciles a bank return file by reference; settled lines carry the UTR; failures are listed for re-pay', async () => {
    await withTenant(A.id, async (tx) => {
      const batch = await generateBankFile(tx, { runId, format: 'generic_neft_csv', valueDate: '2026-10-01', generatedByUserId: APPROVER })
      const ref = (await tx.query<{ reference: string; amount_paise: string }>(`SELECT reference, amount_paise::text FROM payment_instructions WHERE batch_id = $1`, [batch.batchId])).rows[0]!
      const r = await reconcileBatch(tx, { batchId: batch.batchId, lines: [{ reference: ref.reference, status: 'settled', utr: 'HDFCN52026100112345' }, { reference: 'NOPE', status: 'failed', reason: 'unknown' }] })
      expect(r).toMatchObject({ matched: 1, settled: 1, failed: 0 })
      expect(r.unmatched).toHaveLength(1)
      const st = await paymentStatus(tx, runId)
      expect(st).toMatchObject({ batches: 1, instructions: 1, settled: 1, failed: 0, pending: 0 })
      expect((await tx.query<{ utr: string; status: string }>(`SELECT utr, status FROM payment_instructions WHERE batch_id = $1`, [batch.batchId])).rows[0]).toEqual({ utr: 'HDFCN52026100112345', status: 'settled' })
      expect((await tx.query<{ s: string }>(`SELECT status AS s FROM payment_batches WHERE id = $1`, [batch.batchId])).rows[0]!.s).toBe('settled')
      await expect(reconcileBatch(tx, { batchId: batch.batchId, lines: [{ reference: ref.reference, status: 'bogus' as never }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })
  })
})

describe('per-diem', () => {
  it('prices from the grade rate (else the all-grades rate), needs no receipt, and refuses without a rate', async () => {
    await withTenant(A.id, async (tx) => {
      await seedDefaultCategories(tx)
      const travel = (await listCategories(tx)).find((c) => c.code === 'TRAVEL')!
      const base = { employeeId: A.employeeId, requestedByUserId: empUser, categoryId: travel.id, incurredOn: '2026-09-15', description: 'Client visit, Mumbai', fallbackChain: 'manager' as const }
      await expect(submitClaim(tx, { ...base, perDiem: { cityClass: 'metro', days: 2 } })).rejects.toMatchObject({ code: 'PER_DIEM_RATE_MISSING' })
      await upsertPerDiemRate(tx, { cityClass: 'metro', ratePaise: L(2_000), effectiveFrom: '2026-01-01' })
      await upsertPerDiemRate(tx, { cityClass: 'metro', gradeCode: 'G7', ratePaise: L(3_500), effectiveFrom: '2026-01-01' })
      const r = await submitClaim(tx, { ...base, perDiem: { cityClass: 'metro', days: 2, halfDays: 1 } })
      expect(r.claim.amount_paise).toBe(String(L(2_000) * 2 + L(1_000)))               // no grade on record → all-grades rate; half day at 50 %
      expect(r.claim.per_diem).toMatchObject({ cityClass: 'metro', days: 2, halfDays: 1, ratePaise: L(2_000) })
      await expect(submitClaim(tx, { ...base, incurredOn: '2026-09-16', perDiem: { cityClass: 'metro', days: 0 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })
  })
})

describe('project profitability', () => {
  it('nets billable revenue against hours costed at CTC / 12 / 173', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(1_200_000), components: { BASIC: L(50_000) }, effectiveFrom: '2026-01-01', reason: 'seed', actorUserId: hrUser })
      const p = await upsertProject(tx, { code: 'ACME-WEB', name: 'Acme website', client: 'Acme', billable: true, billRatePaisePerHour: L(2_500) })
      await allocate(tx, { projectId: p.id, employeeId: A.employeeId, percent: 100, startsOn: '2026-09-01' })
      const week = await getWeek(tx, A.employeeId, '2026-09-07')
      for (const d of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10']) await setHours(tx, { employeeId: A.employeeId, projectId: p.id, workDate: d, hours: 8, billable: true })
      const sub = await submitWeek(tx, { employeeId: A.employeeId, weekStart: week.week_start, requestedByUserId: empUser, fallbackChain: 'manager' })
      await act(tx, { requestId: sub.approval_request_id!, actorUserId: mgrUser, action: 'approve' })
      await settleDecision(tx, cfg, { requestId: sub.approval_request_id!, status: 'approved', actorUserId: mgrUser })
      const [row] = await profitabilityReport(tx, { from: '2026-09-01', to: '2026-09-30', projectId: p.id })
      expect(row).toMatchObject({ project_code: 'ACME-WEB', hours: 32, billable_hours: 32, revenue_paise: String(32 * L(2_500)) })
      const expectedCost = Math.floor(32 * L(1_200_000) / 12 / 173)                     // ₹100,000 a month ÷ 173 h × 32 h
      expect(Math.abs(Number(row!.cost_paise) - expectedCost)).toBeLessThanOrEqual(1)
      expect(row!.margin_pct).toBeGreaterThan(0)
    })
  })
})
