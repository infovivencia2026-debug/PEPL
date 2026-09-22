/** Policies, surveys, celebrations. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { draftPolicy, publishPolicy, listPolicies, acknowledgePolicy, policyCompliance, createSurvey, openSurvey, closeSurvey, listSurveys, respondSurvey, surveyResults, celebrations, type Question } from '../../comms/engage.ts'

export function register(router: Router): void {
  // ── policies ──
  router.get('/api/v1/policies', { summary: 'Policies (?status=); each carries whether YOU have acknowledged it', tag: 'engage', permission: 'policy.read' },
    authed('policy.read', async (ctx) => ok({ policies: await listPolicies(ctx.tx, { status: ctx.req.query.get('status') ?? undefined, forEmployeeId: ctx.auth.employeeId ?? undefined }) })))

  router.post('/api/v1/policies', { summary: 'Draft a policy (a new version when the code exists)', tag: 'engage', permission: 'policy.manage',
    requestExample: { code: 'POSH', title: 'Prevention of Sexual Harassment Policy', body: '## Purpose …', requiresAcknowledgement: true, dueDays: 14 } },
    authed('policy.manage', async (ctx) => {
      const b = requireBody<{ code: string; title: string; body?: string; documentId?: string; requiresAcknowledgement?: boolean; appliesTo?: { departments?: string[]; locations?: string[] }; dueDays?: number }>(ctx.req, ['code', 'title'])
      const p = await draftPolicy(ctx.tx, { ...b, documentId: b.documentId ? asUuid(b.documentId, 'documentId') : null, dueDays: b.dueDays === undefined ? undefined : asInt(b.dueDays, 'dueDays', { min: 1, max: 365 }), actorUserId: ctx.auth.userId })
      return created(p)
    }))

  router.post('/api/v1/policies/:id/publish', { summary: 'Publish: the audience is told; the previous version of the same code retires', tag: 'engage', permission: 'policy.manage' },
    authed('policy.manage', async (ctx) => {
      const r = await publishPolicy(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      await emit(ctx.tx, { action: 'policy.published', entityType: 'policy', entityId: r.policy.id, actorUserId: ctx.auth.userId, metadata: { code: r.policy.code, version: r.policy.version, notified: r.notified } })
      return ok(r)
    }))

  router.post('/api/v1/policies/:id/acknowledge', { summary: 'I have read and accept this policy', tag: 'engage', permission: 'policy.read' },
    authed('policy.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const id = asUuid(ctx.req.params.id, 'id')
      await acknowledgePolicy(ctx.tx, { policyId: id, employeeId: ctx.auth.employeeId, ip: ctx.req.ip ?? null })
      await emit(ctx.tx, { action: 'policy.acknowledged', entityType: 'policy', entityId: id, subjectEmployeeId: ctx.auth.employeeId, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.get('/api/v1/policies/:id/compliance', { summary: 'Who has and has not acknowledged, with due date', tag: 'engage', permission: 'policy.manage' },
    authed('policy.manage', async (ctx) => ok(await policyCompliance(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

  // ── surveys ──
  router.get('/api/v1/surveys', { summary: 'Surveys (?status=) with whether you have responded', tag: 'engage', permission: 'survey.read' },
    authed('survey.read', async (ctx) => { requireModule(ctx, 'surveys.enabled'); return ok({ surveys: await listSurveys(ctx.tx, { status: ctx.req.query.get('status') ?? undefined, forEmployeeId: ctx.auth.employeeId ?? undefined }) }) }))

  router.post('/api/v1/surveys', { summary: 'Create a survey (draft). Anonymous by default with a minimum group of 5', tag: 'engage', permission: 'survey.manage',
    requestExample: { title: 'October pulse', kind: 'enps', questions: [{ id: 'nps', text: 'How likely are you to recommend working here?', type: 'nps' }, { id: 'why', text: 'What is the one thing we should fix?', type: 'text' }], anonymous: true, minGroup: 5 } },
    authed('survey.manage', async (ctx) => {
      requireModule(ctx, 'surveys.enabled')
      const b = requireBody<{ title: string; kind?: 'pulse' | 'enps' | 'custom' | 'suggestion_box'; questions: Question[]; anonymous?: boolean; minGroup?: number; audience?: { departments?: string[]; locations?: string[] }; closesAt?: string }>(ctx.req, ['title', 'questions'])
      return created(await createSurvey(ctx.tx, { ...b, closesAt: b.closesAt ? new Date(b.closesAt).toISOString() : null, actorUserId: ctx.auth.userId }))
    }))

  router.post('/api/v1/surveys/:id/open', { summary: 'Open: the audience is invited', tag: 'engage', permission: 'survey.manage' },
    authed('survey.manage', async (ctx) => ok(await openSurvey(ctx.tx, asUuid(ctx.req.params.id, 'id')))))
  router.post('/api/v1/surveys/:id/close', { summary: 'Close', tag: 'engage', permission: 'survey.manage' },
    authed('survey.manage', async (ctx) => ok(await closeSurvey(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

  router.post('/api/v1/surveys/:id/respond', { summary: 'Answer once. On an anonymous survey nothing links the answers to you', tag: 'engage', permission: 'survey.read', requestExample: { answers: { nps: 8, why: 'Faster laptops' } } },
    authed('survey.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ answers: Record<string, unknown> }>(ctx.req, ['answers'])
      await respondSurvey(ctx.tx, { surveyId: asUuid(ctx.req.params.id, 'id'), employeeId: ctx.auth.employeeId, userId: ctx.auth.userId, answers: b.answers ?? {} })
      return noContent()
    }))

  router.get('/api/v1/surveys/:id/results', { summary: 'Aggregates only (?by=department|location); groups below the minimum are withheld; eNPS when there is an NPS question', tag: 'engage', permission: 'survey.manage' },
    authed('survey.manage', async (ctx) => {
      const by = ctx.req.query.get('by')
      if (by && !['department', 'location'].includes(by)) throw new HttpError(422, 'VALIDATION_FAILED', 'by is department or location')
      return ok(await surveyResults(ctx.tx, asUuid(ctx.req.params.id, 'id'), (by as 'department' | 'location' | null) ?? null))
    }))

  // ── celebrations ──
  router.get('/api/v1/celebrations', { summary: 'Birthdays and work anniversaries in your scope (?from=&to=, default the next 14 days); people can opt out', tag: 'engage', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const from = ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : localToday(ctx.config.get<string>('attendance.timezone'))
      const to = ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : new Date(Date.parse(from) + 14 * 86_400_000).toISOString().slice(0, 10)
      return ok({ from, to, items: await celebrations(ctx.tx, { from, to, employeeIds: ctx.auth.scope === 'self' ? null : scopeIds(ctx) }) })
    }))
}
