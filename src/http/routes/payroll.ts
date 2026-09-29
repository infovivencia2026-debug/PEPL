/** Payroll. */
import type { Router } from '../router.ts'
import { payslipPdf } from '../../payroll/payslip-pdf.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  requireModule,
  asUuid,
  asInt,
  assertScope,
  approve,
  calculate,
  createRun,
  delta,
  freezeInputs,
  getRun,
  lock,
  revise,
  unfreezeInputs,
  validate,
  emit,
  loadStatutory,
  ptFor,
  computeTds, requireRecentMfa,
} from './deps.ts'
import { componentFlags } from '../../payroll/structures.ts'
import { distributeRun } from '../../payroll/distribute.ts'
import { runPayrollGuards } from '../../payroll/guards.ts'
import { ensurePeriod, listPayrollPeriods, updatePayDate, deletePeriod } from '../../payroll/periods.ts'

/**
 * Binds the run's snapshotted slab data to the engine's TDS hook. Returns
 * undefined when no slabs are configured, so payroll runs without a tax line
 * rather than silently deducting a wrong figure.
 */
function tdsFor(statutory: Awaited<ReturnType<typeof loadStatutory>>) {
  return (args: {
    monthlyTaxableGrossPaise: bigint; regime: 'old' | 'new'; declaredDeductionsPaise: bigint
    earnedToDatePaise: bigint; deductedToDatePaise: bigint; monthsRemaining: number
  }) => {
    const rules = statutory.taxRules[args.regime]
    const slabs = statutory.taxSlabs[args.regime]
    if (!rules || slabs.length === 0) {
      return { monthlyTdsPaise: 0n, trace: { reason: 'no tax slabs configured' } }
    }
    const r = computeTds(
      {
        monthlyTaxableGrossPaise: args.monthlyTaxableGrossPaise,
        // All three are frozen VALUES on the run; the wall clock has no say.
        monthsRemaining: args.monthsRemaining,
        earnedToDatePaise: args.earnedToDatePaise,
        deductedToDatePaise: args.deductedToDatePaise,
        regime: args.regime,
        declaredDeductionsPaise: args.declaredDeductionsPaise,
      },
      slabs,
      rules,
    )
    return { monthlyTdsPaise: r.monthlyTdsPaise, trace: r.trace }
  }
}

export function register(router: Router): void {
  router.get('/api/v1/payroll/periods',
    { summary: 'Payroll periods, newest first, with the run in each', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      return ok({ periods: await listPayrollPeriods(ctx.tx) })
    }))

  router.post('/api/v1/payroll/periods',
    { summary: 'Create the payroll and attendance period for a month (idempotent)', tag: 'payroll',
      permission: 'payroll.process', requestExample: { month: '2026-10', payDate: '2026-11-01' } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ month: string; payDate?: string }>(ctx.req, ['month'])
      const result = await ensurePeriod(ctx.tx, {
        month: b.month, payDay: ctx.config.get<number>('payroll.pay_day'), payDate: b.payDate,
      })
      if (result.created) {
        await emit(ctx.tx, { action: 'payroll.period.created', entityType: 'payroll_period', entityId: result.payroll.id,
          actorUserId: ctx.auth.userId, after: { label: result.payroll.label, payDate: result.payroll.pay_date } })
      }
      return (result.created ? created : ok)(result)
    }))

  router.patch('/api/v1/payroll/periods/:id',
    { summary: 'Move a period\'s pay date (not possible once its run is locked)', tag: 'payroll',
      permission: 'payroll.process', requestExample: { payDate: '2026-11-03' } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ payDate: string }>(ctx.req, ['payDate'])
      const period = await updatePayDate(ctx.tx, id, b.payDate)
      await emit(ctx.tx, { action: 'payroll.period.changed', entityType: 'payroll_period', entityId: id,
        actorUserId: ctx.auth.userId, after: { payDate: b.payDate } })
      return ok(period)
    }))

  router.del('/api/v1/payroll/periods/:id',
    { summary: 'Delete a period that has no run (reason required)', tag: 'payroll',
      permission: 'payroll.process', requestExample: { reason: 'created for the wrong month' } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      await deletePeriod(ctx.tx, id)
      await emit(ctx.tx, { action: 'payroll.period.deleted', entityType: 'payroll_period', entityId: id,
        actorUserId: ctx.auth.userId, reason: b.reason })
      return ok({ deleted: true })
    }))

  router.post('/api/v1/payroll/runs',
    { summary: 'Start a payroll run for a period', tag: 'payroll', permission: 'payroll.process',
      requestExample: { periodId: '…' } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ periodId: string }>(ctx.req, ['periodId'])
      const id = await createRun(ctx.tx, {
        periodId: asUuid(b.periodId, 'periodId'), processedByUserId: ctx.auth.userId,
      })
      return created({ id })
    }))

  router.post('/api/v1/payroll/runs/:id/freeze',
    { summary: 'Freeze inputs — the boundary after which payroll reads only itself',
      tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      const b = requireBody<{ rows: unknown[] }>(ctx.req, ['rows'])
      const statutory = await loadStatutory(ctx.tx)
      const divisor = ctx.config.get<number>('payroll.exit_day_divisor')
      const n = await freezeInputs(
        ctx.tx, asUuid(ctx.req.params.id, 'id'), b.rows as never,
        { lop_basis: ctx.config.get('payroll.lop_basis'),
          pf_on_full_wage: ctx.config.get('payroll.pf_on_full_wage'),
          exit_day_divisor: divisor },
        statutory.id,
        { settlement: { encashmentDivisor: divisor, noticeDivisor: divisor } })
      return ok({ frozen: n })
    }))

  router.post('/api/v1/payroll/runs/:id/unfreeze',
    { summary: 'Unfreeze — available only before calculation, and audited', tag: 'payroll',
      permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      await unfreezeInputs(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      return ok({ unfrozen: true })
    }))

  router.post('/api/v1/payroll/runs/:id/calculate',
    { summary: 'Calculate the run', tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      const statutory = await loadStatutory(ctx.tx)
      const totals = await calculate(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
        statutory: statutory.config,
        components: (await componentFlags(ctx.tx)) ?? undefined,
        ptAmountPaise: (state, gross, gender) => ptFor(statutory.ptSlabs, state, gross, undefined, gender, statutory.ptExemptions),
        lwfRates: statutory.lwfRates,
        pfOnFullWage: ctx.config.get<boolean>('payroll.pf_on_full_wage'),
        lopBasis: ctx.config.get<'calendar_days' | 'fixed_30' | 'working_days'>('payroll.lop_basis'),
        computeTds: tdsFor(statutory),
      })
      return ok({
        grossPaise: String(totals.gross),
        deductionsPaise: String(totals.deductions),
        netPaise: String(totals.net),
      })
    }))

  router.get('/api/v1/payroll/runs/:id/validation',
    { summary: 'Blockers and warnings for a calculated run', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const runId = asUuid(ctx.req.params.id, 'id')
      // Tables for the PERIOD's fiscal year, not today's: a March run validated in April is FY-1.
      const period = await ctx.tx.query<{ period_start: string }>(
        `SELECT pp.period_start::text FROM payroll_runs r JOIN payroll_periods pp ON pp.id = r.period_id WHERE r.id = $1`, [runId])
      const statutory = await loadStatutory(ctx.tx, period.rows[0]?.period_start)
      const result = await validate(ctx.tx, runId, {
        statutory: statutory.config,
        taxTables: { fiscalYear: statutory.fiscalYear, regimes: {
          new: statutory.taxSlabs.new.length > 0 && !!statutory.taxRules.new,
          old: statutory.taxSlabs.old.length > 0 && !!statutory.taxRules.old,
        } },
        components: (await componentFlags(ctx.tx)) ?? undefined,
        ptAmountPaise: (state, gross, gender) => ptFor(statutory.ptSlabs, state, gross, undefined, gender, statutory.ptExemptions),
        pfOnFullWage: ctx.config.get<boolean>('payroll.pf_on_full_wage'),
        lopBasis: ctx.config.get<'calendar_days' | 'fixed_30' | 'working_days'>('payroll.lop_basis'),
        computeTds: tdsFor(statutory),
        variancePct: ctx.config.get<number>('payroll.variance_warning_pct'),
      })
      return ok(result)
    }))

  router.post('/api/v1/payroll/runs/:id/approve',
    { summary: 'Approve a validated run (never the person who ran it)', tag: 'payroll',
      permission: 'payroll.approve' },
    authed('payroll.approve', async (ctx) => {
      // The guards run here so an approver always sees the current findings; approve() refuses open blockers.
      const guard = await runPayrollGuards(ctx.tx, ctx.config, asUuid(ctx.req.params.id, 'id'))
      if (guard.blocking > 0) throw new HttpError(409, 'ANOMALIES_OPEN', `${guard.blocking} blocking finding(s) open on this run; see GET /anomalies?runId=`)
      await approve(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, {
        requireSeparateApprover: ctx.config.get<boolean>('payroll.require_separate_approver'),
      })
      return ok({ approved: true })
    }))

  router.post('/api/v1/payroll/runs/:id/lock',
    { summary: 'Lock the run. Irreversible; corrections become revisions', tag: 'payroll',
      permission: 'payroll.lock' },
    authed('payroll.lock', async (ctx) => {
      await requireRecentMfa(ctx)
      const id = asUuid(ctx.req.params.id, 'id')
      await lock(ctx.tx, id, ctx.auth.userId, {
        requireSeparateApprover: ctx.config.get<boolean>('payroll.require_separate_approver'),
      })
      await emit(ctx.tx, {
        action: 'payroll.run.locked', entityType: 'payroll_run', entityId: id,
        actorUserId: ctx.auth.userId,
      })
      return ok({ locked: true })
    }))

  router.post('/api/v1/payroll/runs/:id/revise',
    { summary: 'Create the next revision of a locked run', tag: 'payroll', permission: 'payroll.revise',
      requestExample: { reason: 'regularization approved late for 3 employees' } },
    authed('payroll.revise', async (ctx) => {
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      const id = asUuid(ctx.req.params.id, 'id')
      const newId = await revise(ctx.tx, id, { reason: b.reason, processedByUserId: ctx.auth.userId })
      await emit(ctx.tx, {
        action: 'payroll.run.revised', entityType: 'payroll_run', entityId: newId,
        actorUserId: ctx.auth.userId, reason: b.reason, metadata: { supersedes: id },
      })
      return created({ id: newId })
    }))

  router.get('/api/v1/payroll/runs/:id',
    { summary: 'Run status and totals', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => ok({ run: await getRun(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  router.get('/api/v1/payroll/runs/:id/delta',
    { summary: 'What changed against the run this one supersedes', tag: 'payroll',
      permission: 'payroll.read' },
    authed('payroll.read', async (ctx) =>
      ok({ delta: await delta(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  router.post('/api/v1/payroll/runs/:id/distribute',
    { summary: 'Email the payslips of a locked run now (the job does this within 15 minutes anyway)',
      tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const result = await distributeRun(ctx.tx, { runId: id, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, {
        action: 'payroll.payslips.distributed', entityType: 'payroll_run', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { sent: result.sent, skipped: result.skipped.length, failed: result.failed.length },
      })
      return ok(result)
    }))

  router.get('/api/v1/payslips',
    { summary: 'Payslips, own by default', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      assertScope(ctx.auth, employeeId ?? undefined)
      const limit = asInt(ctx.req.query.get('limit') ?? 24, 'limit', { min: 1, max: 200 })
      const offset = asInt(ctx.req.query.get('offset') ?? 0, 'offset', { min: 0, max: 100_000 })
      const { rows } = await ctx.tx.query(
        `SELECT p.id, p.run_id, p.gross_paise::text, p.deductions_paise::text, p.net_paise::text, p.distributed_at::text,
                pp.label AS period, pp.pay_date::text
           FROM payslips p
           JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
           JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
          WHERE p.employee_id = $1 AND r.status = 'locked'
          ORDER BY pp.period_start DESC LIMIT $2 OFFSET $3`,
        [employeeId, limit + 1, offset])
      return ok({ payslips: rows.slice(0, limit), hasMore: rows.length > limit })
    }))

  router.get('/api/v1/payslips/:id/lines',
    { summary: 'The full component breakdown behind a payslip', tag: 'payroll',
      permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const { rows: slip } = await ctx.tx.query<{ employee_id: string; run_id: string }>(
        `SELECT employee_id, run_id FROM payslips WHERE id = $1`, [asUuid(ctx.req.params.id, 'id')])
      if (!slip[0]) throw new HttpError(404, 'NOT_FOUND', 'no such payslip')
      assertScope(ctx.auth, slip[0].employee_id)

      const { rows } = await ctx.tx.query(
        `SELECT component_code, component_type, amount_paise::text, calc_note
           FROM payroll_lines WHERE run_id = $1 AND employee_id = $2
          ORDER BY component_type, component_code`,
        [slip[0].run_id, slip[0].employee_id])
      return ok({ lines: rows })
    }))

  router.get('/api/v1/payslips/:id/pdf',
    { summary: 'The payslip as a PDF, base64 encoded', tag: 'payroll',
      permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const { rows } = await ctx.tx.query<{ employee_id: string }>(
        `SELECT employee_id FROM payslips WHERE id = $1`, [id])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such payslip')
      assertScope(ctx.auth, rows[0].employee_id)

      const pdf = await payslipPdf(ctx.tx, id)
      // A payslip carries net pay, so reading one is a tier-3 reveal.
      await emit(ctx.tx, {
        action: 'access.tier3.revealed', entityType: 'payslip', entityId: id,
        actorUserId: ctx.session.userId, subjectEmployeeId: rows[0].employee_id,
        metadata: { format: 'pdf' },
      })
      return ok({
        fileName: pdf.fileName,
        contentType: 'application/pdf',
        sizeBytes: pdf.bytes.length,
        contentBase64: pdf.bytes.toString('base64'),
      })
    }))
}
