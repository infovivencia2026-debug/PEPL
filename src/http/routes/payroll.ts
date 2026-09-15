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
  computeTds,
} from './deps.ts'

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
        ptAmountPaise: (state, gross) => ptFor(statutory.ptSlabs, state, gross),
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
      const statutory = await loadStatutory(ctx.tx)
      const result = await validate(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
        statutory: statutory.config,
        ptAmountPaise: (state, gross) => ptFor(statutory.ptSlabs, state, gross),
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
      await approve(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, {
        requireSeparateApprover: ctx.config.get<boolean>('payroll.require_separate_approver'),
      })
      return ok({ approved: true })
    }))

  router.post('/api/v1/payroll/runs/:id/lock',
    { summary: 'Lock the run. Irreversible; corrections become revisions', tag: 'payroll',
      permission: 'payroll.lock' },
    authed('payroll.lock', async (ctx) => {
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

  router.get('/api/v1/payslips',
    { summary: 'Payslips, own by default', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      assertScope(ctx.auth, employeeId ?? undefined)
      const { rows } = await ctx.tx.query(
        `SELECT p.id, p.run_id, p.gross_paise::text, p.deductions_paise::text, p.net_paise::text,
                pp.label AS period
           FROM payslips p
           JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
           JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
          WHERE p.employee_id = $1 AND r.status = 'locked'
          ORDER BY pp.period_start DESC`,
        [employeeId])
      return ok({ payslips: rows })
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
