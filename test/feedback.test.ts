/**
 * 360° feedback and recommendations (C4). Confidentiality is in the policy:
 * a rater's session sees only its own request row; HR's session sees none;
 * the aggregate withholds a relationship group under min_group and always
 * shows the manager's (never-anonymous) answer. A recommendation raised off
 * an appraisal is approved through the engine and lands as an assignment
 * change plus a compensation revision on the effective date; a percentage
 * needs a current CTC; one in flight per person.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { act } from '../src/approvals/index.ts'
import { settleDecision } from '../src/approvals/settle.ts'
import { currentPosting } from '../src/people/profile.ts'
import { openRound, myRequests, submitFeedback, roundResults, closeRound, remindFeedback, recommend, listRecommendations, applyDueRecommendations } from '../src/people/feedback.ts'

let A: Tenant
let mgr: string; let mgrUser: string; let hrUser: string; let empUser: string
const peers: Array<{ id: string; user: string }> = []
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-MGR','Mgr',DATE '2022-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Engineering','Manager',DATE '2022-01-01')`, [A.id, mgr])
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, mgr])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'fmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'fhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'femp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    for (let i = 1; i <= 3; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,$3,DATE '2024-01-01') RETURNING id`, [A.id, `A-P${i}`, `P${i}`])).rows[0]!.id
      peers.push({ id, user: await createUser(tx, { tenantId: A.id, email: `fp${i}@acme.test`, fullName: `P${i}`, password: 'a-long-password-1', roles: ['employee'], employeeId: id }) })
    }
    await tx.query(`INSERT INTO compensation_records (tenant_id, employee_id, annual_ctc_paise, components, effective_from) VALUES ($1,$2,60000000,'{"basic":2500000,"hra":1000000}'::jsonb,DATE '2025-04-01')`, [A.id, A.employeeId])
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('360° feedback', () => {
  it('raters see only their own request; aggregate withholds small groups; manager is never anonymous', async () => {
    let roundId = ''
    await withTenant(A.id, async (tx) => {
      await expect(openRound(tx, { subjectEmployeeId: A.employeeId, dueOn: '2026-12-01', raters: [{ employeeId: A.employeeId, relationship: 'peer' }], openedByUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const r = await openRound(tx, { subjectEmployeeId: A.employeeId, dueOn: '2026-12-01', minGroup: 3, openedByUserId: hrUser,
        raters: [{ employeeId: mgr, relationship: 'manager' }, ...peers.map((p) => ({ employeeId: p.id, relationship: 'peer' as const })), { employeeId: A.employeeId, relationship: 'self' }] })
      expect(r.requested).toBe(5)
      roundId = r.round.id
      await expect(openRound(tx, { subjectEmployeeId: A.employeeId, dueOn: '2026-12-01', raters: [{ employeeId: mgr, relationship: 'manager' }], openedByUserId: hrUser })).rejects.toMatchObject({ code: 'ROUND_OPEN' })
    }, { userId: hrUser })
    // HR's session cannot select a single request row
    await withTenant(A.id, async (tx) => {
      expect((await tx.query(`SELECT 1 FROM feedback_requests WHERE round_id = $1`, [roundId])).rowCount).toBe(0)
      expect(await myRequests(tx)).toHaveLength(0)
    }, { userId: hrUser })
    // each rater sees exactly one
    const answer = async (user: string, answers: Record<string, number | string>): Promise<void> => withTenant(A.id, async (tx) => {
      const mine = await myRequests(tx, 'requested')
      expect(mine).toHaveLength(1)
      await submitFeedback(tx, { requestId: mine[0]!.id, answers })
      await expect(submitFeedback(tx, { requestId: mine[0]!.id, answers })).rejects.toMatchObject({ code: 'FEEDBACK_STATE' })
    }, { userId: user })
    await withTenant(A.id, async (tx) => {
      const mine = await myRequests(tx)
      await expect(submitFeedback(tx, { requestId: mine[0]!.id, answers: { collab: 9 } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // out of scale
    }, { userId: peers[0]!.user })
    await answer(mgrUser, { collab: 4, delivery: 5, comms: 4, growth: 3, keep: 'Ships on time' })
    await answer(peers[0]!.user, { collab: 5, delivery: 4, comms: 5, growth: 4, change: 'Delegate more' })
    await answer(peers[1]!.user, { collab: 3, delivery: 4, comms: 3, growth: 4 })
    // two of three peers: peers withheld, manager shown
    await withTenant(A.id, async (tx) => {
      const res = await roundResults(tx, roundId)
      const peerRow = res.byRelationship.find((x) => x.relationship === 'peer' && x.question_id === 'collab')
      expect(peerRow).toMatchObject({ asked: 3, answered: 2, withheld: true, avg_value: null })
      expect(res.byRelationship.find((x) => x.relationship === 'manager' && x.question_id === 'collab')).toMatchObject({ avg_value: 4, withheld: false })
      expect(res.overall.find((o) => o.question_id === 'collab')).toEqual({ question_id: 'collab', avg: 4, n: 1 })
    }, { userId: hrUser })
    await answer(peers[2]!.user, { collab: 4, delivery: 3, comms: 4, growth: 5, change: 'Fewer meetings' })
    await withTenant(A.id, async (tx) => {
      const res = await roundResults(tx, roundId)
      const peerRow = res.byRelationship.find((x) => x.relationship === 'peer' && x.question_id === 'collab')!
      expect(peerRow).toMatchObject({ answered: 3, withheld: false, avg_value: 4 })
      expect([...res.byRelationship.find((x) => x.relationship === 'peer' && x.question_id === 'change')!.texts!].sort()).toEqual(['Delegate more', 'Fewer meetings'])
      expect(res.byRelationship.find((x) => x.relationship === 'self')).toMatchObject({ asked: 1, answered: 0 })
      expect(res.overall.find((o) => o.question_id === 'collab')).toEqual({ question_id: 'collab', avg: 4, n: 4 })
      // reminders reach the one who has not answered (self), once a day
      expect(await remindFeedback(tx, '2026-11-30')).toBe(1)
      expect(await remindFeedback(tx, '2026-11-30')).toBe(0)
      await closeRound(tx, roundId)
      await expect(closeRound(tx, roundId)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    }, { userId: hrUser })
    await withTenant(A.id, async (tx) => {
      await expect(submitFeedback(tx, { requestId: (await myRequests(tx))[0]?.id ?? '00000000-0000-0000-0000-000000000000', answers: {} })).rejects.toMatchObject({ code: expect.stringMatching(/ROUND_CLOSED|NOT_FOUND/) })
    }, { userId: empUser })
  })
})

describe('recommendations', () => {
  it('is approved through the engine and lands as designation + compensation on the effective date', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      await expect(recommend(tx, cfg, { employeeId: A.employeeId, effectiveFrom: '2026-10-01', justification: 'Because of sustained performance', recommendedByUserId: mgrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // nothing recommended
      await expect(recommend(tx, cfg, { employeeId: mgr, incrementPct: 10, effectiveFrom: '2026-10-01', justification: 'Because of sustained performance', recommendedByUserId: hrUser })).rejects.toMatchObject({ code: 'NO_CURRENT_COMPENSATION' })
      const r = await recommend(tx, cfg, { employeeId: A.employeeId, newDesignation: 'Lead Developer', incrementPct: 10, effectiveFrom: '2026-06-01', justification: 'Exceeded on every goal this cycle', recommendedByUserId: mgrUser })
      expect(r).toMatchObject({ kind: 'both', status: 'pending', current_annual_ctc_paise: '60000000', new_annual_ctc_paise: '66000000', increment_pct: '10.00' })
      await expect(recommend(tx, cfg, { employeeId: A.employeeId, incrementPct: 5, effectiveFrom: '2026-10-01', justification: 'Another one for the same person', recommendedByUserId: hrUser })).rejects.toMatchObject({ code: 'RECOMMENDATION_OPEN' })
      // chain manager_hr_finance; the manager raised it so their step is skipped → HR, then finance
      const steps = (await tx.query<{ approver_user_id: string | null; status: string }>(`SELECT approver_user_id, status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no`, [r.approval_request_id])).rows
      for (const s of steps) if (s.status === 'pending' && s.approver_user_id) await act(tx, { requestId: r.approval_request_id!, actorUserId: s.approver_user_id, action: 'approve' })
      await settleDecision(tx, cfg, { requestId: r.approval_request_id!, status: 'approved', actorUserId: hrUser })
      // effective date is past → applied at once
      expect((await listRecommendations(tx, { employeeId: A.employeeId }))[0]!.status).toBe('applied')
      expect((await currentPosting(tx, A.employeeId))!.designation).toBe('Lead Developer')
      const comp = (await tx.query<{ ctc: string; components: Record<string, number>; reason: string }>(`SELECT annual_ctc_paise::text AS ctc, components, change_reason AS reason FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL AND effective_to IS NULL`, [A.employeeId])).rows[0]!
      expect(comp.ctc).toBe('66000000')
      expect(comp.components).toEqual({ basic: 2750000, hra: 1100000 })
      expect(comp.reason).toMatch(/^both: appraisal recommendation/)
      // a future-dated one waits for the job
      const f = await recommend(tx, cfg, { employeeId: A.employeeId, newAnnualCtcPaise: 72000000, effectiveFrom: '2099-04-01', justification: 'Retention adjustment for next year', recommendedByUserId: hrUser })
      expect(f).toMatchObject({ kind: 'increment', increment_pct: '9.09' })
      const fs = (await tx.query<{ approver_user_id: string | null; status: string }>(`SELECT approver_user_id, status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no`, [f.approval_request_id])).rows
      for (const s of fs) if (s.status === 'pending' && s.approver_user_id) await act(tx, { requestId: f.approval_request_id!, actorUserId: s.approver_user_id, action: 'approve' })
      await settleDecision(tx, cfg, { requestId: f.approval_request_id!, status: 'approved', actorUserId: hrUser })
      expect((await listRecommendations(tx, { employeeId: A.employeeId, status: 'approved' })).length).toBe(1)
      expect(await applyDueRecommendations(tx, '2099-03-31')).toBe(0)
      expect(await applyDueRecommendations(tx, '2099-04-01')).toBe(1)
    })
  })
})
