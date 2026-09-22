/** Compliance calendar, score, statutory registers. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, requireModule, asUuid, asDate, asInt, emit } from './deps.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { generateObligations, calendar, markFiled, complianceScore, wageRegister, overtimeRegister, leaveRegister } from '../../payroll/compliance.ts'
import { OBLIGATIONS } from '../../../db/reference/compliance.ts'

export function register(router: Router): void {
  router.get('/api/v1/compliance/calendar', { summary: 'Statutory obligations due in a window (?from=&to=&status=), generated on the fly for what applies to this company', tag: 'compliance', permission: 'compliance.read' },
    authed('compliance.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const today = localToday(ctx.config.get<string>('attendance.timezone'))
      const from = ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : new Date(Date.parse(today) - 30 * 86_400_000).toISOString().slice(0, 10)
      const to = ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : new Date(Date.parse(today) + 90 * 86_400_000).toISOString().slice(0, 10)
      await generateObligations(ctx.tx, ctx.config, { from, to })
      return ok({ from, to, obligations: await calendar(ctx.tx, { from, to, status: ctx.req.query.get('status') ?? undefined, today }), catalogue: OBLIGATIONS.map((o) => ({ code: o.code, title: o.title, authority: o.authority, cadence: o.cadence, check: o.check ?? false })) })
    }))

  router.post('/api/v1/compliance/:id/mark', { summary: 'Mark filed (with date, reference, evidence), not applicable (with a reason), or back to pending', tag: 'compliance', permission: 'compliance.manage',
    requestExample: { status: 'filed', filedOn: '2026-10-14', referenceNo: 'TRRN 1234567890', evidenceDocumentId: '…' } },
    authed('compliance.manage', async (ctx) => {
      const b = requireBody<{ status: 'filed' | 'not_applicable' | 'pending'; filedOn?: string; referenceNo?: string; evidenceDocumentId?: string; note?: string }>(ctx.req, ['status'])
      const o = await markFiled(ctx.tx, { id: asUuid(ctx.req.params.id, 'id'), status: b.status, filedOn: b.filedOn ? asDate(b.filedOn, 'filedOn') : undefined, referenceNo: b.referenceNo, evidenceDocumentId: b.evidenceDocumentId ? asUuid(b.evidenceDocumentId, 'evidenceDocumentId') : null, note: b.note, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'compliance.marked', entityType: 'compliance_obligation', entityId: o.id, actorUserId: ctx.auth.userId, metadata: { code: o.code, period: o.period, status: o.status, referenceNo: o.reference_no } })
      return ok(o)
    }))

  router.get('/api/v1/compliance/score', { summary: 'On-time filings over due filings for a window (default: the last 12 months), with the breakdown', tag: 'compliance', permission: 'compliance.read' },
    authed('compliance.read', async (ctx) => {
      const today = localToday(ctx.config.get<string>('attendance.timezone'))
      const from = ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : new Date(Date.parse(today) - 365 * 86_400_000).toISOString().slice(0, 10)
      const to = ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10)
      await generateObligations(ctx.tx, ctx.config, { from, to })
      return ok(await complianceScore(ctx.tx, { from, to, today }))
    }))

  router.get('/api/v1/reports/registers/:kind', { summary: 'Statutory registers: wage (?month=YYYY-MM), overtime (?month=), leave (?year=); ?format=csv', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'registers are company-wide')
      const kind = ctx.req.params.kind
      const month = ctx.req.query.get('month') ?? localToday(ctx.config.get<string>('attendance.timezone')).slice(0, 7)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, 'VALIDATION_FAILED', 'month is YYYY-MM')
      const reg = kind === 'wage' ? await wageRegister(ctx.tx, month) : kind === 'overtime' ? await overtimeRegister(ctx.tx, month)
        : kind === 'leave' ? await leaveRegister(ctx.tx, ctx.req.query.get('year') ? asInt(ctx.req.query.get('year'), 'year', { min: 2000, max: 2100 }) : Number(month.slice(0, 4))) : null
      if (!reg) throw new HttpError(404, 'NOT_FOUND', 'registers: wage, overtime, leave')
      await emit(ctx.tx, { action: 'access.tier3.revealed', entityType: 'report', actorUserId: ctx.auth.userId, metadata: { report: `register:${kind}`, month } })
      if (ctx.req.query.get('format') === 'csv') return ok({ fileName: `${kind}-register-${month}.csv`, contentType: 'text/csv; charset=utf-8', rows: reg.rows.length, contentBase64: Buffer.from(reg.csv).toString('base64') })
      return ok({ columns: reg.columns, rows: reg.rows })
    }))
}
