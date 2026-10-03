/**
 * Applying for leave and settling the decision — ONE implementation.
 *
 * There used to be two: the domain route counted working days with the
 * holiday calendar and sandwich rule; the console route counted calendar
 * days, charged weekends, and on approval marked Saturday and Sunday as
 * leave in attendance, which payroll then read. Both routes now call this.
 *
 * The approval path also had gaps depending on which door you came through:
 * one never marked attendance, one never wrote "rejected", one notified the
 * approver instead of the applicant. Settling is here, once, for all of them.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { countLeaveDays, holidaysBetween } from './days.ts'
import { balance, consume } from './ledger.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import { applyCorrection } from '../attendance/index.ts'
import { notify } from '../comms/index.ts'

export class LeaveApplyError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>
  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message); this.code = code; this.status = status; this.details = details; this.name = 'LeaveApplyError'
  }
}

type WeekPattern = 'five_day' | 'six_day' | 'alternate_saturday' | 'roster'

/** The leave year a date falls in, given the month the cycle starts. */
export function leaveCycleYear(date: string, cycleStartMonth: number): number {
  const y = Number(date.slice(0, 4)); const m = Number(date.slice(5, 7))
  return m >= cycleStartMonth ? y : y - 1
}

export interface ApplyInput {
  employeeId: string
  requestedByUserId: string
  leaveTypeId: string
  startDate: string
  endDate: string
  dayParts?: Record<string, string>
  reason?: string | null
  /** What the applicant was shown; a mismatch is an error, never a silent correction. */
  totalDays?: number
}

export async function applyLeave(
  tx: PoolClient, cfg: ResolvedConfig, input: ApplyInput,
): Promise<{ id: string; totalDays: number; skipped: { date: string; reason: string; charged: boolean }[]; approvalRequestId: string; chain: string }> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { startDate, endDate } = input
  if (endDate < startDate) throw new LeaveApplyError(422, 'VALIDATION_FAILED', 'end date is before start date')

  const cycleStart = cfg.get<number>('leave.cycle_start_month')
  if (leaveCycleYear(startDate, cycleStart) !== leaveCycleYear(endDate, cycleStart)) {
    throw new LeaveApplyError(422, 'LEAVE_SPANS_CYCLES', 'submit separate requests for each leave year')
  }
  const today = (await tx.query<{ d: string }>('SELECT CURRENT_DATE::text AS d')).rows[0]!.d
  const backdays = (Date.parse(today) - Date.parse(startDate)) / 86_400_000
  if (backdays > cfg.get<number>('leave.backdating_limit_days')) {
    throw new LeaveApplyError(422, 'LEAVE_BACKDATED', `this company allows leave to be applied up to ${cfg.get<number>('leave.backdating_limit_days')} days after the fact`)
  }
  const type = await tx.query(`SELECT 1 FROM leave_types WHERE id = $1 AND status = 'active'`, [input.leaveTypeId])
  if (!type.rowCount) throw new LeaveApplyError(422, 'LEAVE_TYPE_INACTIVE', 'choose an active leave type')

  // Working days only, with the holiday calendar and the sandwich rule.
  const counted = countLeaveDays({
    startDate, endDate, dayParts: input.dayParts,
    weekPattern: cfg.get<WeekPattern>('attendance.week_pattern'),
    holidays: await holidaysBetween(tx, { startDate, endDate }),
    sandwich: cfg.get<boolean>('leave.sandwich_holidays'),
  })
  if (counted.totalDays <= 0) throw new LeaveApplyError(422, 'LEAVE_NO_WORKING_DAYS', 'that range has no working days', { skipped: counted.skipped })
  if (input.totalDays !== undefined && Math.abs(Number(input.totalDays) - counted.totalDays) > 1e-9) {
    throw new LeaveApplyError(422, 'LEAVE_DAYS_MISMATCH', `this request is ${counted.totalDays} day(s), not ${input.totalDays}`,
      { counted: counted.totalDays, sent: input.totalDays, skipped: counted.skipped })
  }
  const minUnit = cfg.get<'full_day' | 'half_day' | 'hourly'>('leave.min_unit')
  const step = minUnit === 'full_day' ? 1 : minUnit === 'half_day' ? 0.5 : 0.125
  if (Math.abs(Math.round(counted.totalDays / step) * step - counted.totalDays) > 1e-9) {
    throw new LeaveApplyError(422, 'LEAVE_UNIT_NOT_ALLOWED',
      minUnit === 'full_day' ? 'this company allows whole days of leave only' : `leave must be applied for in multiples of ${step} of a day`, { minUnit })
  }

  // Serialise per employee so two overlapping requests cannot both slip through.
  await tx.query(`SELECT id FROM employees WHERE id = $1 FOR UPDATE`, [input.employeeId])
  const overlap = await tx.query(
    `SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2`,
    [input.employeeId, startDate, endDate])
  if (overlap.rowCount) throw new LeaveApplyError(409, 'LEAVE_OVERLAP', 'a request already covers part of these dates')

  // The balance, as approval will judge it -- the same ledger and the same company setting -- checked
  // now rather than after the whole chain has spent its time. Requests still PENDING for this type and
  // leave year are already spoken for (approved ones are in the ledger), so two requests that each fit
  // alone cannot together overdraw. Taken under the employee lock above, so they cannot race.
  if (!cfg.get<boolean>('leave.allow_negative_balance')) {
    const year = leaveCycleYear(startDate, cycleStart)
    const bal = await balance(tx, input.employeeId, input.leaveTypeId, year)
    const pendingDays = (await tx.query<{ start_date: string; total_days: string }>(
      `SELECT start_date::text, total_days::text FROM leave_requests
        WHERE employee_id = $1 AND leave_type_id = $2 AND status = 'pending'`, [input.employeeId, input.leaveTypeId])).rows
      .filter((r) => leaveCycleYear(r.start_date, cycleStart) === year)
      .reduce((n, r) => n + Number(r.total_days), 0)
    const available = bal.available - pendingDays
    if (available < counted.totalDays) {
      throw new LeaveApplyError(422, 'INSUFFICIENT_BALANCE',
        `you have ${Math.max(0, available)} day(s) available for this leave type; ${counted.totalDays} requested`,
        { available: Math.max(0, available), requested: counted.totalDays })
    }
  }

  // day_parts records exactly the days charged, so approval marks those and only those.
  const dayParts: Record<string, string> = {}
  for (const d of counted.workingDays) dayParts[d] = input.dayParts?.[d] ?? 'full'

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO leave_requests (tenant_id, employee_id, leave_type_id, start_date, end_date, day_parts, total_days, reason)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
    [tid, input.employeeId, input.leaveTypeId, startDate, endDate, JSON.stringify(dayParts), counted.totalDays, input.reason?.slice(0, 2000) ?? null])
  const id = rows[0]!.id

  const approval = await raiseWithPolicy(tx, {
    entityType: 'leave', entityId: id, requestedByUserId: input.requestedByUserId,
    subjectEmployeeId: input.employeeId, magnitude: counted.totalDays,
    fallback: cfg.get<string>('leave.approval_chain') as never,
    title: `Leave · ${counted.totalDays} day(s) from ${startDate}`,
  })
  return { id, totalDays: counted.totalDays, skipped: counted.skipped, approvalRequestId: approval.requestId, chain: approval.chainCode }
}

/**
 * The consequences of a leave decision, once the approval engine has decided.
 * Approved: balance consumed for the leave year, request marked, each CHARGED
 * day marked in attendance, applicant told. Rejected: request marked, applicant
 * told. Idempotent — a request already in a final state is left alone.
 */
export async function settleLeaveDecision(
  tx: PoolClient, cfg: ResolvedConfig,
  args: { leaveRequestId: string; status: 'approved' | 'rejected'; actorUserId: string; requestedByUserId?: string | null },
): Promise<{ changed: boolean }> {
  const { rows } = await tx.query<{
    employee_id: string; leave_type_id: string; start_date: string; end_date: string; total_days: string; status: string
    day_parts: Record<string, string>
  }>(
    `SELECT employee_id, leave_type_id, start_date::text, end_date::text, total_days::text, status, day_parts
       FROM leave_requests WHERE id = $1 FOR UPDATE`, [args.leaveRequestId])
  const leave = rows[0]
  if (!leave) throw new LeaveApplyError(404, 'NOT_FOUND', 'no such leave request')
  if (leave.status !== 'pending') return { changed: false }

  if (args.status === 'approved') {
    const closed = await tx.query(
      `SELECT 1 FROM attendance_periods WHERE status IN ('closed','frozen') AND period_start <= $2 AND period_end >= $1`,
      [leave.start_date, leave.end_date])
    if (closed.rowCount) throw new LeaveApplyError(409, 'PERIOD_CLOSED', 'this leave falls in a closed attendance period; reopen it before approving')

    await tx.query(`SELECT id FROM employees WHERE id = $1 FOR UPDATE`, [leave.employee_id])
    await consume(tx, {
      employeeId: leave.employee_id, leaveTypeId: leave.leave_type_id,
      cycleYear: leaveCycleYear(leave.start_date, cfg.get<number>('leave.cycle_start_month')),
      days: Number(leave.total_days), effectiveDate: leave.start_date, requestId: args.leaveRequestId,
      allowNegative: cfg.get<boolean>('leave.allow_negative_balance'),
    })
    // Only the days that were charged — never a weekend or holiday in the range.
    const charged: [string, string][] = Object.keys(leave.day_parts ?? {}).length ? Object.entries(leave.day_parts) : [[leave.start_date, 'full']]
    // `dayFraction` is the PAID share of the day. A leave type that is not paid (leave without pay)
    // used to be marked 1 like any other, so unpaid leave came out of the freeze as a paid day:
    // is_paid was read by nothing downstream. Unpaid, a full day pays nothing and half a day pays
    // the half that was worked.
    const paid = (await tx.query<{ is_paid: boolean }>(`SELECT is_paid FROM leave_types WHERE id = $1`, [leave.leave_type_id])).rows[0]?.is_paid !== false
    for (const [workDate, part] of charged) {
      await applyCorrection(tx, {
        employeeId: leave.employee_id, workDate, action: 'mark_leave',
        after: { dayFraction: part === 'full' ? (paid ? 1 : 0) : 0.5, leaveRequestId: args.leaveRequestId },
        reason: 'approved leave request', actorUserId: args.actorUserId,
      })
    }
  }
  await tx.query(`UPDATE leave_requests SET status = $2, decided_at = now() WHERE id = $1`, [args.leaveRequestId, args.status])

  // The applicant is the one waiting.
  const applicant = args.requestedByUserId
    ?? (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [leave.employee_id])).rows[0]?.id
  if (applicant) {
    await notify(tx, {
      userId: applicant, eventType: `leave.${args.status}`,
      title: args.status === 'approved' ? 'Leave approved' : 'Leave not approved',
      body: `${leave.total_days} day(s) from ${leave.start_date}`,
      entityType: 'leave', entityId: args.leaveRequestId, dedupeKey: `leave-${args.status}:${args.leaveRequestId}`,
    })
  }
  return { changed: true }
}
