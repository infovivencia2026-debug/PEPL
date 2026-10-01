/** Attendance. */
import type { Router } from '../router.ts'
import type { Ctx } from '../context.ts'
import {
  HttpError,
  authed,
  open,
  ok,
  created,
  noContent,
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
import { remoteModeOn, markModeOnDay, listRemoteRequests, requestRemote, cancelRemote, getRemoteRequest, startVisit, endVisit, listVisits } from '../../attendance/remote.ts'
import { scopeIds } from '../ui-data.ts'
import { musterRoll } from '../../attendance/muster.ts'
import { startBreak, endBreak, breaksOn, setLateReason, controlRoom, qrCode, verifyQr, rotateQrSecret } from '../../attendance/ops.ts'
import { summaryPolicy } from './shifts.ts'
import { hold, listPending } from '../../approvals/pending.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { assertPunchWindow } from '../../attendance/punch-window.ts'

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
    timezone: ctx.config.get<string>('attendance.timezone'),
    remoteIsPaid: ctx.config.get<boolean>('attendance.remote_is_paid'),
    remoteEnabled: ctx.config.get<boolean>('attendance.remote_enabled'),
    breaksDeducted: ctx.config.get<boolean>('attendance.breaks_deducted'),
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
      const b = requireBody<{ direction: 'in' | 'out'; localDate?: string; clientPunchId?: string; geo?: { lat: number; lng: number }; employeeId?: string; qr?: string }>(
        ctx.req, ['direction'])
      if (b.direction !== 'in' && b.direction !== 'out') throw new HttpError(422, 'VALIDATION_FAILED', "direction must be 'in' or 'out'")
      if (b.clientPunchId !== undefined && (typeof b.clientPunchId !== 'string' || b.clientPunchId.length === 0 || b.clientPunchId.length > 100)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'clientPunchId must be a string of 1-100 characters')
      }
      // A latitude outside +-90 or longitude outside +-180 used to reach the database as a numeric
      // overflow and answer 500; NaN and Infinity are not numbers a device can have measured.
      if (b.geo && (!Number.isFinite(b.geo.lat) || !Number.isFinite(b.geo.lng) || Math.abs(b.geo.lat) > 90 || Math.abs(b.geo.lng) > 180)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'geo needs a latitude within 90 and a longitude within 180')
      }
      const employeeId = b.employeeId ?? ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)
      // Punching FOR someone else is a correction in effect, so it takes the right to correct.
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'attendance.correct')) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'punching on someone else\'s behalf needs the right to correct attendance')
      }

      // Optional: a client with no trustworthy clock omits it and gets the company's today.
      const localDate = b.localDate ? asDate(b.localDate, 'localDate') : localToday(ctx.config.get<string>('attendance.timezone'))
      // The server decides which day a punch belongs to; a period that has closed takes none.
      await assertPunchWindow(ctx.tx, {
        employeeId, localDate, direction: b.direction, timezone: ctx.config.get<string>('attendance.timezone'),
      })
      // An approved work-from-home or field day is not fenced: the punch is
      // recorded with whatever location it has and the day carries the mode.
      const mode = await remoteModeOn(ctx.tx, employeeId, localDate)
      // A scanned kiosk code IS the location: the punch is at that site.
      let qrSite: string | null = null
      if (b.qr) {
        if (!ctx.config.get<boolean>('attendance.qr_punch_enabled')) throw new HttpError(422, 'QR_INVALID', 'QR punch is switched off for this company')
        qrSite = (await verifyQr(ctx.tx, b.qr)).siteId
      }
      const verdict = qrSite
        ? { status: 'inside' as const, siteId: qrSite, siteCode: null, siteName: null, distanceM: 0 }
        : await evaluatePunch(ctx.tx, employeeId, b.geo)
      // A fenced person without a fix is outside by definition; an unfenced
      // one is only asked for a fix when the company insists on one.
      if (!mode && !qrSite && !b.geo && (verdict.status === 'outside' || ctx.config.get<boolean>('attendance.geofence_required'))) {
        throw new HttpError(422, 'LOCATION_REQUIRED',
          'this company requires a location fix on every mobile punch')
      }
      if (!mode && verdict.status === 'outside' && ctx.config.get<boolean>('attendance.geofence_enforce')) {
        throw new HttpError(422, 'OUTSIDE_GEOFENCE',
          `you are ${verdict.distanceM} m from ${verdict.siteCode}; punch from an allowed site`,
          { siteCode: verdict.siteCode, distanceM: verdict.distanceM })
      }

      const createdPunch = await recordPunch(ctx.tx, {
        employeeId, punchedAt: new Date().toISOString(),
        localDate, direction: b.direction, source: 'mobile',
        clientPunchId: b.clientPunchId, geo: b.geo, via: qrSite ? 'qr' : undefined,
        recordedByUserId: ctx.session.userId,
        geofence: {
          withinGeofence: verdict.status === 'unfenced' ? null : verdict.status === 'inside',
          siteId: verdict.siteId, distanceM: verdict.distanceM,
        },
      })
      await recomputeDay(ctx.tx, employeeId, localDate, dayPolicy(ctx))
      if (mode && createdPunch) await markModeOnDay(ctx.tx, { employeeId, workDate: localDate, mode, actorUserId: ctx.auth.userId, policy: dayPolicy(ctx) })
      const day = (await ctx.tx.query<{ late_minutes: number; late_reason: string | null }>(`SELECT late_minutes, late_reason FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`, [employeeId, localDate])).rows[0]
      const lateMinutes = day?.late_minutes ?? 0
      return ok({ recorded: createdPunch, duplicate: !createdPunch, geofence: verdict, mode, lateMinutes,
        reasonRequired: b.direction === 'in' && lateMinutes > 0 && !day?.late_reason && ctx.config.get<boolean>('attendance.late_reason_required') })
    }))

  router.post('/api/v1/attendance/break/start',
    { summary: 'Start a break (after punch-in); one at a time', tag: 'attendance', permission: 'attendance.read', requestExample: { kind: 'lunch' } },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ kind?: string; localDate?: string }>(ctx.req, [])
      const workDate = b.localDate ? asDate(b.localDate, 'localDate') : localToday(ctx.config.get<string>('attendance.timezone'))
      return created(await startBreak(ctx.tx, { employeeId: ctx.auth.employeeId, workDate, kind: b.kind }))
    }))

  router.post('/api/v1/attendance/break/end',
    { summary: 'End the running break; the day\'s worked time is recomputed', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      return ok(await endBreak(ctx.tx, { employeeId: ctx.auth.employeeId, policy: dayPolicy(ctx) }))
    }))

  router.get('/api/v1/attendance/breaks',
    { summary: 'Breaks on a day (?date=, ?employeeId= for someone in scope)', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)
      const date = ctx.req.query.get('date') ? asDate(ctx.req.query.get('date'), 'date') : localToday(ctx.config.get<string>('attendance.timezone'))
      return ok({ breaks: await breaksOn(ctx.tx, employeeId, date) })
    }))

  router.post('/api/v1/attendance/late-reason',
    { summary: 'Explain a late punch (shown to the manager)', tag: 'attendance', permission: 'attendance.read', requestExample: { localDate: '2026-10-05', reason: 'Metro breakdown' } },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ localDate: string; reason: string }>(ctx.req, ['localDate', 'reason'])
      return ok(await setLateReason(ctx.tx, { employeeId: ctx.auth.employeeId, workDate: asDate(b.localDate, 'localDate'), reason: b.reason }))
    }))

  router.get('/api/v1/attendance/control-room',
    { summary: 'Live today (or ?date=) for your scope: expected / in / late / on break / missing / on leave / remote / field, by location', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      if (ctx.auth.scope === 'self') throw new HttpError(403, 'PERMISSION_DENIED', 'the control room is for managers and HR')
      const date = ctx.req.query.get('date') ? asDate(ctx.req.query.get('date'), 'date') : localToday(ctx.config.get<string>('attendance.timezone'))
      return ok(await controlRoom(ctx.tx, { date, employeeIds: scopeIds(ctx), timezone: ctx.config.get<string>('attendance.timezone'), weekPattern: ctx.config.get<string>('attendance.week_pattern') }))
    }))

  router.get('/api/v1/attendance/qr',
    { summary: 'The kiosk code for a site right now (?siteId=); changes every minute, valid for two', tag: 'attendance', permission: 'attendance.kiosk' },
    authed('attendance.kiosk', async (ctx) => {
      if (!ctx.config.get<boolean>('attendance.qr_punch_enabled')) throw new HttpError(422, 'QR_INVALID', 'QR punch is switched off for this company')
      const siteId = asUuid(ctx.req.query.get('siteId'), 'siteId')
      const code = await qrCode(ctx.tx, siteId)
      // Who displayed a live code is what a relayed screenshot is traced back to. A kiosk polls every
      // minute, so one record per person and site per ten minutes, not one per fetch.
      const recent = await ctx.tx.query(
        `SELECT 1 FROM audit_events WHERE action = 'attendance.qr.issued' AND actor_user_id = $1 AND entity_id = $2
            AND occurred_at > now() - interval '10 minutes' LIMIT 1`, [ctx.session.userId, siteId])
      if (!recent.rowCount) {
        await emit(ctx.tx, { action: 'attendance.qr.issued', entityType: 'geofence_site', entityId: siteId, actorUserId: ctx.session.userId })
      }
      return ok(code)
    }))

  router.post('/api/v1/attendance/qr/rotate',
    { summary: 'Invalidate every kiosk code at once (new secret)', tag: 'attendance', permission: 'attendance.correct' },
    authed('attendance.correct', async (ctx) => {
      await rotateQrSecret(ctx.tx)
      await emit(ctx.tx, { action: 'attendance.qr.rotated', entityType: 'attendance', actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.get('/api/v1/attendance/calendar',
    { summary: 'My month as the muster sees it (?month=YYYY-MM, ?employeeId= for someone in scope): one cell per day with code, payable, in/out', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const month = ctx.req.query.get('month') ?? localToday(ctx.config.get<string>('attendance.timezone')).slice(0, 7)
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, 'VALIDATION_FAILED', 'month is YYYY-MM')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      assertScope(ctx.auth, employeeId)
      const m = await musterRoll(ctx.tx, { month, policy: summaryPolicy(ctx), employeeIds: [employeeId] })
      const row = m.rows[0]
      return ok({ month, employeeId, days: row?.days ?? [], totals: row?.totals ?? null, legend: m.legend })
    }))

  // ── work from home / field duty ──
  router.get('/api/v1/attendance/remote-requests',
    { summary: 'WFH and field-duty requests you may see (?employeeId=&status=&from=&to=)', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok({ requests: await listRemoteRequests(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, status: ctx.req.query.get('status') ?? undefined,
        from: ctx.req.query.get('from') ?? undefined, to: ctx.req.query.get('to') ?? undefined }) })
    }))

  router.post('/api/v1/attendance/remote-requests',
    { summary: 'Request work-from-home or field duty for a date range (approval per settings)', tag: 'attendance', permission: 'attendance.read',
      requestExample: { kind: 'wfh', startsOn: '2026-10-06', endsOn: '2026-10-07', reason: 'plumber' } },
    authed('attendance.read', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const b = requireBody<{ employeeId?: string; kind: 'wfh' | 'field'; startsOn: string; endsOn: string; place?: string; reason?: string }>(ctx.req, ['kind', 'startsOn', 'endsOn'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'attendance.correct')) throw new HttpError(403, 'PERMISSION_DENIED', 'requesting for someone else needs attendance.correct')
      assertScope(ctx.auth, employeeId)
      const r = await requestRemote(ctx.tx, ctx.config, { employeeId, requestedByUserId: ctx.auth.userId, kind: b.kind, startsOn: asDate(b.startsOn, 'startsOn'), endsOn: asDate(b.endsOn, 'endsOn'), place: b.place, reason: b.reason })
      await emit(ctx.tx, { action: 'attendance.remote.requested', entityType: 'remote_request', entityId: r.request.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId,
        metadata: { kind: r.request.kind, startsOn: r.request.starts_on, endsOn: r.request.ends_on, status: r.request.status } })
      return created(r)
    }))

  router.post('/api/v1/attendance/remote-requests/:id/cancel',
    { summary: 'Cancel your WFH / field request', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await getRemoteRequest(ctx.tx, id)
      if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such request')
      assertScope(ctx.auth, r.employee_id)
      await cancelRemote(ctx.tx, id, r.employee_id)
      await emit(ctx.tx, { action: 'attendance.remote.cancelled', entityType: 'remote_request', entityId: id, subjectEmployeeId: r.employee_id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.get('/api/v1/attendance/visits',
    { summary: 'Field visit logs (?employeeId=&from=&to=)', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      const to = ctx.req.query.get('to') ?? localToday(ctx.config.get<string>('attendance.timezone'))
      const from = ctx.req.query.get('from') ?? new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
      return ok({ visits: await listVisits(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, from: asDate(from, 'from'), to: asDate(to, 'to') }) })
    }))

  router.post('/api/v1/attendance/visits',
    { summary: 'Start a field visit (place, contact, purpose, your location); the day is marked on duty', tag: 'attendance', permission: 'attendance.read',
      requestExample: { place: 'DAV School, Kondapur', contact: 'Principal', purpose: 'Demo of the LMS', geo: { lat: 17.46, lng: 78.36 } } },
    authed('attendance.read', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ place: string; contact?: string; purpose: string; geo?: { lat: number; lng: number }; projectId?: string; localDate?: string }>(ctx.req, ['place', 'purpose'])
      const zone = ctx.config.get<string>('attendance.timezone')
      const workDate = b.localDate ? asDate(b.localDate, 'localDate') : localToday(zone)
      // A visit marks its day on duty -- a paid day -- so it can only be logged for TODAY, and
      // only into a period that is still open. Any date used to turn an absent day into pay.
      await assertPunchWindow(ctx.tx, { employeeId: ctx.auth.employeeId, localDate: workDate, direction: 'in', timezone: zone })
      const v = await startVisit(ctx.tx, { employeeId: ctx.auth.employeeId, workDate, place: b.place, contact: b.contact, purpose: b.purpose, geo: b.geo, projectId: b.projectId ? asUuid(b.projectId, 'projectId') : null })
      await markModeOnDay(ctx.tx, { employeeId: ctx.auth.employeeId, workDate, mode: 'field', actorUserId: ctx.auth.userId, policy: dayPolicy(ctx) })
      await emit(ctx.tx, { action: 'attendance.visit.logged', entityType: 'field_visit', entityId: v.id, subjectEmployeeId: ctx.auth.employeeId, actorUserId: ctx.auth.userId, metadata: { place: v.place } })
      return created(v)
    }))

  router.post('/api/v1/attendance/visits/:id/end',
    { summary: 'End the visit with the outcome and next step', tag: 'attendance', permission: 'attendance.read',
      requestExample: { outcome: 'Agreed to a pilot with 2 sections', nextStep: 'Send proposal by Friday', geo: { lat: 17.46, lng: 78.36 } } },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ outcome: string; nextStep?: string; geo?: { lat: number; lng: number }; photoDocumentIds?: string[] }>(ctx.req, ['outcome'])
      return ok(await endVisit(ctx.tx, { visitId: asUuid(ctx.req.params.id, 'id'), employeeId: ctx.auth.employeeId, outcome: b.outcome, nextStep: b.nextStep, geo: b.geo,
        photoDocumentIds: b.photoDocumentIds?.map((d) => asUuid(d, 'photoDocumentIds')) }))
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
      const today = localToday(ctx.config.get<string>('attendance.timezone'))
      if (workDate > today) throw new HttpError(422, 'VALIDATION_FAILED', 'a regularisation is for a day that has happened')
      const windowDays = ctx.config.get<number>('attendance.correction_window_days')
      const oldest = localToday(ctx.config.get<string>('attendance.timezone'), new Date(Date.now() - windowDays * 86_400_000))
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
