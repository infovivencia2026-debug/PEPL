/** Anomaly guards: run the payroll guards on a run, list findings, dismiss with a reason. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, requireModule, asUuid, emit, assertOrgWide } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { runPayrollGuards, listFindings, dismissFinding } from '../../payroll/guards.ts'

export function register(router: Router): void {
  router.post('/api/v1/payroll/runs/:id/guards', { summary: 'Run the anomaly guards on a calculated run; approval refuses while a blocking finding is open', tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      return ok(await runPayrollGuards(ctx.tx, ctx.config, asUuid(ctx.req.params.id, 'id')))
    }))

  router.get('/api/v1/anomalies', { summary: 'Findings (?area=payroll|attendance&runId=&status=open); attendance findings are cut to your scope', tag: 'payroll', },
    authed(null, async (ctx) => {
      const area = ctx.req.query.get('area') ?? undefined
      if (area && !['payroll', 'attendance'].includes(area)) throw new HttpError(422, 'VALIDATION_FAILED', 'area is payroll or attendance')
      const payrollOk = ctx.auth.permissions.has('payroll.read') && ctx.auth.scope === 'all', attendanceOk = ctx.auth.permissions.has('attendance.read')
      if (area === 'payroll' && !payrollOk) throw new HttpError(403, 'PERMISSION_DENIED', 'payroll.read')
      // Payroll findings are about the company's run, not about a person, so scope
      // does not narrow them -- it has to exclude anyone who is not company-wide.
      if (area === 'payroll') assertOrgWide(ctx.auth)
      if (area === 'attendance' && !attendanceOk) throw new HttpError(403, 'PERMISSION_DENIED', 'attendance.read')
      const areas = area ? [area] : [payrollOk ? 'payroll' : null, attendanceOk ? 'attendance' : null].filter((a): a is string => Boolean(a))
      if (!areas.length) throw new HttpError(403, 'PERMISSION_DENIED', 'payroll.read or attendance.read')
      const out = []
      for (const a of areas) out.push(...await listFindings(ctx.tx, { area: a, runId: ctx.req.query.get('runId') ? asUuid(ctx.req.query.get('runId'), 'runId') : undefined, status: ctx.req.query.get('status') ?? undefined, employeeIds: a === 'attendance' ? scopeIds(ctx) : null }))
      return ok({ findings: out })
    }))

  router.post('/api/v1/anomalies/:id/dismiss', { summary: 'Dismiss a finding with a reason (audited); a blocking payroll finding needs payroll.approve', tag: 'payroll', permission: undefined, requestExample: { reason: 'Two brothers on one joint account; verified with HR' } },
    authed(null, async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const f = (await listFindings(ctx.tx, {})).find((x) => x.id === id)
      if (!f) throw new HttpError(404, 'NOT_FOUND', 'no such finding')
      const needed = f.area === 'payroll' ? (f.severity === 'blocking' ? 'payroll.approve' : 'payroll.process') : 'attendance.correct'
      if (!ctx.auth.permissions.has(needed)) throw new HttpError(403, 'PERMISSION_DENIED', needed)
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      const d = await dismissFinding(ctx.tx, { id, reason: b.reason, userId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'anomaly.dismissed', entityType: 'anomaly_finding', entityId: d.id, actorUserId: ctx.auth.userId, reason: b.reason, subjectEmployeeId: d.employee_id ?? undefined, metadata: { code: d.code, severity: d.severity, runId: d.run_id } })
      return ok(d)
    }))
}
