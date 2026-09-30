/** Projects, allocations, weekly timesheets, the hours report, and the daily work log. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asDate, asUuid, asInt, assertScope, can, emit } from './deps.ts'
import {
  listProjects, upsertProject, listAllocations, allocate, endAllocation,
  getWeek, getTimesheet, listTimesheets, setHours, submitWeek, hoursReport, weekStartOf,
  writeWorkLog, listWorkLogs, profitabilityReport,
} from '../../work/timesheets.ts'
import { scopeIds } from '../ui-data.ts'
import type { ChainCode } from '../../approvals/index.ts'
import { csvCell } from '../../lib/csv.ts'

export function register(router: Router): void {
  router.get('/api/v1/projects/profitability', { summary: 'Per project: approved hours, billable revenue, cost of hours at CTC/173, margin (?from=&to=&projectId=)', tag: 'timesheets', permission: 'project.write' },
    authed('project.write', async (ctx) => {
      const from = asDate(ctx.req.query.get('from'), 'from'), to = asDate(ctx.req.query.get('to'), 'to')
      return ok({ from, to, projects: await profitabilityReport(ctx.tx, { from, to, projectId: ctx.req.query.get('projectId') ? asUuid(ctx.req.query.get('projectId'), 'projectId') : undefined }) })
    }))

  router.get('/api/v1/projects',
    { summary: 'Projects (?mine=true for the ones you are allocated to; ?includeClosed=true)', tag: 'projects', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const mine = ctx.req.query.get('mine') === 'true'
      return ok({ projects: await listProjects(ctx.tx, { includeClosed: ctx.req.query.get('includeClosed') === 'true', employeeId: mine ? ctx.auth.employeeId ?? undefined : undefined }) })
    }))

  router.post('/api/v1/projects',
    { summary: 'Create or update a project by code', tag: 'projects', permission: 'project.write',
      requestExample: { code: 'ACME-ERP', name: 'Acme ERP rollout', client: 'Acme', kind: 'client', billable: true, billRatePaisePerHour: 250000, budgetHours: 1200 } },
    authed('project.write', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const b = requireBody<Parameters<typeof upsertProject>[1]>(ctx.req, ['code', 'name'])
      const p = await upsertProject(ctx.tx, { ...b, ownerEmployeeId: b.ownerEmployeeId ? asUuid(b.ownerEmployeeId, 'ownerEmployeeId') : null })
      await emit(ctx.tx, { action: 'project.changed', entityType: 'project', entityId: p.id, actorUserId: ctx.auth.userId, after: { code: p.code, status: p.status } })
      return created(p)
    }))

  router.get('/api/v1/projects/:id/allocations',
    { summary: 'Who is allocated to a project', tag: 'projects', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => ok({ allocations: await listAllocations(ctx.tx, { projectId: asUuid(ctx.req.params.id, 'id') }) })))

  router.post('/api/v1/projects/:id/allocations',
    { summary: 'Allocate a person (role, %, dates); a person never exceeds 100% on a day', tag: 'projects', permission: 'project.write',
      requestExample: { employeeId: '…', role: 'Developer', percent: 50, startsOn: '2026-10-01' } },
    authed('project.write', async (ctx) => {
      const b = requireBody<{ employeeId: string; role?: string; percent?: number; startsOn?: string; endsOn?: string | null }>(ctx.req, ['employeeId'])
      const a = await allocate(ctx.tx, { projectId: asUuid(ctx.req.params.id, 'id'), employeeId: asUuid(b.employeeId, 'employeeId'), role: b.role, percent: b.percent,
        startsOn: b.startsOn ? asDate(b.startsOn, 'startsOn') : undefined, endsOn: b.endsOn ? asDate(b.endsOn, 'endsOn') : null })
      await emit(ctx.tx, { action: 'project.allocated', entityType: 'project', entityId: ctx.req.params.id, subjectEmployeeId: a.employee_id, actorUserId: ctx.auth.userId, after: { percent: a.percent, role: a.role } })
      return created(a)
    }))

  router.post('/api/v1/allocations/:id/end',
    { summary: 'End an allocation on a date', tag: 'projects', permission: 'project.write', requestExample: { endsOn: '2026-12-31' } },
    authed('project.write', async (ctx) => {
      const b = requireBody<{ endsOn: string }>(ctx.req, ['endsOn'])
      await endAllocation(ctx.tx, asUuid(ctx.req.params.id, 'id'), asDate(b.endsOn, 'endsOn'))
      return noContent()
    }))

  router.get('/api/v1/employees/:id/allocations',
    { summary: 'A person\'s project allocations', tag: 'projects', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      return ok({ allocations: await listAllocations(ctx.tx, { employeeId: id }) })
    }))

  // ── timesheets ──
  router.get('/api/v1/timesheets/week',
    { summary: 'Your (or a report\'s) timesheet for the week containing ?date= (created open if new)', tag: 'timesheets', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok(await getWeek(ctx.tx, employeeId, asDate(ctx.req.query.get('date') ?? new Date().toISOString().slice(0, 10), 'date')))
    }))

  router.get('/api/v1/timesheets',
    { summary: 'Timesheets you may see, newest week first', tag: 'timesheets', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok({ timesheets: await listTimesheets(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, status: ctx.req.query.get('status') ?? undefined,
        limit: asInt(ctx.req.query.get('limit') ?? 26, 'limit', { min: 1, max: 200 }) }) })
    }))

  router.post('/api/v1/timesheets/entries',
    { summary: 'Set hours for a project on a day (0 clears). Own sheet, or a report\'s with timesheet.write', tag: 'timesheets', permission: 'timesheet.read',
      requestExample: { projectId: '…', workDate: '2026-10-06', hours: 6.5, note: 'API integration' } },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const b = requireBody<{ employeeId?: string; projectId: string; workDate: string; hours: number; billable?: boolean; note?: string }>(ctx.req, ['projectId', 'workDate', 'hours'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'timesheet.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'editing another person\'s sheet needs timesheet.write')
      assertScope(ctx.auth, employeeId)
      return ok(await setHours(ctx.tx, { employeeId, projectId: asUuid(b.projectId, 'projectId'), workDate: asDate(b.workDate, 'workDate'), hours: Number(b.hours), billable: b.billable, note: b.note }))
    }))

  router.post('/api/v1/timesheets/submit',
    { summary: 'Submit the week containing weekStart for approval', tag: 'timesheets', permission: 'timesheet.read', requestExample: { weekStart: '2026-10-05' } },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const b = requireBody<{ employeeId?: string; weekStart: string }>(ctx.req, ['weekStart'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'timesheet.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'submitting another person\'s sheet needs timesheet.write')
      assertScope(ctx.auth, employeeId)
      const sheet = await submitWeek(ctx.tx, { employeeId, weekStart: weekStartOf(asDate(b.weekStart, 'weekStart')), requestedByUserId: ctx.auth.userId,
        fallbackChain: ctx.config.get<string>('timesheets.approval_chain') as ChainCode })
      await emit(ctx.tx, { action: 'timesheet.submitted', entityType: 'timesheet', entityId: sheet.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { weekStart: sheet.week_start, hours: sheet.total_hours } })
      return ok(sheet)
    }))

  router.get('/api/v1/timesheets/:id',
    { summary: 'One timesheet with its entries', tag: 'timesheets', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      const t = await getTimesheet(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!t) throw new HttpError(404, 'NOT_FOUND', 'no such timesheet')
      assertScope(ctx.auth, t.employee_id)
      return ok(t)
    }))

  router.get('/api/v1/reports/hours',
    { summary: 'Approved hours by project and person for a date range (CSV via ?format=csv)', tag: 'reports', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const from = asDate(ctx.req.query.get('from') ?? '', 'from'), to = asDate(ctx.req.query.get('to') ?? '', 'to')
      const pid = ctx.req.query.get('projectId')
      const rows = await hoursReport(ctx.tx, { from, to, projectId: pid ? asUuid(pid, 'projectId') : undefined, employeeIds: scopeIds(ctx) })
      if (ctx.req.query.get('format') === 'csv') {
        const head = 'project_code,project_name,client,employee_number,employee_name,hours,billable_hours,billable_rupees'
        const csv = [head, ...rows.map((r) => [r.project_code, r.project_name, r.client ?? '', r.employee_number, r.employee_name, r.hours, r.billable_hours ?? '0', (Number(r.billable_paise) / 100).toFixed(2)]
          .map(csvCell).join(','))].join('\n')
        return ok({ csv, rows })
      }
      return ok({ rows })
    }))

  // ── work log ──
  router.get('/api/v1/work-logs',
    { summary: 'Daily work logs you may see, ?from=&to=&employeeId=', tag: 'timesheets', permission: 'timesheet.read' },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      const to = ctx.req.query.get('to') ?? new Date().toISOString().slice(0, 10)
      const from = ctx.req.query.get('from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      return ok({ logs: await listWorkLogs(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, from: asDate(from, 'from'), to: asDate(to, 'to') }) })
    }))

  router.post('/api/v1/work-logs',
    { summary: 'Write (or rewrite) your work log for a day: done, blockers, next', tag: 'timesheets', permission: 'timesheet.read',
      requestExample: { workDate: '2026-10-06', done: 'Finished the export job', blockers: 'Waiting on client sandbox', nextPlan: 'Load test' } },
    authed('timesheet.read', async (ctx) => {
      requireModule(ctx, 'timesheets.enabled')
      const b = requireBody<{ workDate: string; projectId?: string | null; done: string; blockers?: string; nextPlan?: string }>(ctx.req, ['workDate', 'done'])
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      return created(await writeWorkLog(ctx.tx, { employeeId: ctx.auth.employeeId, workDate: asDate(b.workDate, 'workDate'), projectId: b.projectId ? asUuid(b.projectId, 'projectId') : null, done: b.done, blockers: b.blockers, nextPlan: b.nextPlan }))
    }))
}
