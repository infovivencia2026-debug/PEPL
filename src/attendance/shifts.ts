/**
 * Shifts and rosters — see 039_shifts.sql.
 *
 * `evaluateShiftDay` is pure: schedule + punches in, late / early / OT and the
 * day fraction out. `recomputeDay` calls it when the person is rostered and
 * falls back to the company-wide policy when they are not, so a company that
 * never defines a shift sees no change.
 */
import type { PoolClient } from 'pg'
import { offsetMinutes } from '../lib/timezone.ts'

export class ShiftError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ShiftError'
  }
}

export interface Shift {
  id: string
  code: string
  name: string
  start_time: string       // 'HH:MM:SS'
  end_time: string
  grace_in_min: number
  grace_out_min: number
  break_min: number
  full_day_min: number
  half_day_min: number
  ot_after_min: number
  ot_eligible: boolean
  weekly_off_days: number[]
  status: 'active' | 'retired'
}

const COLUMNS = `id, code, name, start_time::text, end_time::text, grace_in_min, grace_out_min, break_min,
  full_day_min, half_day_min, ot_after_min, ot_eligible, weekly_off_days, status`

export interface ShiftInput {
  code: string; name: string; startTime: string; endTime: string
  graceInMin?: number; graceOutMin?: number; breakMin?: number
  fullDayMin: number; halfDayMin: number; otAfterMin?: number; otEligible?: boolean
  weeklyOffDays?: number[]
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/

function validate(i: Omit<ShiftInput, 'code'>): void {
  if (!TIME.test(i.startTime) || !TIME.test(i.endTime)) throw new ShiftError('VALIDATION_FAILED', 'startTime and endTime are HH:MM')
  if (i.startTime.slice(0, 5) === i.endTime.slice(0, 5)) throw new ShiftError('VALIDATION_FAILED', 'a shift cannot end when it starts')
  const int = (v: number | undefined, name: string, lo: number, hi: number): void => {
    if (v !== undefined && (!Number.isInteger(v) || v < lo || v > hi)) throw new ShiftError('VALIDATION_FAILED', `${name} is a whole number between ${lo} and ${hi}`)
  }
  int(i.graceInMin, 'graceInMin', 0, 120); int(i.graceOutMin, 'graceOutMin', 0, 120); int(i.breakMin, 'breakMin', 0, 240)
  int(i.fullDayMin, 'fullDayMin', 60, 960); int(i.halfDayMin, 'halfDayMin', 30, 720); int(i.otAfterMin, 'otAfterMin', 0, 240)
  if (i.halfDayMin >= i.fullDayMin) throw new ShiftError('VALIDATION_FAILED', 'halfDayMin must be less than fullDayMin')
  for (const d of i.weeklyOffDays ?? []) if (!Number.isInteger(d) || d < 0 || d > 6) throw new ShiftError('VALIDATION_FAILED', 'weeklyOffDays are 0 (Sunday) to 6')
  if (!i.name.trim() || i.name.length > 120) throw new ShiftError('VALIDATION_FAILED', 'name is 1–120 characters')
}

export async function listShifts(tx: PoolClient, opts: { includeRetired?: boolean } = {}): Promise<Shift[]> {
  const { rows } = await tx.query<Shift>(`SELECT ${COLUMNS} FROM shifts WHERE $1 OR status = 'active' ORDER BY start_time, code`, [opts.includeRetired ?? false])
  return rows
}

export async function createShift(tx: PoolClient, i: ShiftInput): Promise<Shift> {
  const code = i.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) throw new ShiftError('VALIDATION_FAILED', 'code is 1–24 characters: letters, digits, _ or -')
  validate(i)
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if ((await tx.query(`SELECT 1 FROM shifts WHERE code = $1`, [code])).rowCount) throw new ShiftError('SHIFT_EXISTS', `shift ${code} already exists`)
  const { rows } = await tx.query<Shift>(
    `INSERT INTO shifts (tenant_id, code, name, start_time, end_time, grace_in_min, grace_out_min, break_min,
                         full_day_min, half_day_min, ot_after_min, ot_eligible, weekly_off_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING ${COLUMNS}`,
    [tid, code, i.name.trim(), i.startTime, i.endTime, i.graceInMin ?? 10, i.graceOutMin ?? 0, i.breakMin ?? 60,
     i.fullDayMin, i.halfDayMin, i.otAfterMin ?? 0, i.otEligible ?? false, i.weeklyOffDays ?? [0]])
  return rows[0]!
}

/**
 * A shift's timings decide pay for every day already computed under them, so
 * they are not edited in place: retire and create the successor, then move
 * the roster. Only the name may change.
 */
export async function renameShift(tx: PoolClient, id: string, name: string): Promise<Shift> {
  if (!name.trim() || name.length > 120) throw new ShiftError('VALIDATION_FAILED', 'name is 1–120 characters')
  const { rows } = await tx.query<Shift>(`UPDATE shifts SET name = $2 WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id, name.trim()])
  if (!rows[0]) throw new ShiftError('NOT_FOUND', 'no active shift with that id')
  return rows[0]
}

export async function retireShift(tx: PoolClient, id: string, today: string): Promise<{ shift: Shift; rosteredNow: number }> {
  const { rows } = await tx.query<Shift>(`UPDATE shifts SET status = 'retired', retired_at = now() WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new ShiftError('NOT_FOUND', 'no active shift with that id')
  // Open roster rows end today; the people on them fall back to company policy until re-rostered.
  const r = await tx.query(
    `UPDATE shift_rosters SET effective_to = $2::date WHERE shift_id = $1 AND (effective_to IS NULL OR effective_to > $2::date) AND effective_from <= $2::date`, [id, today])
  await tx.query(`UPDATE shift_rosters SET effective_to = effective_from WHERE shift_id = $1 AND effective_from > $2::date AND effective_to IS NULL`, [id, today])
  return { shift: rows[0], rosteredNow: r.rowCount ?? 0 }
}

/** Puts a person on a shift from a date; closes whatever they were on the day before. No backdating into a closed period is the caller's check. */
export async function rosterEmployee(
  tx: PoolClient,
  args: { employeeId: string; shiftId: string; effectiveFrom: string; actorUserId?: string },
): Promise<{ id: string }> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const shift = await tx.query(`SELECT 1 FROM shifts WHERE id = $1 AND status = 'active'`, [args.shiftId])
  if (!shift.rowCount) throw new ShiftError('NOT_FOUND', 'no active shift with that id')
  const clash = await tx.query(`SELECT 1 FROM shift_rosters WHERE employee_id = $1 AND effective_from >= $2::date`, [args.employeeId, args.effectiveFrom])
  if (clash.rowCount) throw new ShiftError('ROSTER_NOT_AFTER_CURRENT', 'a roster entry already starts on or after that date; pick a later date')
  await tx.query(
    `UPDATE shift_rosters SET effective_to = $2::date - 1
      WHERE employee_id = $1 AND (effective_to IS NULL OR effective_to >= $2::date)`, [args.employeeId, args.effectiveFrom])
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO shift_rosters (tenant_id, employee_id, shift_id, effective_from, created_by_user_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [tid, args.employeeId, args.shiftId, args.effectiveFrom, args.actorUserId ?? null])
  return rows[0]!
}

export async function rosterHistory(tx: PoolClient, employeeId: string): Promise<{ id: string; shift_id: string; code: string; effective_from: string; effective_to: string | null }[]> {
  const { rows } = await tx.query(
    `SELECT r.id, r.shift_id, s.code, r.effective_from::text, r.effective_to::text
       FROM shift_rosters r JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id)
      WHERE r.employee_id = $1 ORDER BY r.effective_from DESC`, [employeeId])
  return rows
}

/** The shift in force for a person on a date, or null when they are not rostered. */
export async function shiftFor(tx: PoolClient, employeeId: string, workDate: string): Promise<Shift | null> {
  const { rows } = await tx.query<Shift>(
    `SELECT ${COLUMNS.replace(/\bid,/, 's.id,').replace(/\bstatus\b/, 's.status')}
       FROM shift_rosters r JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id)
      WHERE r.employee_id = $1 AND r.effective_from <= $2::date AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
      ORDER BY r.effective_from DESC LIMIT 1`, [employeeId, workDate])
  return rows[0] ?? null
}

export interface ShiftDay {
  scheduledStart: Date
  scheduledEnd: Date
  lateMinutes: number
  earlyMinutes: number
  otMinutes: number
  /** Worked minutes after the break. */
  netWorkedMinutes: number
  dayFraction: 0 | 0.5 | 1
  isWeeklyOff: boolean
}

const minutesOf = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))

/**
 * Pure. `workDate` is the local date the shift STARTS on; a night shift's
 * scheduled end is the next day. The shift's clock times are the COMPANY's
 * wall clock, so the caller passes its zone (or an offset, for a test) —
 * defaulting to India, which is where every tenant was until it was not.
 */
export function evaluateShiftDay(
  shift: Pick<Shift, 'start_time' | 'end_time' | 'grace_in_min' | 'grace_out_min' | 'break_min' | 'full_day_min' | 'half_day_min' | 'ot_after_min' | 'ot_eligible' | 'weekly_off_days'>,
  workDate: string,
  punches: { firstIn: Date | null; lastOut: Date | null },
  zoneOrOffset: string | number = 'Asia/Kolkata',
): ShiftDay {
  const tzOffsetMinutes = typeof zoneOrOffset === 'number'
    ? zoneOrOffset
    : offsetMinutes(zoneOrOffset, new Date(workDate + 'T12:00:00Z'))
  const dayStartUtc = Date.parse(workDate + 'T00:00:00Z') - tzOffsetMinutes * 60_000
  const start = minutesOf(shift.start_time), end = minutesOf(shift.end_time)
  const scheduledStart = new Date(dayStartUtc + start * 60_000)
  const scheduledEnd = new Date(dayStartUtc + (end > start ? end : end + 1440) * 60_000)
  const dow = new Date(workDate + 'T00:00:00Z').getUTCDay()
  const isWeeklyOff = shift.weekly_off_days.includes(dow)

  let late = 0, early = 0, ot = 0, net = 0
  let fraction: 0 | 0.5 | 1 = 0
  if (punches.firstIn) {
    late = Math.max(0, Math.round((punches.firstIn.getTime() - scheduledStart.getTime()) / 60_000) - shift.grace_in_min)
    if (punches.lastOut) {
      early = Math.max(0, Math.round((scheduledEnd.getTime() - punches.lastOut.getTime()) / 60_000) - shift.grace_out_min)
      const gross = Math.max(0, Math.round((punches.lastOut.getTime() - punches.firstIn.getTime()) / 60_000))
      net = Math.max(0, gross - shift.break_min)
      if (shift.ot_eligible && shift.ot_after_min > 0) {
        const beyond = Math.round((punches.lastOut.getTime() - scheduledEnd.getTime()) / 60_000)
        if (beyond >= shift.ot_after_min) ot = beyond
      }
      fraction = net >= shift.full_day_min ? 1 : net >= shift.half_day_min ? 0.5 : 0
    } else {
      // In with no out: present on the punch, hours unknown. A full day; the
      // missing out is a correction for the manager, not an absence.
      fraction = 1
    }
  }
  return { scheduledStart, scheduledEnd, lateMinutes: late, earlyMinutes: early, otMinutes: ot, netWorkedMinutes: net, dayFraction: fraction, isWeeklyOff }
}
