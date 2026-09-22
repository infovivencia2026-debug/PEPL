/** Learning-lite (courses, nominations, completion, training compliance) and recognition (badges, feed, points). */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, assertScope, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { upsertCourse, listCourses, retireCourse, nominate, nominateMandatory, startCourse, completeCourse, waive, listNominations, trainingCompliance, listBadges, upsertBadge, recognise, recognitionFeed, pointsBalance, redeemPoints, leaderboard } from '../../people/learning.ts'

export function register(router: Router): void {
  // ── courses ──
  router.get('/api/v1/learning/courses', { summary: 'Course catalogue (?all=true includes retired)', tag: 'learning', permission: 'learning.read' },
    authed('learning.read', async (ctx) => { requireModule(ctx, 'learning.enabled'); return ok({ courses: await listCourses(ctx.tx, ctx.req.query.get('all') === 'true') }) }))

  router.post('/api/v1/learning/courses', { summary: 'Create or update a course by code; a mandatory course reaches its whole audience nightly', tag: 'learning', permission: 'learning.manage',
    requestExample: { code: 'POSH_AWARENESS', title: 'POSH awareness', mode: 'online', link: 'https://…', mandatory: true, validityMonths: 12, dueDays: 30, audience: {} } },
    authed('learning.manage', async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const b = requireBody<Parameters<typeof upsertCourse>[1]>(ctx.req, ['code', 'title'])
      const c = await upsertCourse(ctx.tx, { ...b, validityMonths: b.validityMonths == null ? b.validityMonths : asInt(b.validityMonths, 'validityMonths', { min: 1, max: 120 }), dueDays: b.dueDays === undefined ? undefined : asInt(b.dueDays, 'dueDays', { min: 1, max: 365 }) })
      await emit(ctx.tx, { action: 'course.upserted', entityType: 'course', entityId: c.id, actorUserId: ctx.auth.userId, metadata: { code: c.code, mandatory: c.mandatory } })
      return created(c)
    }))

  router.del('/api/v1/learning/courses/:code', { summary: 'Retire a course (nominations stay)', tag: 'learning', permission: 'learning.manage' },
    authed('learning.manage', async (ctx) => { requireModule(ctx, 'learning.enabled'); await retireCourse(ctx.tx, String(ctx.req.params.code ?? '').toUpperCase()); return noContent() }))

  // ── nominations ──
  router.post('/api/v1/learning/courses/:code/nominate', { summary: 'Nominate employees (skips anyone already on it or still certified); ?all=true nominates every mandatory course\'s audience', tag: 'learning', permission: 'learning.manage',
    requestExample: { employeeIds: ['…'], dueOn: '2026-11-30' } },
    authed('learning.manage', async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const b = requireBody<{ employeeIds: string[]; dueOn?: string }>(ctx.req, ['employeeIds'])
      if (!Array.isArray(b.employeeIds) || !b.employeeIds.length) throw new HttpError(422, 'VALIDATION_FAILED', 'employeeIds is a non-empty list')
      const ids = b.employeeIds.map((e) => asUuid(e, 'employeeIds'))
      for (const e of ids) assertScope(ctx.auth, e)
      const n = await nominate(ctx.tx, { courseCode: String(ctx.req.params.code ?? '').toUpperCase(), employeeIds: ids, nominatedByUserId: ctx.auth.userId, dueOn: b.dueOn ? asDate(b.dueOn, 'dueOn') : undefined })
      await emit(ctx.tx, { action: 'course.nominated', entityType: 'course', actorUserId: ctx.auth.userId, metadata: { code: String(ctx.req.params.code ?? '').toUpperCase(), nominated: n } })
      return ok({ nominated: n })
    }))

  router.post('/api/v1/learning/nominate-mandatory', { summary: 'Run the mandatory sweep now (what the nightly job does)', tag: 'learning', permission: 'learning.manage' },
    authed('learning.manage', async (ctx) => { requireModule(ctx, 'learning.enabled'); return ok({ nominated: await nominateMandatory(ctx.tx) }) }))

  router.get('/api/v1/learning/nominations', { summary: 'Nominations in your scope (?employeeId=&course=&status=)', tag: 'learning', permission: 'learning.read' },
    authed('learning.read', async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ nominations: await listNominations(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, courseCode: ctx.req.query.get('course')?.toUpperCase() ?? undefined, status: ctx.req.query.get('status') ?? undefined }) })
    }))

  router.get('/api/v1/me/learning', { summary: 'My courses and my points', tag: 'learning', },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      if (!ctx.auth.employeeId) return ok({ nominations: [], points: { balance: 0, earned: 0, redeemed: 0 } })
      return ok({ nominations: await listNominations(ctx.tx, { employeeId: ctx.auth.employeeId }), points: await pointsBalance(ctx.tx, ctx.auth.employeeId) })
    }))

  router.post('/api/v1/learning/nominations/:id/start', { summary: 'I have started this course', tag: 'learning', },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      await startCourse(ctx.tx, { nominationId: asUuid(ctx.req.params.id, 'id'), employeeId: ctx.auth.employeeId }); return noContent()
    }))

  router.post('/api/v1/learning/nominations/:id/complete', { summary: 'Record completion — by the nominee (self-paced) or by HR/trainer with score, pass/fail and certificate', tag: 'learning', permission: undefined,
    requestExample: { score: 85, passed: true, certificateDocumentId: '…' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const b = (ctx.req.body ?? {}) as { score?: number | null; passed?: boolean; certificateDocumentId?: string | null; note?: string }
      const byTrainer = ctx.auth.permissions.has('learning.manage')
      const n = await completeCourse(ctx.tx, { nominationId: asUuid(ctx.req.params.id, 'id'), employeeId: ctx.auth.employeeId ?? undefined, byTrainer, score: b.score, passed: b.passed, certificateDocumentId: b.certificateDocumentId ? asUuid(b.certificateDocumentId, 'certificateDocumentId') : null, note: b.note, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'course.completed', entityType: 'course_nomination', entityId: n.id, actorUserId: ctx.auth.userId, subjectEmployeeId: n.employee_id, metadata: { code: n.course_code, status: n.status, score: n.score, validUntil: n.valid_until } })
      return ok(n)
    }))

  router.post('/api/v1/learning/nominations/:id/waive', { summary: 'Waive a nomination with a reason', tag: 'learning', permission: 'learning.manage', requestExample: { note: 'Certified externally, certificate on file' } },
    authed('learning.manage', async (ctx) => { requireModule(ctx, 'learning.enabled'); await waive(ctx.tx, asUuid(ctx.req.params.id, 'id'), requireBody<{ note: string }>(ctx.req, ['note']).note); return noContent() }))

  router.get('/api/v1/learning/compliance', { summary: 'Mandatory-training compliance per course: completed, open, overdue (named), expiring within 60 days', tag: 'learning', permission: 'learning.manage' },
    authed('learning.manage', async (ctx) => { requireModule(ctx, 'learning.enabled'); return ok({ courses: await trainingCompliance(ctx.tx, localToday(ctx.config.get<string>('attendance.timezone'))) }) }))

  // ── recognition ──
  router.get('/api/v1/recognition/badges', { summary: 'Badges anyone may give (manager-only ones flagged); defaults seeded on first read', tag: 'recognition', },
    authed(null, async (ctx) => { requireModule(ctx, 'learning.enabled'); return ok({ badges: await listBadges(ctx.tx) }) }))

  router.post('/api/v1/recognition/badges', { summary: 'Create or update a badge by code', tag: 'recognition', permission: 'recognition.manage', requestExample: { code: 'SAFETY_FIRST', name: 'Safety first', points: 25, managerOnly: false } },
    authed('recognition.manage', async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const b = requireBody<{ code: string; name: string; description?: string; points?: number; managerOnly?: boolean }>(ctx.req, ['code', 'name'])
      return created(await upsertBadge(ctx.tx, { ...b, points: b.points === undefined ? undefined : asInt(b.points, 'points', { min: 0, max: 10_000 }) }))
    }))

  router.post('/api/v1/recognition', { summary: 'Recognise a colleague with a badge and a message; points land in their balance', tag: 'recognition', permission: undefined,
    requestExample: { badgeCode: 'TEAM_PLAYER', toEmployeeId: '…', message: 'Stayed late to get the dispatch out', visibility: 'company' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const b = requireBody<{ badgeCode: string; toEmployeeId: string; message: string; visibility?: 'company' | 'team' | 'private' }>(ctx.req, ['badgeCode', 'toEmployeeId', 'message'])
      if (b.visibility && !['company', 'team', 'private'].includes(b.visibility)) throw new HttpError(422, 'VALIDATION_FAILED', 'visibility is company, team or private')
      const to = asUuid(b.toEmployeeId, 'toEmployeeId')
      const isManager = ctx.auth.scope === 'all' || (ctx.auth.scope === 'reports' && ctx.auth.reportIds.has(to))
      const r = await recognise(ctx.tx, { badgeCode: b.badgeCode.toUpperCase(), toEmployeeId: to, fromUserId: ctx.auth.userId, fromEmployeeId: ctx.auth.employeeId ?? null, isManager, message: b.message, visibility: b.visibility })
      await emit(ctx.tx, { action: 'recognition.given', entityType: 'recognition', entityId: r.id, actorUserId: ctx.auth.userId, subjectEmployeeId: to, metadata: { badge: r.badge_code, points: r.points } })
      ctx.publish({ type: 'recognition.given', data: { id: r.id, badge: r.badge_code, toEmployeeId: to } })
      return created(r)
    }))

  router.get('/api/v1/recognition/feed', { summary: 'The wall: company-visible recognitions, plus team ones in your scope and your own (?employeeId=&limit=)', tag: 'recognition', },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      return ok({ recognitions: await recognitionFeed(ctx.tx, { employeeId, limit: ctx.req.query.get('limit') ? asInt(ctx.req.query.get('limit'), 'limit', { min: 1, max: 200 }) : undefined, viewerEmployeeId: ctx.auth.employeeId ?? null, viewerScopeIds: scopeIds(ctx) }) })
    }))

  router.get('/api/v1/recognition/leaderboard', { summary: 'Top recipients by points in a window (?from=&to=, default this quarter)', tag: 'recognition', },
    authed(null, async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const today = localToday(ctx.config.get<string>('attendance.timezone'))
      const q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) * 3 + 1
      const from = ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : `${today.slice(0, 4)}-${String(q).padStart(2, '0')}-01`
      return ok({ from, to: ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : today, leaders: await leaderboard(ctx.tx, { from, to: ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : today }) })
    }))

  router.get('/api/v1/recognition/points/:employeeId', { summary: 'Points balance for an employee in your scope', tag: 'recognition', permission: 'recognition.manage' },
    authed('recognition.manage', async (ctx) => { requireModule(ctx, 'learning.enabled'); const e = asUuid(ctx.req.params.employeeId, 'employeeId'); assertScope(ctx.auth, e); return ok(await pointsBalance(ctx.tx, e)) }))

  router.post('/api/v1/recognition/points/:employeeId/redeem', { summary: 'Redeem or pay out points (kind: redemption | payout | adjustment); the ledger is append-only', tag: 'recognition', permission: 'recognition.manage',
    requestExample: { points: 100, kind: 'redemption', note: 'Amazon voucher ₹500' } },
    authed('recognition.manage', async (ctx) => {
      requireModule(ctx, 'learning.enabled')
      const e = asUuid(ctx.req.params.employeeId, 'employeeId'); assertScope(ctx.auth, e)
      const b = requireBody<{ points: number; kind: 'redemption' | 'payout' | 'adjustment'; note: string }>(ctx.req, ['points', 'kind', 'note'])
      if (!['redemption', 'payout', 'adjustment'].includes(b.kind)) throw new HttpError(422, 'VALIDATION_FAILED', 'kind is redemption, payout or adjustment')
      const r = await redeemPoints(ctx.tx, { employeeId: e, points: asInt(b.points, 'points', { min: -100_000, max: 100_000 }), kind: b.kind, note: b.note })
      await emit(ctx.tx, { action: 'points.redeemed', entityType: 'employee', entityId: e, actorUserId: ctx.auth.userId, subjectEmployeeId: e, metadata: { points: b.points, kind: b.kind, balance: r.balance } })
      return ok(r)
    }))
}
