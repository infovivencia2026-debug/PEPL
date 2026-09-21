/** Resign → accept → clearance → interview → letter. The money is in exit.ts. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, asDate, asUuid, assertScope, can, emit } from './deps.ts'
import {
  submitResignation, withdrawResignation, acceptResignation, declineResignation, listResignations, getResignation,
  listClearances, clearArea, recordExitInterview, getExitInterview, issueRelievingLetter, exitOverview, CLEARANCE_AREAS, type ClearanceArea,
} from '../../people/exit-workflow.ts'
import { scopeIds } from '../ui-data.ts'

export function register(router: Router): void {
  router.post('/api/v1/resignations',
    { summary: 'Resign (your own record). HR and your manager are told; HR accepts or declines', tag: 'exit', permission: 'employee.read',
      requestExample: { requestedLastDay: '2026-11-30', reason: 'Moving to Pune for family reasons', reasonCategory: 'relocation' } },
    authed('employee.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ requestedLastDay: string; reason: string; reasonCategory?: string }>(ctx.req, ['requestedLastDay', 'reason'])
      const r = await submitResignation(ctx.tx, { employeeId: ctx.auth.employeeId, requestedLastDay: asDate(b.requestedLastDay, 'requestedLastDay'), reason: b.reason, reasonCategory: b.reasonCategory as never })
      await emit(ctx.tx, { action: 'exit.resignation.submitted', entityType: 'resignation', entityId: r.id, subjectEmployeeId: r.employee_id, actorUserId: ctx.auth.userId, metadata: { requestedLastDay: r.requested_last_day, category: r.reason_category } })
      return created(r)
    }))

  router.get('/api/v1/resignations',
    { summary: 'Resignations you may see (own, your reports, or all), newest first', tag: 'exit', permission: 'employee.read' },
    authed('employee.read', async (ctx) => ok({ resignations: await listResignations(ctx.tx, { employeeIds: scopeIds(ctx), status: ctx.req.query.get('status') ?? undefined }) })))

  router.post('/api/v1/resignations/:id/withdraw',
    { summary: 'Withdraw your resignation while HR has not acted on it', tag: 'exit', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await getResignation(ctx.tx, id)
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such resignation')
      if (r.employee_id !== ctx.auth.employeeId) throw new HttpError(403, 'PERMISSION_DENIED', 'only the person who resigned can withdraw it')
      await withdrawResignation(ctx.tx, id, r.employee_id)
      await emit(ctx.tx, { action: 'exit.resignation.withdrawn', entityType: 'resignation', entityId: id, subjectEmployeeId: r.employee_id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.post('/api/v1/resignations/:id/accept',
    { summary: 'HR accepts: creates the separation, opens clearances, starts the offboarding checklist', tag: 'exit', permission: 'employee.write',
      requestExample: { lastWorkingDay: '2026-11-30', noticeWaived: false, note: 'notice served in full' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ lastWorkingDay?: string; noticeWaived?: boolean; note?: string }>(ctx.req, [])
      const r = await acceptResignation(ctx.tx, { resignationId: id, lastWorkingDay: b.lastWorkingDay ? asDate(b.lastWorkingDay, 'lastWorkingDay') : undefined, noticeWaived: b.noticeWaived, note: b.note, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'employee.separation.initiated', entityType: 'employee', entityId: r.separation.employee_id, subjectEmployeeId: r.separation.employee_id, actorUserId: ctx.auth.userId,
        metadata: { reason: 'resignation', lastWorkingDay: r.separation.last_working_day, viaResignation: id, checklistTasks: r.tasks } })
      return ok(r)
    }))

  router.post('/api/v1/resignations/:id/decline',
    { summary: 'HR declines (retained, counter-offer); reason required', tag: 'exit', permission: 'employee.write', requestExample: { note: 'retained with a role change' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ note: string }>(ctx.req, ['note'])
      await declineResignation(ctx.tx, id, b.note, ctx.auth.userId)
      await emit(ctx.tx, { action: 'exit.resignation.declined', entityType: 'resignation', entityId: id, actorUserId: ctx.auth.userId, reason: b.note })
      return noContent()
    }))

  router.get('/api/v1/employees/:id/exit',
    { summary: 'Everything about a person\'s exit: resignation, separation, clearances, interview (HR only), open blocking tasks', tag: 'exit', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const o = await exitOverview(ctx.tx, id)
      // the exit interview is HR's; the manager (and the person) do not see it here
      return ok(can(ctx.auth, 'employee.write') ? o : { ...o, interview: null })
    }))

  router.post('/api/v1/separations/:id/clearances/:area',
    { summary: 'Sign off one clearance area (manager|it|finance|admin|hr), cleared or with a recovery the F&F deducts', tag: 'exit',
      permission: 'approval.act', requestExample: { status: 'recovery', recoveryPaise: 4500000, note: 'MacBook not returned' } },
    authed('approval.act', async (ctx) => {
      const separationId = asUuid(ctx.req.params.id, 'id')
      const area = String(ctx.req.params.area) as ClearanceArea
      if (!CLEARANCE_AREAS.includes(area)) throw new HttpError(422, 'VALIDATION_FAILED', `area must be one of ${CLEARANCE_AREAS.join(', ')}`)
      const sep = (await ctx.tx.query<{ employee_id: string }>(`SELECT employee_id FROM employee_separations WHERE id = $1`, [separationId])).rows[0]
      if (!sep) throw new HttpError(404, 'NOT_FOUND', 'no such separation')
      // the manager area is the reporting line; the others are role-based
      if (area === 'manager') assertScope(ctx.auth, sep.employee_id)
      else if (!can(ctx.auth, area === 'hr' ? 'employee.write' : area === 'finance' ? 'bank.read' : 'settings.write') && !can(ctx.auth, 'employee.write')) {
        throw new HttpError(403, 'PERMISSION_DENIED', `${area} clearance is for that team or HR`)
      }
      const b = requireBody<{ status: 'cleared' | 'recovery'; note?: string; recoveryPaise?: number }>(ctx.req, ['status'])
      const r = await clearArea(ctx.tx, { separationId, area, status: b.status, note: b.note, recoveryPaise: b.recoveryPaise, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'exit.clearance.signed', entityType: 'separation', entityId: separationId, subjectEmployeeId: sep.employee_id, actorUserId: ctx.auth.userId,
        metadata: { area, status: b.status, recoveryPaise: b.recoveryPaise ?? 0, allCleared: r.allCleared } })
      return ok(r)
    }))

  router.get('/api/v1/separations/:id/clearances',
    { summary: 'Clearance status by area', tag: 'exit', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const separationId = asUuid(ctx.req.params.id, 'id')
      const sep = (await ctx.tx.query<{ employee_id: string }>(`SELECT employee_id FROM employee_separations WHERE id = $1`, [separationId])).rows[0]
      if (!sep) throw new HttpError(404, 'NOT_FOUND', 'no such separation')
      assertScope(ctx.auth, sep.employee_id)
      return ok({ clearances: await listClearances(ctx.tx, separationId) })
    }))

  router.get('/api/v1/separations/:id/interview',
    { summary: 'The exit interview (HR only)', tag: 'exit', permission: 'employee.write' },
    authed('employee.write', async (ctx) => ok({ interview: await getExitInterview(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  router.post('/api/v1/separations/:id/interview',
    { summary: 'Record or update the exit interview (HR only; never shown to the manager)', tag: 'exit', permission: 'employee.write',
      requestExample: { wouldRejoin: true, wouldRecommend: true, ratings: { manager: 4, growth: 2, pay: 3, culture: 4, worklife: 3 }, primaryReason: 'growth', feedback: '…' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ conductedOn?: string; wouldRejoin?: boolean; wouldRecommend?: boolean; ratings?: Record<string, number>; primaryReason?: string; feedback?: string }>(ctx.req, [])
      const r = await recordExitInterview(ctx.tx, { separationId: id, conductedByUserId: ctx.auth.userId, conductedOn: b.conductedOn ? asDate(b.conductedOn, 'conductedOn') : undefined, ...b })
      await emit(ctx.tx, { action: 'exit.interview.recorded', entityType: 'separation', entityId: id, actorUserId: ctx.auth.userId })
      return ok(r)
    }))

  router.post('/api/v1/separations/:id/relieving-letter',
    { summary: 'Issue the relieving-cum-experience letter (after the F&F is paid); idempotent', tag: 'exit', permission: 'employee.write',
      requestExample: { signatory: 'Priya Sharma, Head of HR' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ signatory?: string }>(ctx.req, [])
      const doc = await issueRelievingLetter(ctx.tx, { separationId: id, actorUserId: ctx.auth.userId, signatory: b.signatory })
      await emit(ctx.tx, { action: 'exit.letter.issued', entityType: 'separation', entityId: id, subjectEmployeeId: doc.owner_id ?? undefined, actorUserId: ctx.auth.userId, metadata: { documentId: doc.id } })
      return created(doc)
    }))
}
