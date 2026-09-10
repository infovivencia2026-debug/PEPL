/** Attendance. */
import type { Router } from '../router.ts'
import type { Ctx } from '../context.ts'
import {
  HttpError,
  authed,
  open,
  ok,
  requireBody,
  requireModule,
  asDate,
  asInt,
  asUuid,
  assertScope,
  can,
  applyBulkCorrection,
  recomputeDay,
  recordPunch,
  setPeriodStatus,
  emit,
} from './deps.ts'

/**
 * The company's attendance rules, read once per request.
 *
 * Resolving inside recomputeDay would mean one config read per day recomputed,
 * which for a bulk correction is hundreds.
 */
function dayPolicy(ctx: Ctx) {
  return {
    halfDayMode: ctx.config.get<'explicit' | 'hours_derived'>('attendance.half_day_mode'),
    halfDayHours: ctx.config.get<number>('attendance.half_day_hours'),
    weekPattern: ctx.config.get<'five_day' | 'six_day' | 'alternate_saturday' | 'roster'>(
      'attendance.week_pattern'),
    remoteIsPaid: ctx.config.get<boolean>('attendance.remote_is_paid'),
    remoteEnabled: ctx.config.get<boolean>('attendance.remote_enabled'),
    correctionWindowDays: ctx.config.get<number>('attendance.correction_window_days'),
  }
}

export function register(router: Router): void {
  router.post('/api/v1/attendance/punch',
    { summary: 'Record a punch (idempotent by clientPunchId)', tag: 'attendance',
      permission: 'attendance.read',
      requestExample: { direction: 'in', localDate: '2026-09-14', clientPunchId: 'offline-1', geo: { lat: 17.4, lng: 78.4 } } },
    authed('attendance.read', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const b = requireBody<{ direction: 'in' | 'out'; localDate: string; clientPunchId?: string; geo?: { lat: number; lng: number }; withinGeofence?: boolean; employeeId?: string }>(
        ctx.req, ['direction', 'localDate'])
      const employeeId = b.employeeId ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)

      if (ctx.config.get<boolean>('attendance.geofence_required') && !b.geo) {
        throw new HttpError(422, 'LOCATION_REQUIRED',
          'this company requires a location fix on every mobile punch')
      }

      const createdPunch = await recordPunch(ctx.tx, {
        employeeId, punchedAt: new Date().toISOString(),
        localDate: asDate(b.localDate, 'localDate'), direction: b.direction, source: 'mobile',
        clientPunchId: b.clientPunchId, geo: b.geo, withinGeofence: b.withinGeofence,
      })
      await recomputeDay(ctx.tx, employeeId, b.localDate, dayPolicy(ctx))
      return ok({ recorded: createdPunch, duplicate: !createdPunch })
    }))

  router.get('/api/v1/attendance',
    { summary: 'Daily attendance for a date range', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const from = asDate(ctx.req.query.get('from'), 'from')
      const to = asDate(ctx.req.query.get('to'), 'to')
      const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
      if (employeeId) assertScope(ctx.auth, employeeId)
      const scopeIds = ctx.auth.scope === 'all' && !employeeId
        ? null : [employeeId].filter(Boolean)

      const limit = asInt(ctx.req.query.get('limit') ?? 500, 'limit', { min: 1, max: 2000 })
      const offset = asInt(ctx.req.query.get('offset') ?? 0, 'offset', { min: 0 })

      const { rows } = await ctx.tx.query(
        `SELECT employee_id, work_date::text, status, day_fraction::float8 AS day_fraction,
                is_remote, is_field_duty, is_regularized, worked_minutes, marked_reason
           FROM daily_attendance
          WHERE work_date BETWEEN $1 AND $2
            AND ($3::uuid[] IS NULL OR employee_id = ANY($3))
          ORDER BY work_date, employee_id
          LIMIT $4 OFFSET $5`,
        [from, to, scopeIds, limit + 1, offset])
      // A month across 300 people is 9,000 rows; the client is told when it has
      // only part of the answer rather than silently rendering a truncated month.
      return ok({ days: rows.slice(0, limit), hasMore: rows.length > limit, offset })
    }))

  router.post('/api/v1/attendance/corrections',
    { summary: 'Correct a day. Instant while the period is open; never rewrites a frozen one',
      tag: 'attendance', permission: 'attendance.correct',
      requestExample: { employeeId: '…', workDate: '2026-09-14', action: 'mark_present', reason: 'biometric device offline' } },
    authed('attendance.correct', async (ctx) => {
      const b = requireBody<{ employeeId?: string; employeeIds?: string[]; workDate: string; action: string; reason: string; after?: Record<string, unknown> }>(
        ctx.req, ['workDate', 'action', 'reason'])
      const targets = b.employeeIds ?? (b.employeeId ? [b.employeeId] : [])
      if (targets.length === 0) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'employeeId or employeeIds is required')
      }
      for (const id of targets) assertScope(ctx.auth, id)

      const allowClosed = can(ctx.auth, 'attendance.reopen_period')
      const results = await applyBulkCorrection(ctx.tx, targets, {
        workDate: asDate(b.workDate, 'workDate'),
        action: b.action as never, after: b.after, reason: b.reason,
        actorUserId: ctx.auth.userId, allowClosedPeriod: allowClosed,
        policy: dayPolicy(ctx),
      })
      await emit(ctx.tx, {
        action: 'attendance.day.corrected', entityType: 'attendance', actorUserId: ctx.auth.userId,
        metadata: { workDate: b.workDate, action: b.action, employees: targets.length }, reason: b.reason,
      })
      return ok({ results })
    }))

  router.post('/api/v1/attendance/periods/:id/status',
    { summary: 'Close, reopen or freeze an attendance period', tag: 'attendance',
      permission: 'attendance.close_period', requestExample: { status: 'closed' } },
    authed('attendance.close_period', async (ctx) => {
      const b = requireBody<{ status: 'open' | 'closed' | 'frozen' }>(ctx.req, ['status'])
      if (b.status === 'open' && !can(ctx.auth, 'attendance.reopen_period')) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'reopening a period requires attendance.reopen_period')
      }
      await setPeriodStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status, ctx.auth.userId)
      await emit(ctx.tx, {
        action: b.status === 'open' ? 'attendance.period.reopened' : 'attendance.period.closed',
        entityType: 'attendance_period', entityId: ctx.req.params.id,
        actorUserId: ctx.auth.userId, after: { status: b.status },
        reason: b.status === 'open' ? 'period reopened by HR' : undefined,
      })
      return ok({ status: b.status })
    }))
}
