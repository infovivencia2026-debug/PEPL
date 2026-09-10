/** Leave. */
import type { Router } from '../router.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  requireModule,
  asDate,
  asUuid,
  assertScope,
  can,
  balance,
  appendEntry,
  reverse,
  raise,
  emit,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/leave/balances',
    { summary: 'Leave balances, explained', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)
      const cycle = Number(ctx.req.query.get('cycle') ?? new Date().getFullYear())

      const { rows: types } = await ctx.tx.query<{ id: string; code: string; name: string }>(
        `SELECT id, code, name FROM leave_types WHERE status = 'active' ORDER BY code`)

      const balances = []
      for (const t of types) {
        const b = await balance(ctx.tx, employeeId, t.id, cycle)
        balances.push({ leaveTypeId: t.id, code: t.code, name: t.name, ...b })
      }
      return ok({ cycle, balances })
    }))

  router.get('/api/v1/leave/balances/:leaveTypeId/ledger',
    { summary: 'Every movement behind a balance', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      assertScope(ctx.auth, employeeId ?? undefined)
      const { rows } = await ctx.tx.query(
        `SELECT entry_type, delta_days::float8 AS delta_days, effective_date::text, cycle_year, note, created_at
           FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2
          ORDER BY id`,
        [employeeId, asUuid(ctx.req.params.leaveTypeId, 'leaveTypeId')])
      return ok({ entries: rows })
    }))

  router.post('/api/v1/leave/requests',
    { summary: 'Apply for leave', tag: 'leave', permission: 'leave.apply',
      requestExample: { leaveTypeId: '…', startDate: '2026-09-14', endDate: '2026-09-16', totalDays: 3, reason: 'family event' } },
    authed('leave.apply', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const b = requireBody<{ leaveTypeId: string; startDate: string; endDate: string; totalDays: number; reason?: string; dayParts?: Record<string, string>; employeeId?: string }>(
        ctx.req, ['leaveTypeId', 'startDate', 'endDate', 'totalDays'])
      const employeeId = b.employeeId ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)

      // The smallest unit this company allows. A tenant that works in whole
      // days should not receive a request for 2.5, and the rejection belongs
      // here rather than in a form that a different client would not run.
      const minUnit = ctx.config.get<'full_day' | 'half_day' | 'hourly'>('leave.min_unit')
      const step = minUnit === 'full_day' ? 1 : minUnit === 'half_day' ? 0.5 : 0.125
      const days = Number(b.totalDays)
      if (!Number.isFinite(days) || days <= 0) {
        throw new HttpError(422, 'INVALID_DAYS', 'totalDays must be a positive number')
      }
      if (Math.abs(Math.round(days / step) * step - days) > 1e-9) {
        throw new HttpError(
          422, 'LEAVE_UNIT_NOT_ALLOWED',
          minUnit === 'full_day'
            ? 'this company allows whole days of leave only'
            : `leave must be applied for in multiples of ${step} of a day`,
          { minUnit },
        )
      }

      const { rows } = await ctx.tx.query<{ id: string }>(
        `INSERT INTO leave_requests
           (tenant_id, employee_id, leave_type_id, start_date, end_date, day_parts, total_days, reason)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
        [ctx.auth.tenantId, employeeId, asUuid(b.leaveTypeId, 'leaveTypeId'),
         asDate(b.startDate, 'startDate'), asDate(b.endDate, 'endDate'),
         JSON.stringify(b.dayParts ?? {}), b.totalDays, b.reason ?? null])

      const requestId = rows[0]!.id

      // The approver is resolved from the employee's CURRENT manager assignment,
      // never accepted from the request: a client that names its own approver can
      // route around the chain entirely.
      const { rows: mgr } = await ctx.tx.query<{ user_id: string }>(
        `SELECT u.id AS user_id
           FROM employee_assignments a
           JOIN app_users u ON (u.tenant_id, u.employee_id) = (a.tenant_id, a.manager_employee_id)
          WHERE a.employee_id = $1 AND a.superseded_at IS NULL
            AND (a.effective_to IS NULL OR a.effective_to > CURRENT_DATE)
          LIMIT 1`,
        [employeeId])

      const { rows: hr } = await ctx.tx.query<{ user_id: string }>(
        `SELECT user_id FROM user_roles WHERE role = 'hr_admin' LIMIT 1`)

      const approvalId = await raise(ctx.tx, {
        entityType: 'leave', entityId: requestId, requestedByUserId: ctx.auth.userId,
        subjectEmployeeId: employeeId,
        chainCode: ctx.config.get<string>('leave.approval_chain') as never,
        title: `Leave · ${b.totalDays} day(s) from ${b.startDate}`,
        approvers: { manager: mgr[0]?.user_id, hr: hr[0]?.user_id },
      })
      return created({ id: requestId, approvalRequestId: approvalId })
    }))

  router.post('/api/v1/leave/requests/:id/cancel',
    { summary: 'Cancel leave — writes a reversal, never deletes the consumption', tag: 'leave',
      permission: 'leave.apply' },
    authed('leave.apply', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const { rows } = await ctx.tx.query<{ employee_id: string; leave_type_id: string; total_days: string; start_date: string; status: string }>(
        `SELECT employee_id, leave_type_id, total_days::text, start_date::text, status
           FROM leave_requests WHERE id = $1`, [id])
      const r = rows[0]
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such leave request')
      assertScope(ctx.auth, r.employee_id)

      if (r.status === 'approved') {
        await reverse(ctx.tx, {
          employeeId: r.employee_id, leaveTypeId: r.leave_type_id,
          cycleYear: new Date(r.start_date).getFullYear(),
          days: Number(r.total_days), effectiveDate: new Date().toISOString().slice(0, 10),
          requestId: id,
        })
      }
      await ctx.tx.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1`, [id])
      return ok({ cancelled: true })
    }))

  router.post('/api/v1/leave/balances/adjust',
    { summary: 'Adjust a balance directly (HR only, reason required)', tag: 'leave',
      permission: 'leave.balance.adjust',
      requestExample: { employeeId: '…', leaveTypeId: '…', days: 2, reason: 'opening balance correction' } },
    authed('leave.balance.adjust', async (ctx) => {
      const b = requireBody<{ employeeId: string; leaveTypeId: string; days: number; reason: string; cycle?: number }>(
        ctx.req, ['employeeId', 'leaveTypeId', 'days', 'reason'])
      await appendEntry(ctx.tx, {
        employeeId: asUuid(b.employeeId, 'employeeId'), leaveTypeId: asUuid(b.leaveTypeId, 'leaveTypeId'),
        entryType: 'adjustment', deltaDays: b.days,
        effectiveDate: new Date().toISOString().slice(0, 10),
        cycleYear: b.cycle ?? new Date().getFullYear(),
        note: b.reason, actorUserId: ctx.auth.userId,
      })
      await emit(ctx.tx, {
        action: 'leave.balance.adjusted', entityType: 'employee', entityId: b.employeeId,
        subjectEmployeeId: b.employeeId, actorUserId: ctx.auth.userId,
        after: { days: b.days }, reason: b.reason,
      })
      return ok({ adjusted: true })
    }))
}
