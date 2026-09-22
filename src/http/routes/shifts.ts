/**
 * Shifts, rosters, and the attendance→payroll summary.
 *
 * Shift definitions are company structure (`settings.write`); putting a person
 * on one is an attendance decision (`attendance.correct`, scoped). The summary
 * and freeze-from-attendance are payroll's (`payroll.process`).
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, requireModule, asUuid, asDate, assertScope, emit, freezeInputs, loadStatutory } from './deps.ts'
import { createShift, listShifts, renameShift, retireShift, rosterEmployee, rosterHistory, shiftFor, type ShiftInput } from '../../attendance/shifts.ts'
import { summarisePeriod, type SummaryPolicy } from '../../attendance/summary.ts'
import { getRun } from '../../payroll/run.ts'
import type { Ctx } from '../context.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { scopeFor } from '../../people/profile.ts'
import type { Scope } from '../../config/resolver.ts'

/** Settings resolved against each person's department / location / grade — the scoped overrides finally apply. */
export function summaryPolicy(ctx: Ctx): (employeeId: string) => Promise<SummaryPolicy> {
  return async (employeeId) => {
    const scope = await scopeFor(ctx.tx, employeeId)
    return {
      unmarkedDayIsLop: ctx.config.get<boolean>('attendance.unmarked_day_is_lop', scope),
      lateMarksPerHalfDay: ctx.config.get<number>('attendance.late_marks_per_half_day', scope),
      weekPattern: ctx.config.get<SummaryPolicy['weekPattern']>('attendance.week_pattern', scope),
      defaultStateCode: ctx.config.get<string>('payroll.pt_state_code'),
      otRequiresApproval: ctx.config.get<boolean>('payroll.ot_requires_approval'),
    }
  }
}

/**
 * Overtime pay, frozen as a VALUE on the row like everything else the engine
 * reads. Hourly rate is basic over 208 hours (26 days × 8); the multiplier is
 * the company's setting. None: the minutes are recorded and nothing is paid.
 */
function otAdhoc(ctx: Ctx, row: { otMinutes?: number; monthlyComponents: Record<string, number> }, scope: Scope): { code: string; amountPaise: number }[] {
  const mode = ctx.config.get<'none' | 'single' | 'double'>('payroll.ot_pay', scope)
  const minutes = row.otMinutes ?? 0
  if (mode === 'none' || minutes <= 0) return []
  const basic = row.monthlyComponents.BASIC ?? row.monthlyComponents.basic ?? 0
  const hourly = basic / 208
  const amount = Math.round(hourly * (minutes / 60) * (mode === 'double' ? 2 : 1))
  return amount > 0 ? [{ code: 'OT', amountPaise: amount }] : []
}

async function periodOf(ctx: Ctx, periodId: string): Promise<{ period_start: string; period_end: string }> {
  const { rows } = await ctx.tx.query<{ period_start: string; period_end: string }>(
    `SELECT period_start::text, period_end::text FROM payroll_periods WHERE id = $1`, [periodId])
  if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such payroll period')
  return rows[0]
}

export function register(router: Router): void {
  router.get('/api/v1/shifts',
    { summary: 'Shift definitions; ?includeRetired=true for history', tag: 'attendance' },
    authed(null, async (ctx) => ok({ shifts: await listShifts(ctx.tx, { includeRetired: ctx.req.query.get('includeRetired') === 'true' }) })))

  router.post('/api/v1/shifts',
    { summary: 'Define a shift (timings are immutable afterwards: retire and create a successor)', tag: 'attendance',
      permission: 'settings.write',
      requestExample: { code: 'GEN', name: 'General', startTime: '09:30', endTime: '18:30', graceInMin: 15, breakMin: 60,
        fullDayMin: 480, halfDayMin: 240, otAfterMin: 30, otEligible: false, weeklyOffDays: [0] } },
    authed('settings.write', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const b = requireBody<Record<string, unknown> & ShiftInput>(ctx.req, ['code', 'name', 'startTime', 'endTime', 'fullDayMin', 'halfDayMin'])
      const shift = await createShift(ctx.tx, b)
      await emit(ctx.tx, { action: 'attendance.shift.changed', entityType: 'shift', entityId: shift.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', code: shift.code } })
      return created({ shift })
    }))

  router.patch('/api/v1/shifts/:id',
    { summary: 'Rename a shift (only the name can change)', tag: 'attendance', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ name: string }>(ctx.req, ['name'])
      return ok({ shift: await renameShift(ctx.tx, asUuid(ctx.req.params.id, 'id'), String(b.name)) })
    }))

  router.post('/api/v1/shifts/:id/retire',
    { summary: 'Retire a shift; people on it fall back to company policy until re-rostered', tag: 'attendance',
      permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await retireShift(ctx.tx, id, localToday(ctx.config.get<string>('attendance.timezone')))
      await emit(ctx.tx, { action: 'attendance.shift.changed', entityType: 'shift', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', code: r.shift.code, rosteredNow: r.rosteredNow } })
      return ok(r)
    }))

  router.get('/api/v1/employees/:id/roster',
    { summary: 'A person\'s shift history and the shift in force today', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      return ok({ current: await shiftFor(ctx.tx, id, localToday(ctx.config.get<string>('attendance.timezone'))), history: await rosterHistory(ctx.tx, id) })
    }))

  router.post('/api/v1/employees/:id/roster',
    { summary: 'Put a person on a shift from a date', tag: 'attendance', permission: 'attendance.correct',
      requestExample: { shiftId: '…', effectiveFrom: '2026-10-01' } },
    authed('attendance.correct', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const b = requireBody<{ shiftId: string; effectiveFrom: string }>(ctx.req, ['shiftId', 'effectiveFrom'])
      const r = await rosterEmployee(ctx.tx, {
        employeeId: id, shiftId: asUuid(b.shiftId, 'shiftId'), effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'), actorUserId: ctx.auth.userId,
      })
      await emit(ctx.tx, { action: 'attendance.shift.changed', entityType: 'employee', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: id, metadata: { op: 'roster', shiftId: b.shiftId, effectiveFrom: b.effectiveFrom } })
      return created(r)
    }))

  router.get('/api/v1/attendance/summary',
    { summary: 'Per-employee payable/LOP/OT for a payroll period, as freeze-ready rows with warnings',
      tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'attendance.enabled')
      const periodId = asUuid(ctx.req.query.get('periodId'), 'periodId')
      const p = await periodOf(ctx, periodId)
      const summary = await summarisePeriod(ctx.tx, { periodStart: p.period_start, periodEnd: p.period_end, policy: summaryPolicy(ctx) })
      return ok({ period: p, employees: summary.map((s) => ({ ...s, row: s.row ? { ...s.row, annualCtcPaise: String(s.row.annualCtcPaise) } : null })) })
    }))

  router.post('/api/v1/payroll/runs/:id/freeze-from-attendance',
    { summary: 'Freeze the run from attendance and compensation, with optional per-employee overrides', tag: 'payroll',
      permission: 'payroll.process',
      requestExample: { overrides: [{ employeeId: '…', payableDays: 28, lopDays: 2 }], skipEmployeeIds: [] } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const runId = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ overrides?: { employeeId: string; payableDays?: number; lopDays?: number; otMinutes?: number }[]; skipEmployeeIds?: string[] }>(ctx.req, [])
      const run = await getRun(ctx.tx, runId)
      const p = await periodOf(ctx, run.period_id)
      const summary = await summarisePeriod(ctx.tx, { periodStart: p.period_start, periodEnd: p.period_end, policy: summaryPolicy(ctx) })
      const skip = new Set((b.skipEmployeeIds ?? []).map((s) => asUuid(s, 'skipEmployeeIds')))
      const over = new Map((b.overrides ?? []).map((o) => [asUuid(o.employeeId, 'overrides.employeeId'), o]))

      const missing = summary.filter((s) => !s.row && !skip.has(s.employeeId))
      if (missing.length) {
        throw new HttpError(422, 'NO_COMPENSATION', `${missing.length} employee(s) have no salary structure in force`,
          { employees: missing.map((m) => ({ employeeId: m.employeeId, employeeNumber: m.employeeNumber })) })
      }
      const rows: (typeof summary[number]['row'] & { adhoc?: { code: string; amountPaise: number }[] })[] = []
      for (const s of summary) {
        if (!s.row || skip.has(s.employeeId)) continue
        const o = over.get(s.employeeId)
        const row = { ...s.row }
        if (o?.payableDays !== undefined) row.payableDays = o.payableDays
        if (o?.lopDays !== undefined) row.lopDays = o.lopDays
        if (o?.otMinutes !== undefined) row.otMinutes = o.otMinutes
        if (row.payableDays + row.lopDays > row.calendarDays + 0.001) {
          throw new HttpError(422, 'VALIDATION_FAILED', `${s.employeeNumber}: payable plus LOP exceeds the calendar days`)
        }
        // Overtime is paid as a frozen line, from the minutes attendance recorded.
        const ot = otAdhoc(ctx, row, await scopeFor(ctx.tx, s.employeeId))
        rows.push(ot.length ? { ...row, adhoc: ot } : row)
      }
      const statutory = await loadStatutory(ctx.tx, p.period_end)
      const divisor = ctx.config.get<number>('payroll.exit_day_divisor')
      const frozen = await freezeInputs(ctx.tx, runId, rows, {
        lop_basis: ctx.config.get('payroll.lop_basis'), pf_on_full_wage: ctx.config.get('payroll.pf_on_full_wage'),
        exit_day_divisor: divisor, source: 'attendance',
      }, statutory.id, { settlement: { encashmentDivisor: divisor, noticeDivisor: divisor } })
      return ok({ frozen, skipped: skip.size, overridden: over.size, warnings: summary.flatMap((s) => s.warnings.map((w) => `${s.employeeNumber}: ${w}`)) })
    }))
}
