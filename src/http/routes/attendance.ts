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
import { evaluatePunch } from '../../attendance/geofence.ts'
import { hold, listPending } from '../../approvals/pending.ts'

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
      // `withinGeofence` from the client is ignored on purpose: the server decides.
      const b = requireBody<{ direction: 'in' | 'out'; localDate: string; clientPunchId?: string; geo?: { lat: number; lng: number }; employeeId?: string }>(
        ctx.req, ['direction', 'localDate'])
      if (b.geo && (typeof b.geo.lat !== 'number' || typeof b.geo.lng !== 'number')) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'geo needs numeric lat and lng')
      }
      const employeeId = b.employeeId ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)

      const verdict = await evaluatePunch(ctx.tx, employeeId, b.geo)
      // A fenced person without a fix is outside by definition; an unfenced
      // one is only asked for a fix when the company insists on one.
      if (!b.geo && (verdict.status === 'outside' || ctx.config.get<boolean>('attendance.geofence_required'))) {
        throw new HttpError(422, 'LOCATION_REQUIRED',
          'this company requires a location fix on every mobile punch')
      }
      if (verdict.status === 'outside' && ctx.config.get<boolean>('attendance.geofence_enforce')) {
        throw new HttpError(422, 'OUTSIDE_GEOFENCE',
          `you are ${verdict.distanceM} m from ${verdict.siteCode}; punch from an allowed site`,
          { siteCode: verdict.siteCode, distanceM: verdict.distanceM })
      }

      const createdPunch = await recordPunch(ctx.tx, {
        employeeId, punchedAt: new Date().toISOString(),
        localDate: asDate(b.localDate, 'localDate'), direction: b.direction, source: 'mobile',
        clientPunchId: b.clientPunchId, geo: b.geo,
        geofence: {
          withinGeofence: verdict.status === 'unfenced' ? null : verdict.status === 'inside',
          siteId: verdict.siteId, distanceM: verdict.distanceM,
        },
      })
      await recomputeDay(ctx.tx, employeeId, b.localDate, dayPolicy(ctx))
      return ok({ recorded: createdPunch, duplicate: !createdPunch, geofence: verdict })
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
      const chain = ctx.config.get<string>('attendance.correction_approval')
      if (chain !== 'none') {
        // One held change per person: the approval names a subject.
        const held = []
        for (const employeeId of targets) {
          held.push(await hold(ctx.tx, {
            kind: 'attendance_correction', subjectEmployeeId: employeeId, requestedByUserId: ctx.auth.userId,
            payload: { workDate: asDate(b.workDate, 'workDate'), action: b.action as never, after: b.after, reason: b.reason,
              policy: dayPolicy(ctx), allowClosedPeriod: allowClosed },
            fallback: chain as never, title: `Attendance · ${b.action.replace(/_/g, ' ')} on ${b.workDate}`,
          }))
        }
        await emit(ctx.tx, {
          action: 'attendance.correction.requested', entityType: 'attendance', actorUserId: ctx.auth.userId,
          metadata: { workDate: b.workDate, action: b.action, employees: targets.length }, reason: b.reason,
        })
        return { status: 202, body: { held: held.map((h) => ({ pendingId: h.pendingId, approvalRequestId: h.requestId, chain: h.chainCode })) } }
      }
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

  // What an employee may ask for about their own day. Marking oneself absent
  // or on leave is not in the list: leave goes through leave; absence needs nobody's request.
  const SELF_ACTIONS = new Set(['set_punch_in', 'set_punch_out', 'mark_present', 'mark_remote', 'mark_field_duty'])

  router.post('/api/v1/attendance/regularisations',
    { summary: 'Ask for a correction to MY own day (always held for approval)', tag: 'attendance',
      requestExample: { workDate: '2026-09-14', action: 'set_punch_out', after: { at: '2026-09-14T18:35:00+05:30' }, reason: 'forgot to punch out' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const employeeId = ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ workDate: string; action: string; after?: Record<string, unknown>; reason: string }>(ctx.req, ['workDate', 'action', 'reason'])
      if (!SELF_ACTIONS.has(b.action)) {
        throw new HttpError(422, 'VALIDATION_FAILED', `action must be one of ${[...SELF_ACTIONS].join(', ')}`)
      }
      if (!String(b.reason).trim()) throw new HttpError(422, 'REASON_REQUIRED', 'say what happened')
      const workDate = asDate(b.workDate, 'workDate')
      const today = new Date().toISOString().slice(0, 10)
      if (workDate > today) throw new HttpError(422, 'VALIDATION_FAILED', 'a regularisation is for a day that has happened')
      const windowDays = ctx.config.get<number>('attendance.correction_window_days')
      const oldest = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)
      if (workDate < oldest) {
        throw new HttpError(422, 'CORRECTION_WINDOW_CLOSED', `corrections are accepted for the last ${windowDays} days`)
      }
      if ((b.action === 'set_punch_in' || b.action === 'set_punch_out') && typeof b.after?.at !== 'string') {
        throw new HttpError(422, 'VALIDATION_FAILED', 'after.at (an ISO timestamp) is required for a punch correction')
      }
      const held = await hold(ctx.tx, {
        kind: 'attendance_correction', subjectEmployeeId: employeeId, requestedByUserId: ctx.auth.userId,
        payload: { workDate, action: b.action as never, after: b.after, reason: String(b.reason).trim(), policy: dayPolicy(ctx), allowClosedPeriod: false },
        fallback: ctx.config.get<string>('attendance.regularisation_chain') as never,
        title: `Attendance · ${b.action.replace(/_/g, ' ')} on ${workDate}`,
      })
      await emit(ctx.tx, {
        action: 'attendance.correction.requested', entityType: 'attendance', actorUserId: ctx.auth.userId, subjectEmployeeId: employeeId,
        metadata: { workDate, action: b.action, self: true, approvalRequestId: held.requestId }, reason: String(b.reason),
      })
      return { status: 202, body: { held: true, pendingId: held.pendingId, approvalRequestId: held.requestId, chain: held.chainCode } }
    }))

  router.get('/api/v1/attendance/regularisations',
    { summary: 'My regularisation requests and what became of them (?status=)', tag: 'attendance' },
    authed(null, async (ctx) => {
      if (!ctx.auth.employeeId) return ok({ requests: [] })
      const status = ctx.req.query.get('status') as 'pending' | 'applied' | 'rejected' | 'withdrawn' | null
      const rows = await listPending(ctx.tx, { employeeId: ctx.auth.employeeId, status: status ?? undefined })
      return ok({ requests: rows.filter((r) => r.entity_type === 'attendance_correction') })
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
