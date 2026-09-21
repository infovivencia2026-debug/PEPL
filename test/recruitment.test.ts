/**
 * Recruitment end to end: requisition approved → open; candidate through the
 * stages (no skipping, rejection needs a reason); interview scheduled (the
 * interviewers are told) and scored by an interviewer only; offer within the
 * band, approved, sent, accepted; conversion creates the employee with
 * assignment, salary, login invite and onboarding tasks, and fills the
 * requisition when headcount is met.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { createTemplate } from '../src/work/templates.ts'
import { act } from '../src/approvals/index.ts'
import {
  raiseRequisition, settleRequisitionDecision, getRequisition, addCandidate, moveCandidate, scheduleInterview, recordInterview, listInterviews,
  makeOffer, settleOfferDecision, sendOffer, respondToOffer, convertToEmployee, getCandidate,
} from '../src/people/recruitment.ts'
import { currentPosting } from '../src/people/profile.ts'
import { loginFor } from '../src/people/onboard.ts'

const L = (r: number): number => r * 100
let A: Tenant
let hrUser: string; let mgrUser: string; let manager: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-MGR','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'mgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'hr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    await createTemplate(tx, { name: 'Joiner', trigger: 'onboarding', items: [{ title: 'Collect PAN', assigneeRule: 'hr' }, { title: 'Issue laptop', assigneeRule: 'it', dueOffsetDays: 1 }] })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('requisition → hire', () => {
  it('runs the whole pipeline and converts the accepted candidate into a complete employee', async () => {
    await withTenant(A.id, async (tx) => {
      // the hiring manager raises it; HR approves (an HR requester would skip their own step and auto-approve)
      const req = await raiseRequisition(tx, { title: 'Senior Developer', department: 'Engineering', designation: 'Senior Developer', headcount: 1,
        minCtcPaise: L(1_200_000), maxCtcPaise: L(1_800_000), hiringManagerEmployeeId: manager, requestedByUserId: mgrUser, fallbackChain: 'hr_only' })
      expect(req.requisition.status).toBe('pending')
      await expect(addCandidate(tx, { requisitionId: req.requisition.id, firstName: 'Asha', email: 'asha@example.com' })).rejects.toMatchObject({ code: 'REQUISITION_NOT_OPEN' })
      await act(tx, { requestId: req.approvalRequestId, actorUserId: hrUser, action: 'approve' })
      await settleRequisitionDecision(tx, { approvalRequestId: req.approvalRequestId, status: 'approved' })
      expect((await getRequisition(tx, req.requisition.id))!.status).toBe('open')

      // candidate pipeline
      const asha = await addCandidate(tx, { requisitionId: req.requisition.id, firstName: 'Asha', lastName: 'Rao', email: 'Asha@Example.com', phone: '+91 98765 00000', source: 'referral', expectedCtcPaise: L(1_500_000) })
      expect(asha.email).toBe('asha@example.com')
      await expect(addCandidate(tx, { requisitionId: req.requisition.id, firstName: 'Asha', email: 'asha@example.com' })).rejects.toMatchObject({ code: 'CANDIDATE_EXISTS' })
      await expect(moveCandidate(tx, asha.id, 'offer')).rejects.toMatchObject({ code: 'BAD_STAGE_MOVE' })      // no skipping
      await expect(moveCandidate(tx, asha.id, 'rejected')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })  // needs a reason
      await moveCandidate(tx, asha.id, 'screening')

      // interview: scheduling notifies interviewers and moves the stage; only an interviewer records the outcome
      const iv = await scheduleInterview(tx, { candidateId: asha.id, round: 'Technical 1', scheduledAt: '2026-10-14T05:30:00Z', interviewerUserIds: [mgrUser] })
      expect((await getCandidate(tx, asha.id))!.stage).toBe('interview')
      const told = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'recruit.interview.scheduled'`, [mgrUser])).rows[0]!.n
      expect(Number(told)).toBe(1)
      await expect(recordInterview(tx, { interviewId: iv.id, actorUserId: hrUser, status: 'completed', score: 4, recommendation: 'hire' })).rejects.toMatchObject({ code: 'NOT_INTERVIEWER' })
      await expect(recordInterview(tx, { interviewId: iv.id, actorUserId: mgrUser, status: 'completed' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const done = await recordInterview(tx, { interviewId: iv.id, actorUserId: mgrUser, status: 'completed', score: 4, recommendation: 'hire', feedback: 'solid' })
      expect(done.status).toBe('completed')
      expect((await listInterviews(tx, { candidateId: asha.id }))[0]!.score).toBe(4)

      // offer: within the band, approved, sent, accepted
      await expect(makeOffer(tx, { candidateId: asha.id, designation: 'Senior Developer', annualCtcPaise: L(2_000_000), joiningDate: '2026-11-16', validUntil: '2026-10-31', createdByUserId: hrUser, fallbackChain: 'hr_only' }))
        .rejects.toMatchObject({ code: 'OVER_BAND' })
      const offer = await makeOffer(tx, { candidateId: asha.id, designation: 'Senior Developer', annualCtcPaise: L(1_500_000), components: { BASIC: L(62_500), HRA: L(25_000) },
        joiningDate: '2026-11-16', validUntil: '2026-10-31', probationMonths: 6, noticePeriodDays: 60, createdByUserId: mgrUser, fallbackChain: 'hr_only' })
      expect(offer.offer.status).toBe('pending_approval')
      expect((await getCandidate(tx, asha.id))!.stage).toBe('offer')
      await expect(sendOffer(tx, offer.offer.id)).rejects.toMatchObject({ code: 'OFFER_NOT_APPROVED' })
      await act(tx, { requestId: offer.approvalRequestId, actorUserId: hrUser, action: 'approve' })
      await settleOfferDecision(tx, { approvalRequestId: offer.approvalRequestId, status: 'approved' })
      await sendOffer(tx, offer.offer.id)
      expect((await getCandidate(tx, asha.id))!.stage).toBe('offered')
      await expect(convertToEmployee(tx, { offerId: offer.offer.id, actorUserId: hrUser })).rejects.toMatchObject({ code: 'OFFER_NOT_ACCEPTED' })
      await respondToOffer(tx, offer.offer.id, 'accepted')
      expect((await getCandidate(tx, asha.id))!.stage).toBe('accepted')

      // conversion: one call, complete record
      const hire = await convertToEmployee(tx, { offerId: offer.offer.id, actorUserId: hrUser })
      expect(hire.employeeNumber).toMatch(/^EMP-\d{4}$/)
      expect(hire.tasks).toBe(2)
      expect(hire.requisitionFilled).toBe(true)
      const emp = (await tx.query<{ first_name: string; work_email: string; employment_type: string; probation_end: string; notice_period_days: number; date_of_joining: string }>(
        `SELECT first_name, work_email, employment_type, probation_end::text, notice_period_days, date_of_joining::text FROM employees WHERE id = $1`, [hire.employeeId])).rows[0]!
      expect(emp).toMatchObject({ first_name: 'Asha', work_email: 'asha@example.com', employment_type: 'probation', probation_end: '2027-05-16', notice_period_days: 60, date_of_joining: '2026-11-16' })
      const posting = await currentPosting(tx, hire.employeeId, '2026-11-16')
      expect(posting).toMatchObject({ department: 'Engineering', designation: 'Senior Developer', manager_employee_id: manager })
      const comp = (await tx.query<{ annual_ctc_paise: string; components: Record<string, number> }>(`SELECT annual_ctc_paise::text, components FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL`, [hire.employeeId])).rows[0]!
      expect(comp.annual_ctc_paise).toBe(String(L(1_500_000)))
      expect(comp.components).toEqual({ BASIC: L(62_500), HRA: L(25_000) })
      const login = await loginFor(tx, hire.employeeId)
      expect(login).toMatchObject({ email: 'asha@example.com', roles: ['employee'] })
      expect(hire.inviteToken.length).toBeGreaterThan(20)
      expect((await getCandidate(tx, asha.id))).toMatchObject({ stage: 'joined', employee_id: hire.employeeId })
      expect((await getRequisition(tx, req.requisition.id))!.status).toBe('filled')
      await expect(convertToEmployee(tx, { offerId: offer.offer.id, actorUserId: hrUser })).rejects.toMatchObject({ code: 'ALREADY_CONVERTED' })
    })
  })
})
