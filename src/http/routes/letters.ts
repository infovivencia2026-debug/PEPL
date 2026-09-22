/** Letter templates, issued letters, probation reviews. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, asUuid, asDate, asInt, assertScope, can, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { listTemplates, upsertTemplate, retireTemplate, previewLetter, issueLetter, listIssued, FIELDS, listProbationReviews, decideProbation, openDueProbationReviews } from '../../people/letters.ts'

export function register(router: Router): void {
  router.get('/api/v1/letters/templates', { summary: 'Letter templates (defaults seeded on first call; ?includeRetired=true) and the merge fields they may use', tag: 'letters', permission: 'letter.read' },
    authed('letter.read', async (ctx) => ok({ templates: await listTemplates(ctx.tx, ctx.req.query.get('includeRetired') === 'true'), fields: [...FIELDS, 'custom.<anything>'] })))

  router.post('/api/v1/letters/templates',
    { summary: 'Create or replace a template by code; body uses {{merge.fields}} and blank lines between paragraphs', tag: 'letters', permission: 'letter.manage',
      requestExample: { code: 'transfer', name: 'Transfer letter', title: 'TRANSFER ORDER', body: 'Dear {{employee.first_name}},\n\nYou are transferred to {{custom.new_location}} with effect from {{custom.effective_from}}.', category: 'other', confidential: true } },
    authed('letter.manage', async (ctx) => {
      const b = requireBody<{ code: string; name: string; title: string; body: string; category?: string; confidential?: boolean }>(ctx.req, ['code', 'name', 'title', 'body'])
      const t = await upsertTemplate(ctx.tx, b)
      await emit(ctx.tx, { action: 'letter.template.changed', entityType: 'letter_template', entityId: t.id, actorUserId: ctx.auth.userId, metadata: { code: t.code } })
      return created(t)
    }))

  router.post('/api/v1/letters/templates/:code/retire', { summary: 'Retire a template', tag: 'letters', permission: 'letter.manage' },
    authed('letter.manage', async (ctx) => { await retireTemplate(ctx.tx, ctx.req.params.code!); return noContent() }))

  router.post('/api/v1/letters/preview',
    { summary: 'Merged text for a template + employee, with the custom fields still missing', tag: 'letters', permission: 'letter.issue',
      requestExample: { code: 'salary_certificate', employeeId: '…', custom: { purpose: 'a housing loan' } } },
    authed('letter.issue', async (ctx) => {
      const b = requireBody<{ code: string; employeeId: string; custom?: Record<string, string> }>(ctx.req, ['code', 'employeeId'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      assertScope(ctx.auth, employeeId)
      return ok(await previewLetter(ctx.tx, { code: b.code, employeeId, custom: b.custom }))
    }))

  router.post('/api/v1/letters/issue',
    { summary: 'Issue a letter: PDF filed under the employee\'s documents, reference number, employee notified', tag: 'letters', permission: 'letter.issue',
      requestExample: { code: 'experience', employeeId: '…', custom: { last_day: '31 October 2026' }, signatory: 'Priya Sharma, Head of HR' } },
    authed('letter.issue', async (ctx) => {
      const b = requireBody<{ code: string; employeeId: string; custom?: Record<string, string>; signatory?: string; notifyEmployee?: boolean }>(ctx.req, ['code', 'employeeId'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      assertScope(ctx.auth, employeeId)
      const r = await issueLetter(ctx.tx, { code: b.code, employeeId, custom: b.custom, actorUserId: ctx.auth.userId, signatory: b.signatory, notifyEmployee: b.notifyEmployee })
      await emit(ctx.tx, { action: 'letter.issued', entityType: 'document', entityId: r.document.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { code: b.code, referenceNo: r.letter.reference_no } })
      return created(r)
    }))

  router.get('/api/v1/letters', { summary: 'Issued letters (?employeeId=&code=), scope-limited', tag: 'letters', permission: 'letter.read' },
    authed('letter.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ letters: await listIssued(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, code: ctx.req.query.get('code') ?? undefined }) })
    }))

  // ── probation ──
  router.get('/api/v1/probation/reviews', { summary: 'Probation reviews (?status=pending|confirmed|extended|separated; ?mine=true for ones you review)', tag: 'letters', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const mine = ctx.req.query.get('mine') === 'true'
      return ok({ reviews: await listProbationReviews(ctx.tx, { employeeIds: mine ? null : scopeIds(ctx), status: ctx.req.query.get('status') ?? undefined, reviewerEmployeeId: mine ? ctx.auth.employeeId ?? undefined : undefined }) })
    }))

  router.post('/api/v1/probation/reviews/open-due', { summary: 'Open reviews for probations ending within N days (the nightly job does this too)', tag: 'letters', permission: 'employee.write', requestExample: { daysAhead: 14 } },
    authed('employee.write', async (ctx) => {
      const b = requireBody<{ daysAhead?: number }>(ctx.req, [])
      return ok({ opened: await openDueProbationReviews(ctx.tx, b.daysAhead === undefined ? 14 : asInt(b.daysAhead, 'daysAhead', { min: 0, max: 90 })) })
    }))

  router.post('/api/v1/probation/reviews/:id/decide',
    { summary: 'Confirm (letter issued, employment permanent), extend (new end date) or separate; by the reviewer or HR', tag: 'letters', permission: 'employee.read',
      requestExample: { decision: 'confirm', rating: 4, remarks: 'Meets expectations' } },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ decision: 'confirm' | 'extend' | 'separate'; rating?: number; remarks?: string; extendedTo?: string; issueLetter?: boolean }>(ctx.req, ['decision'])
      if (!['confirm', 'extend', 'separate'].includes(b.decision)) throw new HttpError(422, 'VALIDATION_FAILED', 'decision is confirm, extend or separate')
      const r = (await listProbationReviews(ctx.tx, {})).find((x) => x.id === id)
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such review')
      const isReviewer = r.reviewer_employee_id !== null && r.reviewer_employee_id === ctx.auth.employeeId
      if (!isReviewer && !can(ctx.auth, 'employee.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'only the reviewer or HR decides a probation')
      assertScope(ctx.auth, r.employee_id)
      const out = await decideProbation(ctx.tx, { reviewId: id, decision: b.decision, rating: b.rating === undefined ? undefined : asInt(b.rating, 'rating', { min: 1, max: 5 }), remarks: b.remarks,
        extendedTo: b.extendedTo ? asDate(b.extendedTo, 'extendedTo') : undefined, actorUserId: ctx.auth.userId, issueLetter: b.issueLetter })
      await emit(ctx.tx, { action: 'people.probation.decided', entityType: 'probation_review', entityId: id, subjectEmployeeId: r.employee_id, actorUserId: ctx.auth.userId, metadata: { decision: b.decision, extendedTo: out.extended_to } })
      return ok(out)
    }))
}
