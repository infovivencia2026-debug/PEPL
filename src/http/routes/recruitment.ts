/** Requisitions → candidates → interviews → offers → conversion into an employee. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asDate, asUuid, emit } from './deps.ts'
import {
  listRequisitions, getRequisition, raiseRequisition, setRequisitionStatus,
  listCandidates, getCandidate, addCandidate, moveCandidate,
  scheduleInterview, recordInterview, listInterviews,
  getOffer, offersFor, makeOffer, sendOffer, respondToOffer, withdrawOffer, convertToEmployee, STAGES,
} from '../../people/recruitment.ts'
import type { ChainCode } from '../../approvals/index.ts'

const publicUrl = (req: { headers: Record<string, string | string[] | undefined> }): string =>
  process.env.PEPL_PUBLIC_URL ?? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host ?? 'localhost')}`

export function register(router: Router): void {
  router.get('/api/v1/requisitions',
    { summary: 'Hiring requisitions with pipeline counts (?status=)', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => { requireModule(ctx, 'recruitment.enabled'); return ok({ requisitions: await listRequisitions(ctx.tx, ctx.req.query.get('status') ?? undefined) }) }))

  router.post('/api/v1/requisitions',
    { summary: 'Raise a requisition (approved through the engine; opens when approved)', tag: 'recruitment', permission: 'recruit.write',
      requestExample: { title: 'Senior Developer', department: 'Engineering', headcount: 2, minCtcPaise: 120000000, maxCtcPaise: 180000000, hiringManagerEmployeeId: '…', justification: 'backfill + growth' } },
    authed('recruit.write', async (ctx) => {
      requireModule(ctx, 'recruitment.enabled')
      const b = requireBody<Omit<Parameters<typeof raiseRequisition>[1], 'requestedByUserId' | 'fallbackChain'>>(ctx.req, ['title'])
      const r = await raiseRequisition(ctx.tx, { ...b, hiringManagerEmployeeId: b.hiringManagerEmployeeId ? asUuid(b.hiringManagerEmployeeId, 'hiringManagerEmployeeId') : null,
        requestedByUserId: ctx.auth.userId, fallbackChain: ctx.config.get<string>('recruitment.approval_chain') as ChainCode })
      await emit(ctx.tx, { action: 'recruit.requisition.raised', entityType: 'requisition', entityId: r.requisition.id, actorUserId: ctx.auth.userId, metadata: { title: r.requisition.title, headcount: r.requisition.headcount } })
      return created(r)
    }))

  router.get('/api/v1/requisitions/:id',
    { summary: 'One requisition', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => { const r = await getRequisition(ctx.tx, asUuid(ctx.req.params.id, 'id')); if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such requisition'); return ok(r) }))

  router.post('/api/v1/requisitions/:id/status',
    { summary: 'Put on hold, reopen, or cancel', tag: 'recruitment', permission: 'recruit.write', requestExample: { status: 'on_hold' } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<{ status: 'open' | 'on_hold' | 'cancelled' }>(ctx.req, ['status'])
      if (!['open', 'on_hold', 'cancelled'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status must be open, on_hold or cancelled')
      await setRequisitionStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status)
      return noContent()
    }))

  // ── candidates ──
  router.get('/api/v1/candidates',
    { summary: 'Candidates (?requisitionId=&stage=&q=)', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => {
      const rid = ctx.req.query.get('requisitionId')
      return ok({ candidates: await listCandidates(ctx.tx, { requisitionId: rid ? asUuid(rid, 'requisitionId') : undefined, stage: ctx.req.query.get('stage') ?? undefined, q: ctx.req.query.get('q') ?? undefined }), stages: STAGES })
    }))

  router.post('/api/v1/candidates',
    { summary: 'Add a candidate to an open requisition', tag: 'recruitment', permission: 'recruit.write',
      requestExample: { requisitionId: '…', firstName: 'Asha', lastName: 'Rao', email: 'asha@example.com', phone: '+91 98…', source: 'referral', expectedCtcPaise: 150000000 } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<Parameters<typeof addCandidate>[1]>(ctx.req, ['requisitionId', 'firstName', 'email'])
      const c = await addCandidate(ctx.tx, { ...b, requisitionId: asUuid(b.requisitionId, 'requisitionId'),
        referredByEmployeeId: b.referredByEmployeeId ? asUuid(b.referredByEmployeeId, 'referredByEmployeeId') : null,
        resumeDocumentId: b.resumeDocumentId ? asUuid(b.resumeDocumentId, 'resumeDocumentId') : null })
      await emit(ctx.tx, { action: 'recruit.candidate.added', entityType: 'candidate', entityId: c.id, actorUserId: ctx.auth.userId, metadata: { requisitionId: c.requisition_id, source: c.source } })
      return created(c)
    }))

  router.get('/api/v1/candidates/:id',
    { summary: 'One candidate with interviews and offers', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const c = await getCandidate(ctx.tx, id)
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'no such candidate')
      return ok({ ...c, interviews: await listInterviews(ctx.tx, { candidateId: id }), offers: await offersFor(ctx.tx, id) })
    }))

  router.post('/api/v1/candidates/:id/stage',
    { summary: 'Move a candidate along the pipeline (rejection needs a reason)', tag: 'recruitment', permission: 'recruit.write', requestExample: { stage: 'screening' } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<{ stage: string; reason?: string }>(ctx.req, ['stage'])
      const c = await moveCandidate(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.stage, b.reason)
      await emit(ctx.tx, { action: 'recruit.candidate.moved', entityType: 'candidate', entityId: c.id, actorUserId: ctx.auth.userId, metadata: { stage: c.stage } })
      return ok(c)
    }))

  // ── interviews ──
  router.get('/api/v1/interviews',
    { summary: 'Interviews (?candidateId= | ?mine=true&upcoming=true)', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => {
      const cid = ctx.req.query.get('candidateId')
      return ok({ interviews: await listInterviews(ctx.tx, { candidateId: cid ? asUuid(cid, 'candidateId') : undefined,
        interviewerUserId: ctx.req.query.get('mine') === 'true' ? ctx.auth.userId : undefined, upcoming: ctx.req.query.get('upcoming') === 'true' }) })
    }))

  router.post('/api/v1/interviews',
    { summary: 'Schedule an interview; the interviewers are notified', tag: 'recruitment', permission: 'recruit.write',
      requestExample: { candidateId: '…', round: 'Technical 1', scheduledAt: '2026-10-14T05:30:00Z', durationMin: 60, mode: 'video', interviewerUserIds: ['…'] } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<{ candidateId: string; round: string; scheduledAt: string; durationMin?: number; mode?: 'video' | 'phone' | 'in_person'; location?: string; interviewerUserIds: string[] }>(
        ctx.req, ['candidateId', 'round', 'scheduledAt', 'interviewerUserIds'])
      if (Number.isNaN(Date.parse(b.scheduledAt))) throw new HttpError(422, 'VALIDATION_FAILED', 'scheduledAt must be an ISO timestamp')
      const iv = await scheduleInterview(ctx.tx, { ...b, candidateId: asUuid(b.candidateId, 'candidateId'), interviewerUserIds: b.interviewerUserIds.map((u) => asUuid(u, 'interviewerUserIds')) })
      return created(iv)
    }))

  router.post('/api/v1/interviews/:id/outcome',
    { summary: 'Record the outcome (an interviewer): score 1–5, recommendation, feedback — or cancelled / no_show', tag: 'recruitment', permission: 'recruit.read',
      requestExample: { status: 'completed', score: 4, recommendation: 'hire', feedback: 'Strong on fundamentals' } },
    authed('recruit.read', async (ctx) => {
      const b = requireBody<{ status: 'completed' | 'cancelled' | 'no_show'; score?: number; recommendation?: 'strong_hire' | 'hire' | 'no_hire' | 'strong_no_hire'; feedback?: string }>(ctx.req, ['status'])
      return ok(await recordInterview(ctx.tx, { interviewId: asUuid(ctx.req.params.id, 'id'), actorUserId: ctx.auth.userId, ...b }))
    }))

  // ── offers ──
  router.post('/api/v1/offers',
    { summary: 'Make an offer (approved through the engine; within the requisition band)', tag: 'recruitment', permission: 'recruit.write',
      requestExample: { candidateId: '…', designation: 'Senior Developer', annualCtcPaise: 150000000, components: { BASIC: 6250000, HRA: 2500000 }, joiningDate: '2026-11-16', validUntil: '2026-10-31', probationMonths: 6 } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<Omit<Parameters<typeof makeOffer>[1], 'createdByUserId' | 'fallbackChain'>>(ctx.req, ['candidateId', 'designation', 'annualCtcPaise', 'joiningDate', 'validUntil'])
      const r = await makeOffer(ctx.tx, { ...b, candidateId: asUuid(b.candidateId, 'candidateId'), joiningDate: asDate(b.joiningDate, 'joiningDate'), validUntil: asDate(b.validUntil, 'validUntil'),
        createdByUserId: ctx.auth.userId, fallbackChain: ctx.config.get<string>('recruitment.approval_chain') as ChainCode })
      await emit(ctx.tx, { action: 'recruit.offer.made', entityType: 'offer', entityId: r.offer.id, actorUserId: ctx.auth.userId, metadata: { candidateId: r.offer.candidate_id, annualCtcPaise: r.offer.annual_ctc_paise } })
      return created(r)
    }))

  router.get('/api/v1/offers/:id',
    { summary: 'One offer', tag: 'recruitment', permission: 'recruit.read' },
    authed('recruit.read', async (ctx) => { const o = await getOffer(ctx.tx, asUuid(ctx.req.params.id, 'id')); if (!o) throw new HttpError(404, 'NOT_FOUND', 'no such offer'); return ok(o) }))

  router.post('/api/v1/offers/:id/send',
    { summary: 'Mark an approved offer as sent (attach the letter document id if you generated one)', tag: 'recruitment', permission: 'recruit.write', requestExample: { letterDocumentId: '…' } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<{ letterDocumentId?: string }>(ctx.req, [])
      const o = await sendOffer(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.letterDocumentId ? asUuid(b.letterDocumentId, 'letterDocumentId') : null)
      await emit(ctx.tx, { action: 'recruit.offer.sent', entityType: 'offer', entityId: o.id, actorUserId: ctx.auth.userId })
      return ok(o)
    }))

  router.post('/api/v1/offers/:id/respond',
    { summary: 'Record the candidate\'s answer', tag: 'recruitment', permission: 'recruit.write', requestExample: { response: 'accepted' } },
    authed('recruit.write', async (ctx) => {
      const b = requireBody<{ response: 'accepted' | 'declined' }>(ctx.req, ['response'])
      if (!['accepted', 'declined'].includes(b.response)) throw new HttpError(422, 'VALIDATION_FAILED', 'response must be accepted or declined')
      const o = await respondToOffer(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.response)
      await emit(ctx.tx, { action: b.response === 'accepted' ? 'recruit.offer.accepted' : 'recruit.offer.declined', entityType: 'offer', entityId: o.id, actorUserId: ctx.auth.userId })
      return ok(o)
    }))

  router.post('/api/v1/offers/:id/withdraw',
    { summary: 'Withdraw a live offer', tag: 'recruitment', permission: 'recruit.write' },
    authed('recruit.write', async (ctx) => { await withdrawOffer(ctx.tx, asUuid(ctx.req.params.id, 'id')); return noContent() }))

  router.post('/api/v1/offers/:id/convert',
    { summary: 'The accepted candidate becomes an employee: record, assignment, salary, login invite, onboarding checklist — in one step', tag: 'recruitment',
      permission: 'employee.write', requestExample: { employeeNumber: 'ACM-042' } },
    authed('employee.write', async (ctx) => {
      requireModule(ctx, 'recruitment.enabled')
      const b = requireBody<{ employeeNumber?: string }>(ctx.req, [])
      const r = await convertToEmployee(ctx.tx, { offerId: asUuid(ctx.req.params.id, 'id'), employeeNumber: b.employeeNumber, actorUserId: ctx.auth.userId, ip: ctx.req.ip })
      await emit(ctx.tx, { action: 'people.employee.created', entityType: 'employee', entityId: r.employeeId, entityLabel: r.employeeNumber, subjectEmployeeId: r.employeeId,
        actorUserId: ctx.auth.userId, after: { employeeNumber: r.employeeNumber, viaOffer: ctx.req.params.id, onboardingTasks: r.tasks } })
      return created({ ...r, inviteLink: `${publicUrl(ctx.req)}/reset-password?token=${r.inviteToken}`, inviteToken: undefined })
    }))
}
