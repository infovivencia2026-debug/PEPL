/** Leave. */
import type { Router } from '../router.ts'
import { applyLeave } from '../../leave/apply.ts'
import { scopeIds } from '../ui-data.ts'
import { grantCompOff, listCredits } from '../../leave/compoff.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  requireModule,
  asDate,
  asUuid,
  asInt,
  assertScope,
  can,
  balance,
  appendEntry,
  reverse,
  emit,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/leave/requests',
    { summary: 'Leave requests you may see (own, your reports, or everyone), newest first, paged', tag: 'leave',
      permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const ids = scopeIds(ctx)
      const status = ctx.req.query.get('status')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      const limit = asInt(ctx.req.query.get('limit') ?? 50, 'limit', { min: 1, max: 200 })
      const offset = asInt(ctx.req.query.get('offset') ?? 0, 'offset', { min: 0, max: 100_000 })
      const { rows } = await ctx.tx.query(
        `SELECT l.id, l.employee_id, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name,
                l.leave_type_id, t.code AS leave_code, t.name AS leave_name,
                l.start_date::text, l.end_date::text, l.total_days::text, l.day_parts, l.reason, l.status,
                l.applied_at::text, l.decided_at::text
           FROM leave_requests l
           JOIN employees e ON (e.tenant_id, e.id) = (l.tenant_id, l.employee_id)
           JOIN leave_types t ON (t.tenant_id, t.id) = (l.tenant_id, l.leave_type_id)
          WHERE ($1::uuid[] IS NULL OR l.employee_id = ANY($1))
            AND ($2::text IS NULL OR l.status = $2)
            AND ($3::uuid IS NULL OR l.employee_id = $3)
          ORDER BY l.applied_at DESC LIMIT $4 OFFSET $5`,
        [ids, status ?? null, employeeId ?? null, limit + 1, offset])
      return ok({ requests: rows.slice(0, limit), hasMore: rows.length > limit })
    }))

  router.get('/api/v1/leave/comp-off',
    { summary: 'Comp-off credits (own by default): the off days worked, when each expires, spent or not', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok({ credits: await listCredits(ctx.tx, employeeId) })
    }))

  router.post('/api/v1/leave/comp-off',
    { summary: 'Grant a comp-off the muster missed (HR): one full or half day for a date worked', tag: 'leave',
      permission: 'leave.balance.adjust', requestExample: { employeeId: '…', workDate: '2026-10-02', days: 1, reason: 'worked the Gandhi Jayanti holiday at the client site' } },
    authed('leave.balance.adjust', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const b = requireBody<{ employeeId: string; workDate: string; days?: number; reason: string }>(ctx.req, ['employeeId', 'workDate', 'reason'])
      const days = b.days === 0.5 ? 0.5 : 1
      const r = await grantCompOff(ctx.tx, ctx.config, { employeeId: asUuid(b.employeeId, 'employeeId'), workDate: asDate(b.workDate, 'workDate'), days, actorUserId: ctx.auth.userId, note: b.reason })
      if (!r.granted) throw new HttpError(409, 'COMP_OFF_EXISTS', 'a comp-off for that date is already credited')
      await emit(ctx.tx, { action: 'leave.balance.adjusted', entityType: 'employee', entityId: b.employeeId, subjectEmployeeId: b.employeeId,
        actorUserId: ctx.auth.userId, reason: b.reason, metadata: { compOff: b.workDate, days, expiresOn: r.expiresOn } })
      return created(r)
    }))

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
        ctx.req, ['leaveTypeId', 'startDate', 'endDate'])
      const employeeId = b.employeeId ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)

      const result = await applyLeave(ctx.tx, ctx.config, {
        employeeId, requestedByUserId: ctx.auth.userId,
        leaveTypeId: asUuid(b.leaveTypeId, 'leaveTypeId'),
        startDate: asDate(b.startDate, 'startDate'), endDate: asDate(b.endDate, 'endDate'),
        dayParts: b.dayParts, reason: b.reason, totalDays: b.totalDays,
      })
      return created({ id: result.id, totalDays: result.totalDays, skipped: result.skipped, approvalRequestId: result.approvalRequestId, chain: result.chain })
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
