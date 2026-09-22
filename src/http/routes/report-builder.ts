/** Report builder: catalogue, ad-hoc run, saved reports, schedules. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, asUuid, asInt, emit } from './deps.ts'
import { catalogue, runReport, type Spec } from '../../reports/builder.ts'
import { saveReport, listReports, getReport, deleteReport, createSchedule, listSchedules, setScheduleStatus } from '../../reports/saved.ts'

export function register(router: Router): void {
  router.get('/api/v1/report-builder/catalogue', { summary: 'Read models and fields the caller may build on', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => ok({ models: catalogue(ctx.auth) })))

  router.post('/api/v1/report-builder/run', { summary: 'Run a spec (no save): rows or grouped measures, cut to your scope; ?format=csv', tag: 'reports', permission: 'report.read',
    requestExample: { model: 'attendance', groupBy: ['department', 'status'], measures: [{ field: '*', fn: 'count' }, { field: 'late_minutes', fn: 'avg' }], filters: [{ field: 'work_date', op: 'gte', value: '2026-10-01' }] } },
    authed('report.read', async (ctx) => {
      const spec = ctx.req.body as Spec
      if (!spec || typeof spec !== 'object' || !spec.model) throw new HttpError(422, 'VALIDATION_FAILED', 'a spec with a model is required')
      const r = await runReport(ctx.tx, spec, ctx.auth)
      await emit(ctx.tx, { action: 'report.generated', entityType: 'report', actorUserId: ctx.auth.userId, metadata: { model: spec.model, rows: r.total, grouped: Boolean(spec.groupBy?.length || spec.measures?.length) } })
      if (ctx.req.query.get('format') === 'csv') return ok({ fileName: `${spec.model}.csv`, contentType: 'text/csv; charset=utf-8', rows: r.total, contentBase64: Buffer.from(r.csv).toString('base64') })
      return ok(r)
    }))

  router.get('/api/v1/report-builder/saved', { summary: 'My saved reports and shared ones I may read', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => ok({ reports: await listReports(ctx.tx, ctx.auth) })))

  router.post('/api/v1/report-builder/saved', { summary: 'Save (or update with id) a report spec', tag: 'reports', permission: 'report.read',
    requestExample: { name: 'Late arrivals by department', spec: { model: 'attendance', groupBy: ['department'], measures: [{ field: 'late_minutes', fn: 'sum' }] }, shared: true } },
    authed('report.read', async (ctx) => {
      const b = requireBody<{ id?: string; name: string; description?: string; spec: Spec; shared?: boolean }>(ctx.req, ['name', 'spec'])
      return created(await saveReport(ctx.tx, ctx.auth, { id: b.id ? asUuid(b.id, 'id') : undefined, name: b.name, description: b.description, spec: b.spec, shared: b.shared }))
    }))

  router.get('/api/v1/report-builder/saved/:id', { summary: 'A saved report, run now', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      const r = await getReport(ctx.tx, ctx.auth, asUuid(ctx.req.params.id, 'id'))
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such report')
      const result = await runReport(ctx.tx, r.spec, ctx.auth)
      await emit(ctx.tx, { action: 'report.generated', entityType: 'report', entityId: r.id, actorUserId: ctx.auth.userId, metadata: { name: r.name, rows: result.total } })
      if (ctx.req.query.get('format') === 'csv') return ok({ fileName: `${r.name.replace(/[^\w.-]+/g, '_')}.csv`, contentType: 'text/csv; charset=utf-8', rows: result.total, contentBase64: Buffer.from(result.csv).toString('base64') })
      return ok({ report: r, result })
    }))

  router.del('/api/v1/report-builder/saved/:id', { summary: 'Delete a saved report of mine (its schedules go with it)', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => { await deleteReport(ctx.tx, ctx.auth, asUuid(ctx.req.params.id, 'id')); return noContent() }))

  router.get('/api/v1/report-builder/schedules', { summary: 'My schedules', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => ok({ schedules: await listSchedules(ctx.tx, ctx.auth) })))

  router.post('/api/v1/report-builder/schedules', { summary: 'Mail a saved report on a cadence; it runs with MY permissions and scope', tag: 'reports', permission: 'report.read',
    requestExample: { reportId: '…', frequency: 'weekly', dayOfWeek: 1, hour: 8, recipients: ['cfo@example.com'] } },
    authed('report.read', async (ctx) => {
      const b = requireBody<{ reportId: string; frequency: 'daily' | 'weekly' | 'monthly'; dayOfWeek?: number; dayOfMonth?: number; hour?: number; recipients: string[] }>(ctx.req, ['reportId', 'frequency', 'recipients'])
      const s = await createSchedule(ctx.tx, ctx.auth, { reportId: asUuid(b.reportId, 'reportId'), frequency: b.frequency, dayOfWeek: b.dayOfWeek === undefined ? undefined : asInt(b.dayOfWeek, 'dayOfWeek', { min: 0, max: 6 }), dayOfMonth: b.dayOfMonth === undefined ? undefined : asInt(b.dayOfMonth, 'dayOfMonth', { min: 1, max: 28 }), hour: b.hour === undefined ? undefined : asInt(b.hour, 'hour', { min: 0, max: 23 }), recipients: Array.isArray(b.recipients) ? b.recipients : [] })
      await emit(ctx.tx, { action: 'report.scheduled', entityType: 'report_schedule', entityId: s.id, actorUserId: ctx.auth.userId, metadata: { report: s.report_name, frequency: s.frequency, recipients: s.recipients.length } })
      return created(s)
    }))

  router.post('/api/v1/report-builder/schedules/:id/:action', { summary: 'pause | resume | delete a schedule of mine', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      const action = ctx.req.params.action
      const status = action === 'pause' ? 'paused' : action === 'resume' ? 'active' : action === 'delete' ? 'deleted' : null
      if (!status) throw new HttpError(404, 'NOT_FOUND', 'actions: pause, resume, delete')
      await setScheduleStatus(ctx.tx, ctx.auth, asUuid(ctx.req.params.id, 'id'), status); return noContent()
    }))
}
