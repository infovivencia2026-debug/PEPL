/** 360° feedback rounds and promotion / increment recommendations (performance module). */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, assertScope, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { openRound, getRound, listRounds, myRequests, submitFeedback, roundResults, closeRound, DEFAULT_360_QUESTIONS, recommend, getRecommendation, listRecommendations, withdrawRecommendation, type FeedbackQuestion, type Relationship } from '../../people/feedback.ts'

export function register(router: Router): void {
  router.get('/api/v1/feedback/rounds', { summary: '360° rounds for people in your scope (?employeeId=&status=), plus the default question set', tag: 'performance', permission: 'performance.review' },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ rounds: await listRounds(ctx.tx, { employeeIds: scopeIds(ctx), subjectEmployeeId: employeeId, status: ctx.req.query.get('status') ?? undefined }), defaultQuestions: DEFAULT_360_QUESTIONS })
    }))

  router.post('/api/v1/feedback/rounds', { summary: 'Open a 360° round: nominate raters by relationship; each is told; answers stay confidential', tag: 'performance', permission: 'performance.review',
    requestExample: { subjectEmployeeId: '…', appraisalId: '…', dueOn: '2026-11-15', raters: [{ employeeId: '…', relationship: 'peer' }, { employeeId: '…', relationship: 'report' }, { employeeId: '…', relationship: 'manager' }] } },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = requireBody<{ subjectEmployeeId: string; appraisalId?: string; title?: string; questions?: FeedbackQuestion[]; dueOn: string; raters: Array<{ employeeId: string; relationship: Relationship }> }>(ctx.req, ['subjectEmployeeId', 'dueOn', 'raters'])
      const subject = asUuid(b.subjectEmployeeId, 'subjectEmployeeId'); assertScope(ctx.auth, subject)
      if (!Array.isArray(b.raters)) throw new HttpError(422, 'VALIDATION_FAILED', 'raters is a list')
      const r = await openRound(ctx.tx, { subjectEmployeeId: subject, appraisalId: b.appraisalId ? asUuid(b.appraisalId, 'appraisalId') : null, title: b.title, questions: b.questions, minGroup: ctx.config.get<number>('performance.feedback_min_group'), dueOn: asDate(b.dueOn, 'dueOn'),
        raters: b.raters.map((x) => ({ employeeId: asUuid(x.employeeId, 'raters.employeeId'), relationship: x.relationship })), openedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'feedback.round.opened', entityType: 'feedback_round', entityId: r.round.id, actorUserId: ctx.auth.userId, subjectEmployeeId: subject, metadata: { raters: r.requested, dueOn: r.round.due_on } })
      return created(r)
    }))

  router.get('/api/v1/feedback/rounds/:id', { summary: 'A round with its aggregate: per relationship, averages and comments only above the minimum group; never a single answer', tag: 'performance', },
    authed(null, async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const round = await getRound(ctx.tx, id)
      if (!round) throw new HttpError(404, 'NOT_FOUND', 'no such round')
      // the subject sees their own once closed; reviewers see anyone in scope
      const isSubject = round.subject_employee_id === ctx.auth.employeeId
      if (!isSubject) { if (!ctx.auth.permissions.has('performance.review')) throw new HttpError(404, 'NOT_FOUND', 'no such round'); assertScope(ctx.auth, round.subject_employee_id) }
      if (isSubject && round.status !== 'closed' && !ctx.auth.permissions.has('performance.review')) return ok({ round, byRelationship: [], overall: [], pending: true })
      return ok(await roundResults(ctx.tx, id))
    }))

  router.post('/api/v1/feedback/rounds/:id/close', { summary: 'Close the round; the subject is told their feedback is ready', tag: 'performance', permission: 'performance.review' },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const round = await getRound(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!round) throw new HttpError(404, 'NOT_FOUND', 'no such round')
      assertScope(ctx.auth, round.subject_employee_id)
      return ok(await closeRound(ctx.tx, round.id))
    }))

  router.get('/api/v1/me/feedback-requests', { summary: 'Feedback others have asked of me (?status=requested)', tag: 'performance', },
    authed(null, async (ctx) => { requireModule(ctx, 'performance.enabled'); return ok({ requests: await myRequests(ctx.tx, ctx.req.query.get('status') ?? undefined) }) }))

  router.post('/api/v1/me/feedback-requests/:id', { summary: 'Answer (or decline) a feedback request of mine', tag: 'performance', permission: undefined,
    requestExample: { answers: { collab: 4, delivery: 5, keep: 'Clear hand-offs' } } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = (ctx.req.body ?? {}) as { answers?: Record<string, number | string>; decline?: boolean }
      await submitFeedback(ctx.tx, { requestId: asUuid(ctx.req.params.id, 'id'), answers: b.answers ?? {}, decline: b.decline === true })
      return noContent()
    }))

  // ── recommendations ──
  router.get('/api/v1/recommendations', { summary: 'Promotion / increment recommendations in your scope (?employeeId=&status=)', tag: 'performance', permission: 'performance.review' },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      const rows = await listRecommendations(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, status: ctx.req.query.get('status') ?? undefined })
      // money is compensation.read only
      const showMoney = ctx.auth.permissions.has('compensation.read')
      return ok({ recommendations: showMoney ? rows : rows.map((r) => ({ ...r, new_annual_ctc_paise: null, current_annual_ctc_paise: null })) })
    }))

  router.post('/api/v1/recommendations', { summary: 'Recommend a promotion (designation/grade) and/or increment (CTC or %), off an appraisal; goes through approval and is applied on the effective date', tag: 'performance', permission: 'performance.review',
    requestExample: { employeeId: '…', appraisalId: '…', newDesignation: 'Senior Engineer', incrementPct: 12, effectiveFrom: '2027-04-01', justification: 'Exceeded on every goal; led the Q3 release.' } },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const b = requireBody<{ employeeId: string; appraisalId?: string; newDesignation?: string; newGradeCode?: string; newAnnualCtcPaise?: number; incrementPct?: number; effectiveFrom: string; justification: string }>(ctx.req, ['employeeId', 'effectiveFrom', 'justification'])
      const e = asUuid(b.employeeId, 'employeeId'); assertScope(ctx.auth, e)
      if (e === ctx.auth.employeeId) throw new HttpError(422, 'VALIDATION_FAILED', 'you cannot recommend yourself')
      if (b.newAnnualCtcPaise !== undefined && !ctx.auth.permissions.has('compensation.read')) throw new HttpError(403, 'PERMISSION_DENIED', 'give a percentage; the CTC figure needs compensation access')
      const r = await recommend(ctx.tx, ctx.config, { employeeId: e, appraisalId: b.appraisalId ? asUuid(b.appraisalId, 'appraisalId') : null, newDesignation: b.newDesignation, newGradeCode: b.newGradeCode,
        newAnnualCtcPaise: b.newAnnualCtcPaise === undefined ? null : asInt(b.newAnnualCtcPaise, 'newAnnualCtcPaise', { min: 1 }), incrementPct: b.incrementPct === undefined ? null : Number(b.incrementPct), effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'), justification: b.justification, recommendedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'recommendation.raised', entityType: 'recommendation', entityId: r.id, actorUserId: ctx.auth.userId, subjectEmployeeId: e, metadata: { kind: r.kind, designation: r.new_designation, pct: r.increment_pct, effectiveFrom: r.effective_from } })
      return created(ctx.auth.permissions.has('compensation.read') ? r : { ...r, new_annual_ctc_paise: null, current_annual_ctc_paise: null })
    }))

  router.post('/api/v1/recommendations/:id/withdraw', { summary: 'Withdraw a pending recommendation', tag: 'performance', permission: 'performance.review' },
    authed('performance.review', async (ctx) => {
      requireModule(ctx, 'performance.enabled')
      const r = await getRecommendation(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such recommendation')
      if (r.recommended_by_user_id !== ctx.auth.userId && ctx.auth.scope !== 'all') throw new HttpError(403, 'NOT_REQUESTER', 'only whoever recommended it, or HR, withdraws it')
      await withdrawRecommendation(ctx.tx, r.id); return noContent()
    }))
}
