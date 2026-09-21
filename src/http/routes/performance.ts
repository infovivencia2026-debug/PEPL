/** Goals, review cycles, appraisals, PIPs. */
import type { Router } from '../router.ts'
import type { Ctx } from '../context.ts'
import { HttpError, authed, ok, created, requireBody, requireModule, asDate, asUuid, asInt, assertScope, can, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import {
  createCycle, listCycles, getCycle, openCycle, setCycleStatus,
  setGoal, checkIn, setGoalStatus, listGoals, listCheckins,
  getAppraisal, listAppraisals, submitSelfReview, submitManagerReview, calibrate, acknowledge, redactForEmployee, ratingDistribution,
  openPip, reviewPip, listPips,
} from '../../people/performance.ts'

const isHr = (ctx: Ctx): boolean => can(ctx.auth, 'performance.manage')
const self = (ctx: Ctx): string => {
  if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
  return ctx.auth.employeeId
}

export function register(router: Router): void {
  // ── cycles ──
  router.get('/api/v1/performance/cycles', { summary: 'Review cycles', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => { requireModule(ctx, 'performance.enabled'); return ok({ cycles: await listCycles(ctx.tx) }) }))

  router.post('/api/v1/performance/cycles',
    { summary: 'Create a review cycle (draft)', tag: 'performance', permission: 'performance.manage',
      requestExample: { name: 'FY26 annual', periodStart: '2025-04-01', periodEnd: '2026-03-31', selfReviewDue: '2026-04-10', managerReviewDue: '2026-04-20', ratingScale: 5 } },
    authed('performance.manage', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = requireBody<{ name: string; periodStart: string; periodEnd: string; selfReviewDue?: string; managerReviewDue?: string; ratingScale?: number }>(ctx.req, ['name', 'periodStart', 'periodEnd'])
      const c = await createCycle(ctx.tx, { name: b.name, periodStart: asDate(b.periodStart, 'periodStart'), periodEnd: asDate(b.periodEnd, 'periodEnd'),
        selfReviewDue: b.selfReviewDue ? asDate(b.selfReviewDue, 'selfReviewDue') : null, managerReviewDue: b.managerReviewDue ? asDate(b.managerReviewDue, 'managerReviewDue') : null,
        ratingScale: b.ratingScale === undefined ? undefined : asInt(b.ratingScale, 'ratingScale', { min: 3, max: 10 }) })
      await emit(ctx.tx, { action: 'performance.cycle.changed', entityType: 'review_cycle', entityId: c.id, actorUserId: ctx.auth.userId, metadata: { status: 'draft', name: c.name } })
      return created(c)
    }))

  router.post('/api/v1/performance/cycles/:id/open',
    { summary: 'Open the cycle: an appraisal per active employee, reviewer = manager of record', tag: 'performance', permission: 'performance.manage' },
    authed('performance.manage', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await openCycle(ctx.tx, id)
      await emit(ctx.tx, { action: 'performance.cycle.changed', entityType: 'review_cycle', entityId: id, actorUserId: ctx.auth.userId, metadata: { status: 'open', appraisals: r.appraisals } })
      return ok({ ...r, cycle: await getCycle(ctx.tx, id) })
    }))

  router.post('/api/v1/performance/cycles/:id/status',
    { summary: 'Move the cycle to calibration or close it (every rating must be final)', tag: 'performance', permission: 'performance.manage', requestExample: { status: 'calibration' } },
    authed('performance.manage', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ status: 'calibration' | 'closed' }>(ctx.req, ['status'])
      if (!['calibration', 'closed'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is calibration or closed')
      const c = await setCycleStatus(ctx.tx, id, b.status)
      await emit(ctx.tx, { action: 'performance.cycle.changed', entityType: 'review_cycle', entityId: id, actorUserId: ctx.auth.userId, metadata: { status: b.status } })
      return ok(c)
    }))

  router.get('/api/v1/performance/cycles/:id/distribution',
    { summary: 'Rating distribution and department averages for a cycle', tag: 'performance', permission: 'performance.manage' },
    authed('performance.manage', async (ctx) => ok(await ratingDistribution(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

  // ── goals ──
  router.get('/api/v1/performance/goals',
    { summary: 'Goals (?employeeId=&cycleId=&status=) — yours, your team, or everyone per scope', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok({ goals: await listGoals(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined,
        cycleId: ctx.req.query.get('cycleId') ? asUuid(ctx.req.query.get('cycleId'), 'cycleId') : undefined, status: ctx.req.query.get('status') ?? undefined }) })
    }))

  router.post('/api/v1/performance/goals',
    { summary: 'Set a goal for yourself or (manager/HR) someone in scope; weights per cycle ≤ 100', tag: 'performance', permission: 'performance.read',
      requestExample: { title: 'Ship v2 billing', kpi: 'Release date', target: '30 Jun', weightPct: 30, dueOn: '2026-06-30', cycleId: '…' } },
    authed('performance.read', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = requireBody<{ id?: string; employeeId?: string; cycleId?: string; title: string; description?: string; kpi?: string; target?: string; weightPct?: number; dueOn?: string }>(ctx.req, ['title'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : self(ctx)
      if (employeeId !== ctx.auth.employeeId) { assertScope(ctx.auth, employeeId); if (!can(ctx.auth, 'performance.review')) throw new HttpError(403, 'PERMISSION_DENIED', 'setting goals for others needs performance.review') }
      const g = await setGoal(ctx.tx, { id: b.id ? asUuid(b.id, 'id') : undefined, employeeId, cycleId: b.cycleId ? asUuid(b.cycleId, 'cycleId') : null, title: b.title, description: b.description,
        kpi: b.kpi, target: b.target, weightPct: b.weightPct === undefined ? undefined : asInt(b.weightPct, 'weightPct', { min: 0, max: 100 }), dueOn: b.dueOn ? asDate(b.dueOn, 'dueOn') : null, setByUserId: ctx.auth.userId })
      return b.id ? ok(g) : created(g)
    }))

  router.get('/api/v1/performance/goals/:id/checkins', { summary: 'Check-in history of a goal', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const g = (await listGoals(ctx.tx, {})).find((x) => x.id === id)
      if (!g) throw new HttpError(404, 'NOT_FOUND', 'no such goal')
      assertScope(ctx.auth, g.employee_id)
      return ok({ goal: g, checkins: await listCheckins(ctx.tx, id) })
    }))

  router.post('/api/v1/performance/goals/:id/checkin',
    { summary: 'Record progress on a goal (100% completes it)', tag: 'performance', permission: 'performance.read', requestExample: { progressPct: 40, note: 'Invoicing done; payments next' } },
    authed('performance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const g = (await listGoals(ctx.tx, {})).find((x) => x.id === id)
      if (!g) throw new HttpError(404, 'NOT_FOUND', 'no such goal')
      assertScope(ctx.auth, g.employee_id)
      const b = requireBody<{ progressPct: number; note: string }>(ctx.req, ['progressPct', 'note'])
      return ok(await checkIn(ctx.tx, { goalId: id, progressPct: asInt(b.progressPct, 'progressPct', { min: 0, max: 100 }), note: b.note, byUserId: ctx.auth.userId }))
    }))

  router.post('/api/v1/performance/goals/:id/status',
    { summary: 'Complete or cancel a goal', tag: 'performance', permission: 'performance.read', requestExample: { status: 'cancelled' } },
    authed('performance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const g = (await listGoals(ctx.tx, {})).find((x) => x.id === id)
      if (!g) throw new HttpError(404, 'NOT_FOUND', 'no such goal')
      assertScope(ctx.auth, g.employee_id)
      const b = requireBody<{ status: 'completed' | 'cancelled' }>(ctx.req, ['status'])
      if (!['completed', 'cancelled'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is completed or cancelled')
      return ok(await setGoalStatus(ctx.tx, id, b.status))
    }))

  // ── appraisals ──
  router.get('/api/v1/performance/appraisals',
    { summary: 'Appraisals (?cycleId=&employeeId=&status=&mine=true|toReview=true); manager words are hidden until released', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const q = ctx.req.query
      const employeeId = q.get('employeeId') ? asUuid(q.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      const mine = q.get('mine') === 'true'; const toReview = q.get('toReview') === 'true'
      // a user with no employee record (typical HR/admin login) has nothing of their own and nothing to review
      if ((mine || toReview) && !ctx.auth.employeeId) return ok({ appraisals: [] })
      const rows = await listAppraisals(ctx.tx, {
        cycleId: q.get('cycleId') ? asUuid(q.get('cycleId'), 'cycleId') : undefined, status: q.get('status') ?? undefined,
        employeeId: mine ? self(ctx) : employeeId, reviewerEmployeeId: toReview ? self(ctx) : undefined, employeeIds: mine || toReview ? null : scopeIds(ctx),
      })
      return ok({ appraisals: rows.map((a) => a.employee_id === ctx.auth.employeeId && !isHr(ctx) ? redactForEmployee(a) : a) })
    }))

  router.get('/api/v1/performance/appraisals/:id', { summary: 'One appraisal', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => {
      const a = await getAppraisal(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!a) throw new HttpError(404, 'NOT_FOUND', 'no such appraisal')
      if (a.reviewer_employee_id !== ctx.auth.employeeId) assertScope(ctx.auth, a.employee_id)
      return ok(a.employee_id === ctx.auth.employeeId && !isHr(ctx) ? redactForEmployee(a) : a)
    }))

  router.post('/api/v1/performance/appraisals/:id/self',
    { summary: 'Submit your self review', tag: 'performance', permission: 'performance.read', requestExample: { rating: 4, comments: 'Shipped billing v2 …' } },
    authed('performance.read', async (ctx) => {
      const b = requireBody<{ rating: number; comments: string }>(ctx.req, ['rating', 'comments'])
      const a = await submitSelfReview(ctx.tx, { appraisalId: asUuid(ctx.req.params.id, 'id'), employeeId: self(ctx), rating: asInt(b.rating, 'rating', { min: 1, max: 10 }), comments: b.comments })
      await emit(ctx.tx, { action: 'performance.review.submitted', entityType: 'appraisal', entityId: a.id, subjectEmployeeId: a.employee_id, actorUserId: ctx.auth.userId, metadata: { stage: 'self' } })
      return ok(redactForEmployee(a))
    }))

  router.post('/api/v1/performance/appraisals/:id/review',
    { summary: 'Submit the manager review (reviewer or HR)', tag: 'performance', permission: 'performance.review', requestExample: { rating: 4, comments: 'Consistently …' } },
    authed('performance.review', async (ctx) => {
      const b = requireBody<{ rating: number; comments: string }>(ctx.req, ['rating', 'comments'])
      const a = await submitManagerReview(ctx.tx, { appraisalId: asUuid(ctx.req.params.id, 'id'), actorEmployeeId: ctx.auth.employeeId ?? null, isHr: isHr(ctx), rating: asInt(b.rating, 'rating', { min: 1, max: 10 }), comments: b.comments })
      await emit(ctx.tx, { action: 'performance.review.submitted', entityType: 'appraisal', entityId: a.id, subjectEmployeeId: a.employee_id, actorUserId: ctx.auth.userId, metadata: { stage: 'manager', rating: a.manager_rating } })
      return ok(a)
    }))

  router.post('/api/v1/performance/appraisals/:id/calibrate',
    { summary: 'HR: set the final rating (note required when it differs) and release to the employee', tag: 'performance', permission: 'performance.manage', requestExample: { finalRating: 3, note: 'Normalised across the department' } },
    authed('performance.manage', async (ctx) => {
      const b = requireBody<{ finalRating?: number; note?: string }>(ctx.req, [])
      const a = await calibrate(ctx.tx, { appraisalId: asUuid(ctx.req.params.id, 'id'), finalRating: b.finalRating === undefined ? undefined : asInt(b.finalRating, 'finalRating', { min: 1, max: 10 }), note: b.note })
      await emit(ctx.tx, { action: 'performance.rating.final', entityType: 'appraisal', entityId: a.id, subjectEmployeeId: a.employee_id, actorUserId: ctx.auth.userId, metadata: { finalRating: a.final_rating, changed: a.final_rating !== a.manager_rating } })
      return ok(a)
    }))

  router.post('/api/v1/performance/appraisals/:id/acknowledge',
    { summary: 'Employee acknowledges the released appraisal', tag: 'performance', permission: 'performance.read', requestExample: { comments: 'Read and discussed' } },
    authed('performance.read', async (ctx) => {
      const b = requireBody<{ comments?: string }>(ctx.req, [])
      return ok(await acknowledge(ctx.tx, { appraisalId: asUuid(ctx.req.params.id, 'id'), employeeId: self(ctx), comments: b.comments }))
    }))

  // ── PIPs (row visibility is in the policy: subject, current manager, HR/admin) ──
  router.get('/api/v1/performance/pips', { summary: 'Performance improvement plans you may see (?employeeId=&status=)', tag: 'performance', permission: 'performance.read' },
    authed('performance.read', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ pips: await listPips(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, status: ctx.req.query.get('status') ?? undefined }) })
    }))

  router.post('/api/v1/performance/pips',
    { summary: 'Open a PIP (manager of the person, or HR)', tag: 'performance', permission: 'performance.review',
      requestExample: { employeeId: '…', reason: 'Missed delivery on three sprints', objectives: [{ title: 'Deliver sprint scope', measure: '≥ 90% committed points', dueOn: '2026-11-30' }], startsOn: '2026-10-01', reviewOn: '2026-10-31', endsOn: '2026-11-30' } },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = requireBody<{ employeeId: string; reason: string; objectives: Array<{ title: string; measure?: string; dueOn?: string }>; startsOn: string; reviewOn: string; endsOn: string }>(ctx.req, ['employeeId', 'reason', 'objectives', 'startsOn', 'reviewOn', 'endsOn'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      assertScope(ctx.auth, employeeId)
      if (employeeId === ctx.auth.employeeId) throw new HttpError(422, 'VALIDATION_FAILED', 'a PIP is opened by the manager or HR, not the person')
      const p = await openPip(ctx.tx, { employeeId, openedByUserId: ctx.auth.userId, reason: b.reason, objectives: b.objectives, startsOn: asDate(b.startsOn, 'startsOn'), reviewOn: asDate(b.reviewOn, 'reviewOn'), endsOn: asDate(b.endsOn, 'endsOn') })
      await emit(ctx.tx, { action: 'performance.pip.changed', entityType: 'pip', entityId: p.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { status: 'active' } })
      return created(p)
    }))

  router.post('/api/v1/performance/pips/:id/review',
    { summary: 'Review a PIP: continue, extend, close (success or exit)', tag: 'performance', permission: 'performance.review', requestExample: { verdict: 'extend', note: 'Improving; one more month', extendTo: '2026-12-31' } },
    authed('performance.review', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ verdict: 'continue' | 'extend' | 'close_success' | 'close_exit'; note: string; extendTo?: string; nextReviewOn?: string }>(ctx.req, ['verdict', 'note'])
      if (!['continue', 'extend', 'close_success', 'close_exit'].includes(b.verdict)) throw new HttpError(422, 'VALIDATION_FAILED', 'verdict is continue, extend, close_success or close_exit')
      const p = await reviewPip(ctx.tx, { pipId: id, byUserId: ctx.auth.userId, note: b.note, verdict: b.verdict, extendTo: b.extendTo ? asDate(b.extendTo, 'extendTo') : null, nextReviewOn: b.nextReviewOn ? asDate(b.nextReviewOn, 'nextReviewOn') : null })
      assertScope(ctx.auth, p.employee_id)
      await emit(ctx.tx, { action: 'performance.pip.changed', entityType: 'pip', entityId: p.id, subjectEmployeeId: p.employee_id, actorUserId: ctx.auth.userId, metadata: { status: p.status, verdict: b.verdict } })
      return ok(p)
    }))
}
