/** Roster planning, shift swaps, optional holidays, overtime pre-approval. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, assertScope, can, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { planDays, applyPattern, rosterGrid, shortages, proposeSwap, respondSwap, listSwaps, pickOptionalHoliday, unpickOptionalHoliday, optionalHolidayPicks, requestOt, listOt } from '../../attendance/roster.ts'

export function register(router: Router): void {
  router.get('/api/v1/roster',
    { summary: 'Roster grid for a range (?from=&to=&employeeId=): one cell per employee-day with shift code, off flag and where it came from', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      const from = asDate(ctx.req.query.get('from'), 'from'), to = asDate(ctx.req.query.get('to'), 'to')
      return ok({ from, to, rows: await rosterGrid(ctx.tx, { from, to, employeeIds: employeeId ? [employeeId] : scopeIds(ctx), weekPattern: ctx.config.get<string>('attendance.week_pattern') }) })
    }))

  router.post('/api/v1/roster/plan',
    { summary: 'Plan specific days for one person: a shift or an off per date (upsert)', tag: 'attendance', permission: 'attendance.correct',
      requestExample: { employeeId: '…', days: [{ date: '2026-10-06', shiftId: '…' }, { date: '2026-10-07', shiftId: null, off: true }] } },
    authed('attendance.correct', async (ctx) => {
      const b = requireBody<{ employeeId: string; days: Array<{ date: string; shiftId: string | null; off?: boolean }> }>(ctx.req, ['employeeId', 'days'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      assertScope(ctx.auth, employeeId)
      const days = (Array.isArray(b.days) ? b.days : []).map((d) => ({ date: asDate(d.date, 'date'), shiftId: d.shiftId ? asUuid(d.shiftId, 'shiftId') : null, off: d.off }))
      const n = await planDays(ctx.tx, { employeeId, days, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'roster.planned', entityType: 'roster', subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { days: n } })
      return ok({ planned: n })
    }))

  router.post('/api/v1/roster/pattern',
    { summary: 'Apply a rotation to several people: cycle of shift codes / OFF from a date, staggered so offs rotate', tag: 'attendance', permission: 'attendance.correct',
      requestExample: { employeeIds: ['…', '…'], from: '2026-10-01', to: '2026-10-31', cycle: ['A', 'A', 'A', 'A', 'A', 'A', 'OFF'], stagger: 1 } },
    authed('attendance.correct', async (ctx) => {
      const b = requireBody<{ employeeIds: string[]; from: string; to: string; cycle: string[]; stagger?: number }>(ctx.req, ['employeeIds', 'from', 'to', 'cycle'])
      const ids = (Array.isArray(b.employeeIds) ? b.employeeIds : []).map((x) => asUuid(x, 'employeeIds'))
      for (const id of ids) assertScope(ctx.auth, id)
      const r = await applyPattern(ctx.tx, { employeeIds: ids, from: asDate(b.from, 'from'), to: asDate(b.to, 'to'), cycle: b.cycle, stagger: b.stagger === undefined ? 0 : asInt(b.stagger, 'stagger', { min: 0, max: 31 }), actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'roster.planned', entityType: 'roster', actorUserId: ctx.auth.userId, metadata: { ...r, cycle: b.cycle } })
      return ok(r)
    }))

  router.get('/api/v1/roster/shortages', { summary: 'Shifts under their minimum headcount (?from=&to=)', tag: 'attendance', permission: 'attendance.correct' },
    authed('attendance.correct', async (ctx) => {
      const from = ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : localToday(ctx.config.get<string>('attendance.timezone'))
      const to = ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : new Date(Date.parse(from) + 7 * 86_400_000).toISOString().slice(0, 10)
      return ok({ shortages: await shortages(ctx.tx, { from, to }) })
    }))

  // ── swaps ──
  router.get('/api/v1/roster/swaps', { summary: 'Shift swaps you may see (?status=)', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => ok({ swaps: await listSwaps(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: ctx.auth.scope === 'self' ? ctx.auth.employeeId ?? undefined : undefined, status: ctx.req.query.get('status') ?? undefined }) })))

  router.post('/api/v1/roster/swaps',
    { summary: 'Propose swapping your shift with a colleague on a date', tag: 'attendance', permission: 'attendance.read', requestExample: { counterpartEmployeeId: '…', date: '2026-10-12', reason: 'Family function' } },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ counterpartEmployeeId: string; date: string; reason?: string }>(ctx.req, ['counterpartEmployeeId', 'date'])
      const s = await proposeSwap(ctx.tx, { requesterEmployeeId: ctx.auth.employeeId, counterpartEmployeeId: asUuid(b.counterpartEmployeeId, 'counterpartEmployeeId'), date: asDate(b.date, 'date'), reason: b.reason, requestedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'roster.swap.proposed', entityType: 'shift_swap', entityId: s.id, subjectEmployeeId: ctx.auth.employeeId, actorUserId: ctx.auth.userId, metadata: { date: s.work_date } })
      return created(s)
    }))

  router.post('/api/v1/roster/swaps/:id/respond',
    { summary: 'The colleague accepts or declines; acceptance goes to the manager unless the company skips approval', tag: 'attendance', permission: 'attendance.read', requestExample: { accept: true } },
    authed('attendance.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ accept: boolean }>(ctx.req, ['accept'])
      return ok(await respondSwap(ctx.tx, ctx.config, { swapId: asUuid(ctx.req.params.id, 'id'), counterpartEmployeeId: ctx.auth.employeeId, accept: b.accept === true, userId: ctx.auth.userId }))
    }))

  // ── optional holidays ──
  router.get('/api/v1/holidays/optional/picks', { summary: 'My optional-holiday picks for a year (?year=)', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const year = ctx.req.query.get('year') ?? new Date().getFullYear().toString()
      return ok({ picks: [...(await optionalHolidayPicks(ctx.tx, ctx.auth.employeeId, `${year}-01-01`, `${year}-12-31`))], allowed: ctx.config.get<number>('leave.optional_holidays_allowed') })
    }))

  router.post('/api/v1/holidays/optional/picks', { summary: 'Pick an optional holiday (within the yearly allowance)', tag: 'leave', permission: 'leave.read', requestExample: { holidayId: '…' } },
    authed('leave.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      const b = requireBody<{ holidayId: string }>(ctx.req, ['holidayId'])
      const r = await pickOptionalHoliday(ctx.tx, ctx.config, { employeeId: ctx.auth.employeeId, holidayId: asUuid(b.holidayId, 'holidayId') })
      await emit(ctx.tx, { action: 'leave.optional_holiday.picked', entityType: 'holiday', entityId: b.holidayId, subjectEmployeeId: ctx.auth.employeeId, actorUserId: ctx.auth.userId })
      return created(r)
    }))

  router.post('/api/v1/holidays/optional/picks/:holidayId/remove', { summary: 'Drop an upcoming optional-holiday pick', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      await unpickOptionalHoliday(ctx.tx, { employeeId: ctx.auth.employeeId, holidayId: asUuid(ctx.req.params.holidayId, 'holidayId') })
      return noContent()
    }))

  // ── overtime pre-approval ──
  router.get('/api/v1/attendance/overtime', { summary: 'Overtime requests (?employeeId=&from=&to=&status=)', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ requests: await listOt(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, from: ctx.req.query.get('from') ?? undefined, to: ctx.req.query.get('to') ?? undefined, status: ctx.req.query.get('status') ?? undefined }) })
    }))

  router.post('/api/v1/attendance/overtime',
    { summary: 'Request overtime for a day in advance (needed for pay when payroll.ot_requires_approval is on)', tag: 'attendance', permission: 'attendance.read',
      requestExample: { date: '2026-10-14', minutes: 120, reason: 'Month-end dispatch' } },
    authed('attendance.read', async (ctx) => {
      const b = requireBody<{ employeeId?: string; date: string; minutes: number; reason?: string }>(ctx.req, ['date', 'minutes'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'attendance.correct')) throw new HttpError(403, 'PERMISSION_DENIED', 'requesting for someone else needs attendance.correct')
      assertScope(ctx.auth, employeeId)
      const r = await requestOt(ctx.tx, ctx.config, { employeeId, date: asDate(b.date, 'date'), minutes: asInt(b.minutes, 'minutes', { min: 15, max: 720 }), reason: b.reason, requestedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'attendance.ot.requested', entityType: 'ot_request', entityId: r.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { date: r.work_date, minutes: r.minutes, status: r.status } })
      return created(r)
    }))
}
