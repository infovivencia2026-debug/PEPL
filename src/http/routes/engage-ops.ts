/** Work reports, branding, WhatsApp channel. */
import type { Router } from '../router.ts'
import { HttpError, authed, open, ok, created, noContent, requireBody, asUuid, asDate, assertScope, can, emit, type Req } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { listTemplates, upsertTemplate, retireTemplate, submitReport, reviewReport, listReports, missingDaily, type Field } from '../../work/reports.ts'
import { getBranding, setBranding, brandingForHost } from '../../control-plane/branding.ts'
import { getProvider, setProvider, disableProvider, optIn, optOut, status as waStatus, WHATSAPP_EVENTS } from '../../comms/whatsapp.ts'

export function register(router: Router): void {
  // ── work reports ──
  router.get('/api/v1/work-reports/templates', { summary: 'Report templates (seeded for the organisation type on first call; ?includeRetired=true)', tag: 'work', permission: 'task.read' },
    authed('task.read', async (ctx) => ok({ templates: await listTemplates(ctx.tx, ctx.req.query.get('includeRetired') === 'true') })))
  router.post('/api/v1/work-reports/templates', { summary: 'Create or replace a template: typed fields (text|number|date|choice|photo|geo|boolean), frequency, who it applies to', tag: 'work', permission: 'task.write',
    requestExample: { code: 'DPR', name: 'Daily progress report', frequency: 'daily', fields: [{ key: 'manpower', label: 'Manpower', type: 'number', required: true }] } },
    authed('task.write', async (ctx) => {
      const b = requireBody<{ code: string; name: string; frequency?: 'daily' | 'per_visit' | 'weekly' | 'ad_hoc'; fields: Field[]; appliesTo?: { departments?: string[]; designations?: string[] } }>(ctx.req, ['code', 'name', 'fields'])
      const t = await upsertTemplate(ctx.tx, b)
      await emit(ctx.tx, { action: 'work.report_template.changed', entityType: 'report_template', entityId: t.id, actorUserId: ctx.auth.userId, metadata: { code: t.code } })
      return created(t)
    }))
  router.post('/api/v1/work-reports/templates/:code/retire', { summary: 'Retire a template', tag: 'work', permission: 'task.write' },
    authed('task.write', async (ctx) => { await retireTemplate(ctx.tx, ctx.req.params.code!); return noContent() }))
  router.get('/api/v1/work-reports', { summary: 'Reports in scope (?template=&employeeId=&from=&to=&status=&projectId=)', tag: 'work', permission: 'task.read' },
    authed('task.read', async (ctx) => {
      const q = ctx.req.query
      const employeeId = q.get('employeeId') ? asUuid(q.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ reports: await listReports(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, templateCode: q.get('template') ?? undefined, from: q.get('from') ?? undefined, to: q.get('to') ?? undefined, status: q.get('status') ?? undefined, projectId: q.get('projectId') ? asUuid(q.get('projectId'), 'projectId') : undefined }) })
    }))
  router.post('/api/v1/work-reports', { summary: 'File a report against a template (validated field by field)', tag: 'work', permission: 'task.read',
    requestExample: { template: 'DPR', reportDate: '2026-10-06', values: { site: 'Block B', manpower: 42, work_done: 'Slab casting L3', incidents: false }, geo: { lat: 17.4, lng: 78.3 } } },
    authed('task.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ template: string; reportDate?: string; values: Record<string, unknown>; projectId?: string; geo?: { lat: number; lng: number }; photoDocumentIds?: string[] }>(ctx.req, ['template', 'values'])
      const r = await submitReport(ctx.tx, { templateCode: b.template, employeeId: ctx.auth.employeeId, reportDate: b.reportDate ? asDate(b.reportDate, 'reportDate') : localToday(ctx.config.get<string>('attendance.timezone')), values: b.values, projectId: b.projectId ? asUuid(b.projectId, 'projectId') : null, geo: b.geo, photoDocumentIds: b.photoDocumentIds?.map((d) => asUuid(d, 'photoDocumentIds')) })
      return created(r)
    }))
  router.post('/api/v1/work-reports/:id/review', { summary: 'Manager marks a report reviewed or returns it with a note', tag: 'work', permission: 'task.write', requestExample: { status: 'returned', note: 'Manpower count missing the contractor team' } },
    authed('task.write', async (ctx) => {
      const b = requireBody<{ status: 'reviewed' | 'returned'; note?: string }>(ctx.req, ['status'])
      if (!['reviewed', 'returned'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is reviewed or returned')
      const r = await reviewReport(ctx.tx, { reportId: asUuid(ctx.req.params.id, 'id'), status: b.status, note: b.note, actorUserId: ctx.auth.userId })
      assertScope(ctx.auth, r.employee_id)
      return ok(r)
    }))
  router.get('/api/v1/work-reports/missing', { summary: 'Who punched in today but has not filed the daily report (?template=&date=)', tag: 'work', permission: 'task.write' },
    authed('task.write', async (ctx) => {
      const template = ctx.req.query.get('template'); if (!template) throw new HttpError(422, 'VALIDATION_FAILED', 'template is required')
      const date = ctx.req.query.get('date') ? asDate(ctx.req.query.get('date'), 'date') : localToday(ctx.config.get<string>('attendance.timezone'))
      return ok({ date, missing: await missingDaily(ctx.tx, { templateCode: template, date, employeeIds: scopeIds(ctx) }) })
    }))

  // ── branding ──
  router.get('/api/v1/branding', { summary: 'Public: branding for the host the browser came from (custom domain), else nothing', tag: 'config', public: true },
    open(async (req: Req) => ok({ branding: await brandingForHost(String(req.headers['x-forwarded-host'] ?? req.headers.host ?? '')) })))
  router.get('/api/v1/settings/branding', { summary: 'This company\'s branding', tag: 'config', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok(await getBranding(ctx.tx))))
  router.patch('/api/v1/settings/branding', { summary: 'Set product name, colours, logo, payslip header/footer, email footer, custom domain', tag: 'config', permission: 'settings.write',
    requestExample: { productName: 'Acme People', primaryColor: '#1f6b4d', accentColor: '#e39a5c', emailFooter: 'Acme Technologies Pvt Ltd · HR', customDomain: 'people.acme.in' } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<Parameters<typeof setBranding>[1]>(ctx.req, [])
      if (b.customDomain && !ctx.config.isEnabled('branding.enabled')) throw new HttpError(403, 'MODULE_DISABLED', 'custom domains are on the Enterprise plan')
      const r = await setBranding(ctx.tx, { ...b, logoDocumentId: b.logoDocumentId ? asUuid(b.logoDocumentId, 'logoDocumentId') : b.logoDocumentId })
      await emit(ctx.tx, { action: 'config.branding.changed', entityType: 'tenant', actorUserId: ctx.auth.userId, metadata: { fields: Object.keys(b) } })
      return ok(r)
    }))

  // ── WhatsApp ──
  router.get('/api/v1/me/whatsapp', { summary: 'My WhatsApp opt-in and whether the company sends on it', tag: 'notifications' },
    authed(null, async (ctx) => ok(await waStatus(ctx.tx, ctx.auth.userId))))
  router.post('/api/v1/me/whatsapp', { summary: 'Opt in with a number (+91…); approvals, payslips, reminders then come on WhatsApp', tag: 'notifications', requestExample: { phone: '+919876543210' } },
    authed(null, async (ctx) => { await optIn(ctx.tx, { userId: ctx.auth.userId, phone: requireBody<{ phone: string }>(ctx.req, ['phone']).phone }); return ok(await waStatus(ctx.tx, ctx.auth.userId)) }))
  router.post('/api/v1/me/whatsapp/opt-out', { summary: 'Stop WhatsApp messages', tag: 'notifications' },
    authed(null, async (ctx) => { await optOut(ctx.tx, ctx.auth.userId); return noContent() }))
  router.get('/api/v1/settings/whatsapp', { summary: 'Company WhatsApp provider (secret never returned) and the events that go out', tag: 'config', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok({ provider: await getProvider(ctx.tx), events: [...WHATSAPP_EVENTS] })))
  router.post('/api/v1/settings/whatsapp', { summary: 'Configure the provider: Meta Cloud API (endpoint + token + approved template names) or a generic webhook', tag: 'config', permission: 'settings.write',
    requestExample: { provider: 'meta_cloud', endpoint: 'https://graph.facebook.com/v19.0/1234567890/messages', secret: 'EAAG…', templates: { 'approval.requested': 'pepl_approval', 'payslip.published': 'pepl_payslip' } } },
    authed('settings.write', async (ctx) => {
      if (!ctx.config.isEnabled('notifications.whatsapp_enabled')) throw new HttpError(403, 'MODULE_DISABLED', 'turn on notifications.whatsapp_enabled first')
      const b = requireBody<{ provider: 'meta_cloud' | 'generic_webhook'; endpoint: string; fromNumber?: string; secret?: string; templates?: Record<string, string> }>(ctx.req, ['provider', 'endpoint'])
      const p = await setProvider(ctx.tx, { ...b, master: process.env.PEPL_MAIL_KEY })
      await emit(ctx.tx, { action: 'config.whatsapp.changed', entityType: 'tenant', actorUserId: ctx.auth.userId, metadata: { provider: p.provider } })
      return ok(p)
    }))
  router.post('/api/v1/settings/whatsapp/disable', { summary: 'Stop sending on WhatsApp company-wide', tag: 'config', permission: 'settings.write' },
    authed('settings.write', async (ctx) => { await disableProvider(ctx.tx); return noContent() }))
  void can
}
