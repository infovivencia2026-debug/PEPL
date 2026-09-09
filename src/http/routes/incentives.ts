/** Incentives. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  requireBody,
  asInt,
  asUuid,
  approve,
  calculate,
  approvePeriod,
  calculatePeriod,
  clawback,
  closePeriod,
  pushToPayroll,
} from './deps.ts'

export function register(router: Router): void {
  router.post('/api/v1/incentives/periods/:id/close',
    { summary: 'Close an incentive period before calculating', tag: 'incentives',
      permission: 'incentive.write' },
    authed('incentive.write', async (ctx) => {
      await closePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      return ok({ closed: true })
    }))

  router.post('/api/v1/incentives/periods/:id/calculate',
    { summary: 'Calculate incentives for a closed period', tag: 'incentives',
      permission: 'incentive.write' },
    authed('incentive.write', async (ctx) => {
      const n = await calculatePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      return ok({ calculated: n })
    }))

  router.post('/api/v1/incentives/periods/:id/approve',
    { summary: 'Approve calculated incentives', tag: 'incentives', permission: 'incentive.approve' },
    authed('incentive.approve', async (ctx) => {
      await approvePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
      return ok({ approved: true })
    }))

  router.post('/api/v1/incentives/periods/:id/push',
    { summary: 'Push approved incentives into a draft payroll run', tag: 'incentives',
      permission: 'incentive.approve', requestExample: { payrollRunId: '…' } },
    authed('incentive.approve', async (ctx) => {
      const b = requireBody<{ payrollRunId: string }>(ctx.req, ['payrollRunId'])
      return ok(await pushToPayroll(ctx.tx, asUuid(ctx.req.params.id, 'id'), asUuid(b.payrollRunId, 'payrollRunId')))
    }))

  router.post('/api/v1/incentives/clawback',
    { summary: 'Claw back a paid incentive as a next-period adjustment', tag: 'incentives',
      permission: 'incentive.write' },
    authed('incentive.write', async (ctx) => {
      const b = requireBody<{ employeeId: string; planId: string; nextPeriodId: string; amountPaise: number; note: string }>(
        ctx.req, ['employeeId', 'planId', 'nextPeriodId', 'amountPaise', 'note'])
      await clawback(ctx.tx, {
        employeeId: asUuid(b.employeeId, 'employeeId'), planId: asUuid(b.planId, 'planId'),
        nextPeriodId: asUuid(b.nextPeriodId, 'nextPeriodId'),
        amountPaise: asInt(b.amountPaise, 'amountPaise', { min: 1 }), note: b.note,
      })
      return ok({ applied: true })
    }))
}
