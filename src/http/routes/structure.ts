/** Org chart, positions, transfers, profile change requests. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, asUuid, asDate, asInt, assertScope, can, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { orgChart, reportingLine, upsertPosition, listPositions, setPositionStatus, seatEmployee, headcountByPosition, requestTransfer, listTransfers, requestProfileChange, decideProfileChange, listProfileChanges, REQUESTABLE } from '../../people/structure.ts'
import type { EmployeePatch } from '../../people/profile.ts'

export function register(router: Router): void {
  router.get('/api/v1/org/chart', { summary: 'Org chart from reporting lines (?root=employeeId&depth=); people with no manager are roots', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const root = ctx.req.query.get('root') ? asUuid(ctx.req.query.get('root'), 'root') : null
      const depth = ctx.req.query.get('depth') ? asInt(ctx.req.query.get('depth'), 'depth', { min: 1, max: 12 }) : undefined
      return ok(await orgChart(ctx.tx, { rootEmployeeId: root, depth }))
    }))
  router.get('/api/v1/employees/:id/reporting-line', { summary: 'Manager chain up to the top', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => ok({ line: await reportingLine(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  // ── positions ──
  router.get('/api/v1/positions', { summary: 'Positions with seats and filled count (?status=&department=&vacant=true)', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => ok({ positions: await listPositions(ctx.tx, { status: ctx.req.query.get('status') ?? undefined, department: ctx.req.query.get('department') ?? undefined, vacantOnly: ctx.req.query.get('vacant') === 'true' }) })))
  router.get('/api/v1/positions/headcount', { summary: 'Seats vs filled, by department', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => ok(await headcountByPosition(ctx.tx))))
  router.post('/api/v1/positions', { summary: 'Create or replace a position by code', tag: 'people', permission: 'settings.write',
    requestExample: { code: 'ENG-SR-DEV', title: 'Senior Developer', department: 'Engineering', designation: 'Senior Developer', locationCode: 'HYD', seats: 3 } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ code: string; title: string; department: string; designation: string; locationCode?: string; gradeCode?: string; reportsToPositionId?: string; seats?: number }>(ctx.req, ['code', 'title', 'department', 'designation'])
      const p = await upsertPosition(ctx.tx, { ...b, reportsToPositionId: b.reportsToPositionId ? asUuid(b.reportsToPositionId, 'reportsToPositionId') : null, seats: b.seats === undefined ? undefined : asInt(b.seats, 'seats', { min: 0, max: 10000 }) })
      await emit(ctx.tx, { action: 'org.position.changed', entityType: 'position', entityId: p.id, actorUserId: ctx.auth.userId, metadata: { code: p.code, seats: p.seats } })
      return created(p)
    }))
  router.post('/api/v1/positions/:id/status', { summary: 'active | frozen | closed (closed needs no holder)', tag: 'people', permission: 'settings.write', requestExample: { status: 'frozen' } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ status: 'active' | 'frozen' | 'closed' }>(ctx.req, ['status'])
      if (!['active', 'frozen', 'closed'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is active, frozen or closed')
      return ok(await setPositionStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status))
    }))
  router.post('/api/v1/employees/:id/position', { summary: 'Seat a person in a position (null clears)', tag: 'people', permission: 'employee.write', requestExample: { positionId: '…' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id'); assertScope(ctx.auth, id)
      const b = requireBody<{ positionId: string | null }>(ctx.req, [])
      await seatEmployee(ctx.tx, { employeeId: id, positionId: b.positionId ? asUuid(b.positionId, 'positionId') : null })
      return ok({ seated: Boolean(b.positionId) })
    }))

  // ── transfers ──
  router.get('/api/v1/transfers', { summary: 'Transfer requests in scope (?employeeId=&status=)', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ transfers: await listTransfers(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, status: ctx.req.query.get('status') ?? undefined }) })
    }))
  router.post('/api/v1/transfers', { summary: 'Request a transfer (department / designation / location / manager / position) from a date; approved through the engine and applied on the date', tag: 'people', permission: 'employee.write',
    requestExample: { employeeId: '…', effectiveFrom: '2026-11-01', department: 'Sales', locationCode: 'BLR', managerEmployeeId: '…', reason: 'Business need' } },
    authed('employee.write', async (ctx) => {
      const b = requireBody<{ employeeId: string; effectiveFrom: string; department?: string; designation?: string; locationCode?: string; managerEmployeeId?: string; positionId?: string; reason: string }>(ctx.req, ['employeeId', 'effectiveFrom', 'reason'])
      const employeeId = asUuid(b.employeeId, 'employeeId'); assertScope(ctx.auth, employeeId)
      const t = await requestTransfer(ctx.tx, ctx.config, { employeeId, effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'), department: b.department, designation: b.designation, locationCode: b.locationCode,
        managerEmployeeId: b.managerEmployeeId ? asUuid(b.managerEmployeeId, 'managerEmployeeId') : null, positionId: b.positionId ? asUuid(b.positionId, 'positionId') : null, reason: b.reason, requestedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'people.transfer.requested', entityType: 'transfer', entityId: t.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { effectiveFrom: t.effective_from, status: t.status } })
      return created(t)
    }))

  // ── profile change requests ──
  router.get('/api/v1/profile-changes', { summary: 'Profile change requests (?status=pending); ?mine=true for your own', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const mine = ctx.req.query.get('mine') === 'true'
      return ok({ requests: await listProfileChanges(ctx.tx, { employeeIds: mine ? null : scopeIds(ctx), employeeId: mine ? ctx.auth.employeeId ?? undefined : undefined, status: ctx.req.query.get('status') ?? undefined }), requestable: REQUESTABLE })
    }))
  router.post('/api/v1/profile-changes', { summary: 'Propose a change to your own record for HR to approve (name, DOB, gender, contact, address); attach evidence', tag: 'people', permission: 'employee.read',
    requestExample: { changes: { lastName: 'Sharma-Rao', dateOfBirth: '1991-03-04' }, evidenceDocumentId: '…', note: 'Marriage certificate attached' } },
    authed('employee.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ changes: Partial<EmployeePatch>; evidenceDocumentId?: string; note?: string }>(ctx.req, ['changes'])
      return created(await requestProfileChange(ctx.tx, { employeeId: ctx.auth.employeeId, changes: b.changes, evidenceDocumentId: b.evidenceDocumentId ? asUuid(b.evidenceDocumentId, 'evidenceDocumentId') : null, note: b.note }))
    }))
  router.post('/api/v1/profile-changes/:id/decide', { summary: 'HR approves (the record changes) or rejects with a note', tag: 'people', permission: 'employee.write', requestExample: { approve: true } },
    authed('employee.write', async (ctx) => {
      if (!can(ctx.auth, 'employee.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'HR decides profile changes')
      const b = requireBody<{ approve: boolean; note?: string }>(ctx.req, ['approve'])
      const r = await decideProfileChange(ctx.tx, { requestId: asUuid(ctx.req.params.id, 'id'), approve: b.approve === true, actorUserId: ctx.auth.userId, note: b.note })
      await emit(ctx.tx, { action: 'people.profile_change.decided', entityType: 'profile_change_request', entityId: r.id, subjectEmployeeId: r.employee_id, actorUserId: ctx.auth.userId, metadata: { status: r.status, fields: Object.keys(r.changes) } })
      return ok(r)
    }))
}
