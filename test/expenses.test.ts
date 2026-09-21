/**
 * Expenses end to end: a category's policy is enforced at submission, a
 * duplicate is caught, the claim rides the approval engine, an approved claim
 * is paid as a REIMBURSEMENT line on the next payroll run exactly once
 * (released on unfreeze, reimbursed on lock), and a trip's advance and
 * recovery flow the same way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeAssignment, changeCompensation } from '../src/people/history.ts'
import {
  seedDefaultCategories, listCategories, upsertCategory, submitClaim, settleClaimDecision, getClaim, listClaims, cancelClaim,
  requestTravel, settleTravelDecision, settleTrip, getTrip,
} from '../src/work/expenses.ts'
import { act } from '../src/approvals/index.ts'
import { createRun, freezeInputs, calculate, validate, approve, lock, unfreezeInputs } from '../src/payroll/run.ts'
import { ensurePeriod } from '../src/payroll/periods.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
let A: Tenant
let manager: string; let managerUser: string; let empUser: string
let cats: Record<string, string> = {}
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
    empUser = await createUser(tx, { tenantId: A.id, email: 'emp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await changeAssignment(tx, { employeeId: A.employeeId, department: 'Sales', designation: 'Exec', managerEmployeeId: manager, effectiveFrom: '2026-06-01' })
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000), components: { BASIC: L(30_000) }, effectiveFrom: '2025-01-01', reason: 'offer' })
    await seedDefaultCategories(tx)
    for (const c of await listCategories(tx)) cats[c.code] = c.id
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('claims', () => {
  it('policy is enforced at submission: limits, receipts, mileage pricing, age, duplicates', async () => {
    await withTenant(A.id, async (tx) => {
      const base = { employeeId: A.employeeId, requestedByUserId: empUser, fallbackChain: 'manager' as const }
      await expect(submitClaim(tx, { ...base, categoryId: cats.MEALS!, incurredOn: '2026-09-02', amountPaise: L(2_500), description: 'dinner' }))
        .rejects.toMatchObject({ code: 'OVER_CLAIM_LIMIT' })
      await expect(submitClaim(tx, { ...base, categoryId: cats.TRAVEL!, incurredOn: '2026-09-02', amountPaise: L(900), description: 'cab' }))
        .rejects.toMatchObject({ code: 'RECEIPT_REQUIRED' })
      await expect(submitClaim(tx, { ...base, categoryId: cats.TRAVEL!, incurredOn: '2026-05-02', amountPaise: L(100), description: 'old' }))
        .rejects.toMatchObject({ code: 'CLAIM_TOO_OLD' })
      // mileage: the category prices it
      const km = await submitClaim(tx, { ...base, categoryId: cats.MILEAGE!, incurredOn: '2026-09-02', distanceKm: 12.5, amountPaise: L(99_999), description: 'client visit' })
      expect(km.claim.amount_paise).toBe(String(Math.round(12.5 * 1_200)))
      expect(km.chain).toBe('manager')
      // an identical claim is a duplicate until the person says otherwise
      await expect(submitClaim(tx, { ...base, categoryId: cats.MILEAGE!, incurredOn: '2026-09-02', distanceKm: 12.5, description: 'again' }))
        .rejects.toMatchObject({ code: 'DUPLICATE_CLAIM' })
      const second = await submitClaim(tx, { ...base, categoryId: cats.MILEAGE!, incurredOn: '2026-09-02', distanceKm: 12.5, description: 'second visit same day', notADuplicate: true })
      expect(second.claim.status).toBe('submitted')
      // monthly limit counts what is already filed
      await upsertCategory(tx, { code: 'PHONE', name: 'Phone', monthlyLimitPaise: L(1_000), receiptRequiredAbovePaise: 0 })
      await submitClaim(tx, { ...base, categoryId: cats.PHONE!, incurredOn: '2026-09-03', amountPaise: L(600), description: 'recharge' })
      await expect(submitClaim(tx, { ...base, categoryId: cats.PHONE!, incurredOn: '2026-09-20', amountPaise: L(500), description: 'recharge 2' }))
        .rejects.toMatchObject({ code: 'OVER_MONTHLY_LIMIT' })
      // cancel one of the mileage claims; its approval request is withdrawn
      await cancelClaim(tx, second.claim.id, A.employeeId)
      expect((await getClaim(tx, second.claim.id))!.status).toBe('cancelled')
      const ar = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [second.approvalRequestId])).rows[0]!
      expect(ar.status).toBe('withdrawn')
    })
  })

  it('approval → paid once through payroll: REIMBURSEMENT on freeze, released on unfreeze, reimbursed on lock', async () => {
    let runId = ''
    await withTenant(A.id, async (tx) => {
      const mine = await listClaims(tx, { employeeId: A.employeeId, status: 'submitted' })
      expect(mine.claims).toHaveLength(2)                 // mileage + phone
      for (const c of mine.claims) {
        const r = await act(tx, { requestId: c.approval_request_id!, actorUserId: managerUser, action: 'approve' })
        expect(r.status).toBe('approved')
        await settleClaimDecision(tx, { claimId: c.id, status: 'approved', actorUserId: managerUser })
      }
      const approved = await listClaims(tx, { employeeId: A.employeeId, status: 'approved' })
      expect(approved.claims).toHaveLength(2)
      const owed = approved.claims.reduce((s, c) => s + Number(c.amount_paise), 0)
      // the applicant was told
      const notes = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'expense.approved'`, [empUser])).rows[0]!.n
      expect(Number(notes)).toBe(2)

      const { payroll } = await ensurePeriod(tx, { month: '2026-10', payDay: 1 })
      runId = await createRun(tx, { periodId: payroll.id, processedByUserId: PROCESSOR })
      const row = { employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0, monthlyComponents: { BASIC: L(30_000) }, annualCtcPaise: L(600_000), stateCode: 'TS', pfApplicable: true }
      await freezeInputs(tx, runId, [row], {}, statutoryId)
      const frozen = (await tx.query<{ adhoc: { code: string; amountPaise: number; taxable?: boolean }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [runId])).rows[0]!
      const line = frozen.adhoc.find((a) => a.code === 'REIMBURSEMENT')!
      expect(line.amountPaise).toBe(owed)
      expect(line.taxable).toBe(false)
      expect((await listClaims(tx, { employeeId: A.employeeId, status: 'in_payroll' })).claims).toHaveLength(2)

      // unfreeze gives them back; a second freeze picks them up again, still once
      await unfreezeInputs(tx, runId)
      expect((await listClaims(tx, { employeeId: A.employeeId, status: 'approved' })).claims).toHaveLength(2)
      await freezeInputs(tx, runId, [row], {}, statutoryId)
      const again = (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [runId])).rows[0]!
      expect(again.adhoc.filter((a) => a.code === 'REIMBURSEMENT')).toHaveLength(1)
      expect(again.adhoc.find((a) => a.code === 'REIMBURSEMENT')!.amountPaise).toBe(owed)

      await calculate(tx, runId, OPTS)
      const lines = (await tx.query<{ code: string; amount_paise: string }>(
        `SELECT component_code AS code, amount_paise::text FROM payroll_lines WHERE run_id = $1 AND component_code = 'REIMBURSEMENT'`, [runId])).rows
      expect(lines).toHaveLength(1)
      expect(Number(lines[0]!.amount_paise)).toBe(owed)
      await validate(tx, runId, { ...OPTS, variancePct: 1000 })
      await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
      await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
      const done = await listClaims(tx, { employeeId: A.employeeId, status: 'reimbursed' })
      expect(done.claims).toHaveLength(2)
      expect(done.claims.every((c) => c.reimbursement_run_id === runId && c.reimbursed_at)).toBe(true)
      // nothing left to pay next month
      expect((await listClaims(tx, { employeeId: A.employeeId, status: 'approved' })).claims).toHaveLength(0)
    })
  })
})

describe('travel', () => {
  it('an approved advance is paid on the next run; settling recovers what was not spent', async () => {
    await withTenant(A.id, async (tx) => {
      const t = await requestTravel(tx, { employeeId: A.employeeId, requestedByUserId: empUser, purpose: 'Kickoff', destination: 'Mumbai',
        startsOn: '2026-11-03', endsOn: '2026-11-05', estimatedPaise: L(25_000), advancePaise: L(10_000), fallbackChain: 'manager' })
      await expect(requestTravel(tx, { employeeId: A.employeeId, requestedByUserId: empUser, purpose: 'x', destination: 'y', startsOn: '2026-11-03', endsOn: '2026-11-05', estimatedPaise: L(100), advancePaise: L(200), fallbackChain: 'manager' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      // claims against a trip need it approved first
      await expect(submitClaim(tx, { employeeId: A.employeeId, requestedByUserId: empUser, categoryId: cats.LODGING!, incurredOn: '2026-09-04', amountPaise: L(4_000), description: 'hotel', receiptDocumentId: '11111111-1111-4111-8111-111111111111', travelRequestId: t.trip.id, fallbackChain: 'manager' }))
        .rejects.toMatchObject({ code: 'TRAVEL_NOT_APPROVED' })
      await act(tx, { requestId: t.approvalRequestId, actorUserId: managerUser, action: 'approve' })
      await settleTravelDecision(tx, { tripId: t.trip.id, status: 'approved' })
      expect((await getTrip(tx, t.trip.id))!.status).toBe('approved')

      // the advance rides the November run
      const { payroll } = await ensurePeriod(tx, { month: '2026-11', payDay: 1 })
      const runId = await createRun(tx, { periodId: payroll.id, processedByUserId: PROCESSOR })
      const row = { employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { BASIC: L(30_000) }, annualCtcPaise: L(600_000), stateCode: 'TS', pfApplicable: true }
      await freezeInputs(tx, runId, [row], {}, statutoryId)
      const frozen = (await tx.query<{ adhoc: { code: string; amountPaise: number }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [runId])).rows[0]!
      expect(frozen.adhoc.find((a) => a.code === 'TRAVEL_ADVANCE')!.amountPaise).toBe(L(10_000))
      expect((await getTrip(tx, t.trip.id))!.status).toBe('advance_paid')

      // one claim of ₹4,000 against the trip, approved; settle → ₹6,000 unspent to recover
      const c = await submitClaim(tx, { employeeId: A.employeeId, requestedByUserId: empUser, categoryId: cats.LODGING!, incurredOn: '2026-09-04', amountPaise: L(4_000), description: 'hotel', receiptDocumentId: '11111111-1111-4111-8111-111111111111', travelRequestId: t.trip.id, fallbackChain: 'manager' })
      await expect(settleTrip(tx, t.trip.id, A.employeeId)).rejects.toMatchObject({ code: 'TRIP_HAS_OPEN_CLAIMS' })
      await act(tx, { requestId: c.approvalRequestId, actorUserId: managerUser, action: 'approve' })
      await settleClaimDecision(tx, { claimId: c.claim.id, status: 'approved', actorUserId: managerUser })
      const settled = await settleTrip(tx, t.trip.id, A.employeeId)
      expect(settled.status).toBe('settled')
      expect(settled.claimed_paise).toBe(String(L(4_000)))
      const rec = (await tx.query<{ recovery_paise: string }>(`SELECT recovery_paise::text FROM travel_requests WHERE id = $1`, [t.trip.id])).rows[0]!
      expect(rec.recovery_paise).toBe(String(L(6_000)))

      // the December run pays the ₹4,000 claim and recovers the ₹6,000
      const dec = await ensurePeriod(tx, { month: '2026-12', payDay: 1 })
      const run2 = await createRun(tx, { periodId: dec.payroll.id, processedByUserId: PROCESSOR })
      await freezeInputs(tx, run2, [{ ...row, calendarDays: 31, payableDays: 31 }], {}, statutoryId)
      const f2 = (await tx.query<{ adhoc: { code: string; amountPaise: number; type?: string }[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [run2])).rows[0]!
      expect(f2.adhoc.find((a) => a.code === 'REIMBURSEMENT')!.amountPaise).toBe(L(4_000))
      expect(f2.adhoc.find((a) => a.code === 'TRAVEL_ADVANCE_RECOVERY')).toMatchObject({ amountPaise: L(6_000), type: 'deduction' })
    })
  })
})
