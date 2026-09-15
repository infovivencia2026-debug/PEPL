/**
 * Separations. HR initiates and cancels (`employee.write`); payroll previews
 * the settlement (`payroll.process`) because it reads compensation. The
 * settlement itself is not a route — it happens at freeze, like everything
 * else that becomes a payslip line.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, requireModule, asUuid, asDate, assertScope, can, emit } from './deps.ts'
import {
  cancelSeparation, computeSettlement, getSeparation, initiateSeparation, type SeparationReason,
} from '../../payroll/exit.ts'

export function register(router: Router): void {
  router.get('/api/v1/employees/:id/separation',
    { summary: 'The current (or last) separation for an employee', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const separation = await getSeparation(ctx.tx, id)
      // The settlement figures are compensation; a manager sees that an exit
      // exists and when, not what it pays.
      if (separation && !can(ctx.auth, 'compensation.read')) separation.settlement = null
      return ok({ separation })
    }))

  router.post('/api/v1/employees/:id/separation',
    { summary: 'Start an exit: reason, last working day, notice owed', tag: 'people', permission: 'employee.write',
      requestExample: { reason: 'resignation', lastWorkingDay: '2026-10-31', noticeDaysRequired: 60 } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const b = requireBody<{
        reason: SeparationReason; lastWorkingDay: string; initiatedOn?: string; noticeDaysRequired?: number
        noticeWaived?: boolean; recoveriesPaise?: number; recoveriesNote?: string; note?: string
      }>(ctx.req, ['reason', 'lastWorkingDay'])
      if (b.noticeDaysRequired !== undefined && (!Number.isInteger(b.noticeDaysRequired) || b.noticeDaysRequired < 0 || b.noticeDaysRequired > 365)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'noticeDaysRequired must be a whole number of days, 0–365')
      }
      if (b.recoveriesPaise !== undefined && (!Number.isSafeInteger(b.recoveriesPaise) || b.recoveriesPaise < 0)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'recoveriesPaise must be a non-negative integer')
      }
      const separation = await initiateSeparation(ctx.tx, {
        employeeId: id, reason: b.reason, lastWorkingDay: asDate(b.lastWorkingDay, 'lastWorkingDay'),
        initiatedOn: b.initiatedOn ? asDate(b.initiatedOn, 'initiatedOn') : undefined,
        noticeDaysRequired: b.noticeDaysRequired, noticeWaived: b.noticeWaived,
        recoveriesPaise: b.recoveriesPaise, recoveriesNote: b.recoveriesNote, note: b.note,
        actorUserId: ctx.auth.userId,
      })
      await emit(ctx.tx, {
        action: 'employee.separation.initiated', entityType: 'employee', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: id,
        metadata: { reason: b.reason, lastWorkingDay: separation.last_working_day },
      })
      return created({ separation })
    }))

  router.post('/api/v1/separations/:id/cancel',
    { summary: 'Cancel an exit that has not reached payroll (reason required)', tag: 'people',
      permission: 'employee.write', requestExample: { reason: 'resignation withdrawn' } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      const separation = await cancelSeparation(ctx.tx, id, b.reason)
      assertScope(ctx.auth, separation.employee_id)
      await emit(ctx.tx, {
        action: 'employee.separation.cancelled', entityType: 'employee', entityId: separation.employee_id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: separation.employee_id, reason: b.reason,
      })
      return ok({ separation })
    }))

  router.get('/api/v1/separations/:id/settlement-preview',
    { summary: 'What the full-and-final settlement would be today (final at freeze)', tag: 'payroll',
      permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const { rows } = await ctx.tx.query<{ employee_id: string }>(
        `SELECT employee_id FROM employee_separations WHERE id = $1`, [id])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such separation')
      const separation = (await getSeparation(ctx.tx, rows[0].employee_id))!
      if (separation.settlement) {
        // Already resolved at freeze: what was paid, not what would be paid.
        return ok({ settlement: separation.settlement, final: true, runId: separation.settlement_run_id })
      }
      const divisor = ctx.config.get<number>('payroll.exit_day_divisor')
      const settlement = await computeSettlement(ctx.tx, separation, { encashmentDivisor: divisor, noticeDivisor: divisor })
      return ok({ settlement, final: false })
    }))
}
