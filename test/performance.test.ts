/**
 * Performance: weighted goals with check-ins; a cycle opened for every
 * active employee with the manager as reviewer; the appraisal walks
 * self → manager → calibration → acknowledgement with each step owned by one
 * party; HR calibration needs a note when it changes the rating; a cycle
 * cannot close with a rating missing. A PIP is invisible to anyone but the
 * subject, their manager and HR — by policy, so an unrelated employee's
 * session sees zero rows without any WHERE clause.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import {
  createCycle, openCycle, setCycleStatus, setGoal, checkIn, listGoals, listAppraisals, submitSelfReview, submitManagerReview, calibrate, acknowledge,
  redactForEmployee, ratingDistribution, openPip, reviewPip, listPips,
} from '../src/people/performance.ts'

let A: Tenant
let manager: string; let mgrUser: string; let empUser: string; let other: string; let otherUser: string; let hrUser: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-PMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    other = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-OTH','Other',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'pmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    empUser = await createUser(tx, { tenantId: A.id, email: 'pemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    otherUser = await createUser(tx, { tenantId: A.id, email: 'poth@acme.test', fullName: 'Other', password: 'a-long-password-1', roles: ['employee'], employeeId: other })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'phr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('goals', () => {
  it('caps weights per cycle at 100 and completes at 100% progress', async () => {
    await withTenant(A.id, async (tx) => {
      const c = await createCycle(tx, { name: 'FY26', periodStart: '2025-04-01', periodEnd: '2026-03-31' })
      const g1 = await setGoal(tx, { employeeId: A.employeeId, cycleId: c.id, title: 'Ship billing v2', kpi: 'release', target: '30 Jun', weightPct: 60, setByUserId: mgrUser })
      await expect(setGoal(tx, { employeeId: A.employeeId, cycleId: c.id, title: 'Too heavy', weightPct: 50, setByUserId: empUser })).rejects.toMatchObject({ code: 'WEIGHT_OVER' })
      await setGoal(tx, { employeeId: A.employeeId, cycleId: c.id, title: 'Mentor two juniors', weightPct: 40, setByUserId: empUser })
      const moved = await checkIn(tx, { goalId: g1.id, progressPct: 40, note: 'invoicing done', byUserId: empUser })
      expect(moved.progress_pct).toBe(40)
      const done = await checkIn(tx, { goalId: g1.id, progressPct: 100, note: 'shipped', byUserId: empUser })
      expect(done.status).toBe('completed')
      await expect(checkIn(tx, { goalId: g1.id, progressPct: 50, note: 'x', byUserId: empUser })).rejects.toMatchObject({ code: 'GOAL_CLOSED' })
      expect((await listGoals(tx, { employeeId: A.employeeId, cycleId: c.id })).length).toBe(2)
    })
  })
})

describe('review cycle', () => {
  it('opens for every active employee, walks the appraisal with one owner per step, and will not close with a rating missing', async () => {
    await withTenant(A.id, async (tx) => {
      const c = await createCycle(tx, { name: 'H1 2026', periodStart: '2026-01-01', periodEnd: '2026-06-30', selfReviewDue: '2026-07-07' })
      await expect(createCycle(tx, { name: 'h1 2026', periodStart: '2026-01-01', periodEnd: '2026-06-30' })).rejects.toMatchObject({ code: 'CYCLE_EXISTS' })
      const opened = await openCycle(tx, c.id)
      expect(opened.appraisals).toBeGreaterThanOrEqual(3)
      await expect(openCycle(tx, c.id)).rejects.toMatchObject({ code: 'CYCLE_NOT_DRAFT' })
      const mine = (await listAppraisals(tx, { cycleId: c.id, employeeId: A.employeeId }))[0]!
      expect(mine).toMatchObject({ status: 'self_pending', reviewer_employee_id: manager })
      const told = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'performance.cycle.opened'`, [empUser])).rows[0]!.n
      expect(Number(told)).toBe(1)

      // self review: only the employee, only once
      await expect(submitSelfReview(tx, { appraisalId: mine.id, employeeId: manager, rating: 4, comments: 'x' })).rejects.toMatchObject({ code: 'NOT_YOURS' })
      await expect(submitSelfReview(tx, { appraisalId: mine.id, employeeId: A.employeeId, rating: 6, comments: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(acknowledge(tx, { appraisalId: mine.id, employeeId: A.employeeId })).rejects.toMatchObject({ code: 'APPRAISAL_STATE' })   // nothing to acknowledge yet
      const afterSelf = await submitSelfReview(tx, { appraisalId: mine.id, employeeId: A.employeeId, rating: 4, comments: 'Shipped billing v2 and mentored' })
      expect(afterSelf.status).toBe('manager_pending')
      expect(redactForEmployee(afterSelf).manager_rating).toBeNull()

      // manager review: the reviewer (not a peer, not the subject); HR may step in
      await expect(submitManagerReview(tx, { appraisalId: mine.id, actorEmployeeId: other, isHr: false, rating: 3, comments: 'x' })).rejects.toMatchObject({ code: 'NOT_REVIEWER' })
      const afterMgr = await submitManagerReview(tx, { appraisalId: mine.id, actorEmployeeId: manager, isHr: false, rating: 3, comments: 'Solid delivery, late on mentoring' })
      expect(afterMgr).toMatchObject({ status: 'calibration', manager_rating: 3, final_rating: 3 })
      expect(redactForEmployee(afterMgr).manager_comments).toBeNull()   // hidden until released

      // calibration: HR, note required when the rating changes
      await expect(calibrate(tx, { appraisalId: mine.id, finalRating: 4 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const released = await calibrate(tx, { appraisalId: mine.id, finalRating: 4, note: 'Normalised: mentoring was outside the plan' })
      expect(released).toMatchObject({ status: 'acknowledgement', final_rating: 4 })
      expect(redactForEmployee(released).manager_comments).toBe('Solid delivery, late on mentoring')
      await expect(acknowledge(tx, { appraisalId: mine.id, employeeId: manager })).rejects.toMatchObject({ code: 'NOT_YOURS' })
      const acked = await acknowledge(tx, { appraisalId: mine.id, employeeId: A.employeeId, comments: 'Discussed' })
      expect(acked.acknowledged_at).toBeTruthy()

      // cycle: calibration → close needs every rating final
      await setCycleStatus(tx, c.id, 'calibration')
      await expect(setCycleStatus(tx, c.id, 'closed')).rejects.toMatchObject({ code: 'RATINGS_PENDING' })
      const dist = await ratingDistribution(tx, c.id)
      expect(dist.byRating['4']).toBe(1)
      expect(dist.pending).toBe(dist.total - 1)
      // HR finishes the rest; the manager (no manager of their own) is reviewed by HR
      for (const a of await listAppraisals(tx, { cycleId: c.id, status: 'self_pending' })) {   // no self review in: HR reviews anyway
        await submitManagerReview(tx, { appraisalId: a.id, actorEmployeeId: null, isHr: true, rating: 3, comments: 'ok' })
        await calibrate(tx, { appraisalId: a.id })
      }
      const closed = await setCycleStatus(tx, c.id, 'closed')
      expect(closed.status).toBe('closed')
      expect((await listAppraisals(tx, { cycleId: c.id, employeeId: A.employeeId }))[0]!.status).toBe('closed')
    })
  })
})

describe('performance improvement plan', () => {
  it('one live plan per person; extend then close; invisible to an unrelated employee by policy', async () => {
    await withTenant(A.id, async (tx) => {   // as the manager's session, like a real request
      await expect(openPip(tx, { employeeId: A.employeeId, openedByUserId: mgrUser, reason: 'x', objectives: [], startsOn: '2026-10-01', reviewOn: '2026-10-31', endsOn: '2026-11-30' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const p = await openPip(tx, { employeeId: A.employeeId, openedByUserId: mgrUser, reason: 'Missed three sprints', objectives: [{ title: 'Deliver sprint scope', measure: '≥ 90%' }], startsOn: '2026-10-01', reviewOn: '2026-10-31', endsOn: '2026-11-30' })
      await expect(openPip(tx, { employeeId: A.employeeId, openedByUserId: mgrUser, reason: 'again', objectives: [{ title: 'x' }], startsOn: '2026-10-01', reviewOn: '2026-10-31', endsOn: '2026-11-30' })).rejects.toMatchObject({ code: 'PIP_OPEN' })
      const ext = await reviewPip(tx, { pipId: p.id, byUserId: mgrUser, note: 'Improving', verdict: 'extend', extendTo: '2026-12-31' })
      expect(ext).toMatchObject({ status: 'extended', ends_on: '2026-12-31', review_on: '2026-12-31' })
      const closed = await reviewPip(tx, { pipId: p.id, byUserId: hrUser, note: 'Met every objective', verdict: 'close_success' })
      expect(closed).toMatchObject({ status: 'closed_success', outcome: 'Met every objective' })
      expect(closed.reviews.length).toBe(2)
      await expect(reviewPip(tx, { pipId: p.id, byUserId: hrUser, note: 'x', verdict: 'continue' })).rejects.toMatchObject({ code: 'PIP_CLOSED' })
    }, { userId: mgrUser })
    // visibility is the policy's job: same query, different sessions
    const seenBy = async (userId: string) => withTenant(A.id, (tx) => listPips(tx, { employeeId: A.employeeId }), { userId })
    expect((await seenBy(empUser)).length).toBe(1)     // the subject
    expect((await seenBy(mgrUser)).length).toBe(1)     // the manager
    expect((await seenBy(hrUser)).length).toBe(1)      // HR
    expect((await seenBy(otherUser)).length).toBe(0)   // a peer: nothing, with no WHERE clause involved
  })
})
