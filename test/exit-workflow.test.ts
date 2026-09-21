/**
 * Exit end to end: the employee resigns (manager and HR told), HR accepts —
 * separation created with the notice from the record, five clearances open,
 * the offboarding checklist starts — clearance recoveries roll onto the F&F,
 * payroll refuses to settle while any area is pending and settles once all
 * have signed, the exit interview stays with HR, and the relieving letter is
 * issued only after settlement, once.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeAssignment, changeCompensation } from '../src/people/history.ts'
import { updateEmployee } from '../src/people/profile.ts'
import { createTemplate } from '../src/work/templates.ts'
import {
  submitResignation, withdrawResignation, acceptResignation, declineResignation, clearArea, listClearances,
  recordExitInterview, issueRelievingLetter, exitOverview,
} from '../src/people/exit-workflow.ts'
import { settlementForFreeze, getSeparation } from '../src/payroll/exit.ts'
import { attrition } from '../src/reports/index.ts'
import { createRun, freezeInputs, calculate, validate, approve, lock } from '../src/payroll/run.ts'
import { ensurePeriod } from '../src/payroll/periods.ts'
import { readDocument } from '../src/documents/index.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

const L = (r: number): number => r * 100
let A: Tenant
let manager: string; let managerUser: string; let hrUser: string; let empUser: string
let statutoryId: string
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)), esi_employee_rate: 0, esi_employer_rate: 0, esi_gross_threshold_paise: 0n },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0, 0, 0) RETURNING id`, [String(L(15_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-MGR','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    managerUser = await createUser(tx, { tenantId: A.id, email: 'mgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'hr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'emp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await changeAssignment(tx, { employeeId: A.employeeId, department: 'Sales', designation: 'Executive', managerEmployeeId: manager, effectiveFrom: '2026-06-01' })
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000), components: { BASIC: L(30_000) }, effectiveFrom: '2025-01-01', reason: 'offer' })
    await updateEmployee(tx, A.employeeId, { noticePeriodDays: 30 })
    await createTemplate(tx, { name: 'Leaver', trigger: 'offboarding', items: [
      { title: 'Collect laptop', assigneeRule: 'it', dueOffsetDays: 0, blocksCompletion: true },
      { title: 'Knowledge transfer', assigneeRule: 'manager', dueOffsetDays: -5 },
    ] })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('resignation', () => {
  it('is submitted once, notifies manager and HR, can be withdrawn, and HR can decline with a reason', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2026-10-15', reason: 'Relocating', reasonCategory: 'relocation' })
      expect(r.status).toBe('submitted')
      expect(r.notice_period_days).toBe(30)
      expect(r.earliest_last_day > r.requested_last_day).toBe(true)                 // asked to leave before notice completes
      await expect(submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2026-12-31', reason: 'again' })).rejects.toMatchObject({ code: 'RESIGNATION_OPEN' })
      const told = (await tx.query<{ user_id: string }>(`SELECT user_id FROM notifications WHERE event_type = 'exit.resignation.submitted'`)).rows.map((x) => x.user_id).sort()
      expect(told).toEqual([hrUser, managerUser].sort())
      await withdrawResignation(tx, r.id, A.employeeId)
      const again = await submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2026-12-31', reason: 'Better opportunity', reasonCategory: 'better_opportunity' })
      await declineResignation(tx, again.id, 'retained with a counter-offer', hrUser)
      const o = await exitOverview(tx, A.employeeId)
      expect(o.separation).toBeNull()
      expect(o.resignation!.status).toBe('declined')
    })
  })
})

describe('acceptance, clearance, settlement, letter', () => {
  let sepId = ''
  it('HR accepts: separation with notice, five clearances, checklist tasks; recoveries roll up; HR signs last', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2026-10-31', reason: 'Moving on' })
      const a = await acceptResignation(tx, { resignationId: r.id, actorUserId: hrUser })
      sepId = a.separation.id
      expect(a.separation).toMatchObject({ reason: 'resignation', last_working_day: '2026-10-31', notice_days_required: 30, status: 'initiated' })
      expect(a.tasks).toBe(2)
      expect(a.resignation.status).toBe('accepted')
      const cl = await listClearances(tx, sepId)
      expect(cl.map((c) => [c.area, c.status])).toEqual([['manager', 'pending'], ['it', 'pending'], ['finance', 'pending'], ['admin', 'pending'], ['hr', 'pending']])
      // HR cannot sign first
      await expect(clearArea(tx, { separationId: sepId, area: 'hr', status: 'cleared', actorUserId: hrUser })).rejects.toMatchObject({ code: 'CLEARANCE_PENDING' })
      // IT records the laptop as a recovery; a recovery needs an amount and a note
      await expect(clearArea(tx, { separationId: sepId, area: 'it', status: 'recovery', actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await clearArea(tx, { separationId: sepId, area: 'it', status: 'recovery', recoveryPaise: L(4_500), note: 'MacBook charger not returned', actorUserId: hrUser })
      for (const area of ['manager', 'finance', 'admin'] as const) await clearArea(tx, { separationId: sepId, area, status: 'cleared', actorUserId: managerUser })
      const sep = (await getSeparation(tx, A.employeeId))!
      expect(sep.recoveries_paise).toBe(String(L(4_500)))
      expect(sep.recoveries_note).toContain('MacBook')
    })
  })

  it('payroll refuses to settle while HR has not signed; settles once cleared, with the recovery; letter only after settlement', async () => {
    await withTenant(A.id, async (tx) => {
      const { payroll } = await ensurePeriod(tx, { month: '2026-10', payDay: 1 })
      // HR still pending → no settlement picked up
      const none = await settlementForFreeze(tx, { employeeId: A.employeeId, runId: '00000000-0000-4000-8000-000000000001', periodStart: '2026-10-01', periodEnd: '2026-10-31',
        opts: { encashmentDivisor: 30, noticeDivisor: 30 } })
      expect(none).toBeNull()
      await expect(issueRelievingLetter(tx, { separationId: sepId, actorUserId: hrUser })).rejects.toMatchObject({ code: 'NOT_SETTLED' })

      const r = await clearArea(tx, { separationId: sepId, area: 'hr', status: 'cleared', actorUserId: hrUser })
      expect(r.allCleared).toBe(true)
      expect((await tx.query<{ c: string | null }>(`SELECT cleared_at::text AS c FROM employee_separations WHERE id = $1`, [sepId])).rows[0]!.c).toBeTruthy()

      const runId = await createRun(tx, { periodId: payroll.id, processedByUserId: '50000000-0000-0000-0000-000000000005' })
      await freezeInputs(tx, runId, [{ employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0, monthlyComponents: { BASIC: L(30_000) }, annualCtcPaise: L(600_000), stateCode: 'TS', pfApplicable: true }], {}, statutoryId)
      const frozen = (await tx.query<{ adhoc: { code: string; amountPaise: number; type?: string }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [runId])).rows[0]!
      const recovery = frozen.adhoc.find((a) => a.type === 'deduction' && /RECOVER/i.test(a.code))
      expect(recovery?.amountPaise).toBe(L(4_500))
      expect((await getSeparation(tx, A.employeeId))!.status).toBe('in_payroll')
      await calculate(tx, runId, OPTS)
      const v = await validate(tx, runId, { ...OPTS, variancePct: 1000 })
      expect(v.blockers).toEqual([])
      await approve(tx, runId, '60000000-0000-0000-0000-000000000006', { requireSeparateApprover: true })
      await lock(tx, runId, '60000000-0000-0000-0000-000000000006', { requireSeparateApprover: true })
      expect((await getSeparation(tx, A.employeeId))!.status).toBe('settled')

      // the interview is HR's; the overview hides it from non-HR callers (route-level), and stores 1–5 ratings only
      await expect(recordExitInterview(tx, { separationId: sepId, conductedByUserId: hrUser, ratings: { manager: 7 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const iv = await recordExitInterview(tx, { separationId: sepId, conductedByUserId: hrUser, wouldRejoin: true, ratings: { manager: 4, growth: 2 }, primaryReason: 'growth', feedback: 'Great team, slow promotions' })
      expect(iv.ratings).toEqual({ manager: 4, growth: 2 })

      const letter = await issueRelievingLetter(tx, { separationId: sepId, actorUserId: hrUser, signatory: 'Head of HR' })
      expect(letter).toMatchObject({ category: 'relieving', content_type: 'application/pdf', is_confidential: true, owner_id: A.employeeId })
      const bytes = (await readDocument(tx, letter.id))!.bytes
      expect(bytes.subarray(0, 5).toString()).toBe('%PDF-')
      const same = await issueRelievingLetter(tx, { separationId: sepId, actorUserId: hrUser })
      expect(same.id).toBe(letter.id)                                                  // idempotent
      const o = await exitOverview(tx, A.employeeId)
      expect(o.separation!.status).toBe('settled')
      expect(o.interview!.primary_reason).toBe('growth')
      expect(o.blockingTasks).toBe(1)                                                  // the laptop task is still open

      // the attrition report sees this leaver with the exit-interview reason; outside the window it is empty
      const rep = await attrition(tx, { from: '2026-10-01', to: '2026-10-31' })
      expect(rep.rows).toEqual([expect.objectContaining({ reason: 'resignation', tenure_band: expect.any(String), leavers: 1, voluntary: 1, exit_interview_reasons: 'growth' })])
      expect((await attrition(tx, { from: '2026-11-01', to: '2026-11-30' })).rows).toEqual([])
    })
  })
})
