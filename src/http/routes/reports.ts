/**
 * Reports. `report.read` decides who sees the screen; the money reports
 * additionally need `payroll.read` at company scope, because a salary
 * register is every salary in the company. `?format=csv` returns the file
 * (base64, like every other download here).
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, asDate, emit } from './deps.ts'
import { headcount, leaveBalances, salaryRegister, statutorySummary, type Report } from '../../reports/index.ts'
import type { Ctx } from '../context.ts'

function range(ctx: Ctx): { from: string; to: string } {
  const from = asDate(ctx.req.query.get('from'), 'from'), to = asDate(ctx.req.query.get('to'), 'to')
  if (to < from) throw new HttpError(422, 'VALIDATION_FAILED', 'to is before from')
  return { from, to }
}
function deliver(ctx: Ctx, name: string, report: Report) {
  if (ctx.req.query.get('format') === 'csv') {
    return ok({ fileName: `${name}.csv`, contentType: 'text/csv; charset=utf-8', rows: report.rows.length,
      contentBase64: Buffer.from(report.csv).toString('base64') })
  }
  return ok({ columns: report.columns, rows: report.rows })
}
function companyWideMoney(ctx: Ctx): void {
  if (!ctx.auth.permissions.has('payroll.read') || ctx.auth.scope !== 'all') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'this report needs payroll.read at company scope')
  }
}

export function register(router: Router): void {
  router.get('/api/v1/reports/salary-register',
    { summary: 'Every employee, every component, per locked run (?from=&to=&format=csv)', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      companyWideMoney(ctx)
      const r = range(ctx)
      const report = await salaryRegister(ctx.tx, r)
      await emit(ctx.tx, { action: 'access.tier3.revealed', entityType: 'report', actorUserId: ctx.auth.userId,
        metadata: { report: 'salary_register', ...r, rows: report.rows.length } })
      return deliver(ctx, `salary-register-${r.from}-${r.to}`, report)
    }))

  router.get('/api/v1/reports/statutory-summary',
    { summary: 'PF, ESI, PT and TDS totals per locked run — the challan figures (?from=&to=)', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      companyWideMoney(ctx)
      const r = range(ctx)
      return deliver(ctx, `statutory-summary-${r.from}-${r.to}`, await statutorySummary(ctx.tx, r))
    }))

  router.get('/api/v1/reports/headcount',
    { summary: 'Active count, joiners, leavers and attrition per month (?from=&to=)', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      const r = range(ctx)
      return deliver(ctx, `headcount-${r.from}-${r.to}`, await headcount(ctx.tx, r))
    }))

  router.get('/api/v1/reports/leave-balances',
    { summary: 'Per employee per leave type for a cycle year (?cycle=2026&asOf=)', tag: 'reports', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'this report is company-wide')
      const cycle = Number(ctx.req.query.get('cycle') ?? new Date().getFullYear())
      if (!Number.isInteger(cycle) || cycle < 2000 || cycle > 2100) throw new HttpError(422, 'VALIDATION_FAILED', 'cycle is a year')
      const asOf = ctx.req.query.get('asOf') ? asDate(ctx.req.query.get('asOf'), 'asOf') : undefined
      return deliver(ctx, `leave-balances-${cycle}`, await leaveBalances(ctx.tx, { cycleYear: cycle, asOf }))
    }))
}
