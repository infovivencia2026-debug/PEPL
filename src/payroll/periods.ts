/**
 * Periods: the calendar payroll and attendance run on.
 *
 * A payroll period is a month with a pay date; an attendance period is the
 * same month with a status (open → closed → frozen) that gates corrections.
 * Both used to exist only because the demo seed inserted them, so a real
 * company could never run its first payroll. Now HR can create them, and the
 * scheduler creates next month's a few days early so nobody has to remember.
 *
 * Calendar months only. Non-calendar cycles (26th to 25th) are a real thing
 * in India, but they change how days are counted everywhere downstream;
 * that is a setting to add deliberately, not an accident of a free date field.
 */
import type { PoolClient } from 'pg'

export class PeriodError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'PeriodError' }
}

export interface PayrollPeriod {
  id: string
  label: string
  period_start: string
  period_end: string
  pay_date: string
  /** Derived: the run in this period, if any. */
  run_id: string | null
  run_status: string | null
}

export interface AttendancePeriod {
  id: string
  period_start: string
  period_end: string
  status: string
  closed_at: string | null
}

/** 'YYYY-MM' → first day, last day, label. */
export function monthBounds(month: string): { start: string; end: string; label: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month)
  if (!m) throw new PeriodError('VALIDATION_FAILED', 'month must be YYYY-MM')
  const y = Number(m[1]); const mo = Number(m[2])
  if (mo < 1 || mo > 12) throw new PeriodError('VALIDATION_FAILED', 'month must be 01–12')
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate()
  return { start: `${month}-01`, end: `${month}-${String(last).padStart(2, '0')}`, label: month }
}

/** The pay date for a month: `payDay` of the following month (0 = last day of the month itself). */
export function payDateFor(month: string, payDay: number): string {
  const { end } = monthBounds(month)
  if (payDay <= 0) return end
  const m = /^(\d{4})-(\d{2})$/.exec(month)!
  const y = Number(m[1]); const mo = Number(m[2])   // next month is mo+1 (Date.UTC handles 13 → Jan)
  const lastOfNext = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate()
  const d = new Date(Date.UTC(y, mo, Math.min(payDay, lastOfNext)))
  return d.toISOString().slice(0, 10)
}

export async function listPayrollPeriods(tx: PoolClient, limit = 36): Promise<PayrollPeriod[]> {
  const { rows } = await tx.query<PayrollPeriod>(
    `SELECT p.id, p.label, p.period_start::text, p.period_end::text, p.pay_date::text,
            r.id AS run_id, r.status::text AS run_status
       FROM payroll_periods p
       LEFT JOIN LATERAL (
         SELECT id, status FROM payroll_runs WHERE period_id = p.id ORDER BY id DESC LIMIT 1) r ON true
      ORDER BY p.period_start DESC LIMIT $1`, [limit])
  return rows
}

/**
 * Creates the payroll period and the matching attendance period for a month.
 * Idempotent: an existing month is returned as-is, so the job and a button
 * pressed on the same day agree.
 */
export async function ensurePeriod(
  tx: PoolClient, args: { month: string; payDay: number; payDate?: string },
): Promise<{ payroll: PayrollPeriod; attendance: AttendancePeriod; created: boolean }> {
  const { start, end, label } = monthBounds(args.month)
  const tid = (await tx.query<{ t: string }>(`SELECT current_tenant()::text AS t`)).rows[0]!.t
  const payDate = args.payDate ?? payDateFor(args.month, args.payDay)
  if (payDate < end) throw new PeriodError('VALIDATION_FAILED', 'pay date cannot be before the period ends')

  const ins = await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, label) DO NOTHING RETURNING id`,
    [tid, label, start, end, payDate])
  await tx.query(
    `INSERT INTO attendance_periods (tenant_id, period_start, period_end, status)
     VALUES ($1,$2,$3,'open') ON CONFLICT (tenant_id, period_start) DO NOTHING`, [tid, start, end])

  const payroll = (await tx.query<PayrollPeriod>(
    `SELECT id, label, period_start::text, period_end::text, pay_date::text, NULL::uuid AS run_id, NULL::text AS run_status
       FROM payroll_periods WHERE label = $1`, [label])).rows[0]!
  const attendance = (await tx.query<AttendancePeriod>(
    `SELECT id, period_start::text, period_end::text, status, closed_at::text FROM attendance_periods WHERE period_start = $1`, [start])).rows[0]!
  return { payroll, attendance, created: (ins.rowCount ?? 0) > 0 }
}

/** Pay date can move (a holiday); the month itself cannot once a run exists. */
export async function updatePayDate(tx: PoolClient, id: string, payDate: string): Promise<PayrollPeriod> {
  const { rows } = await tx.query<{ period_end: string; locked: boolean }>(
    `SELECT p.period_end::text, EXISTS (SELECT 1 FROM payroll_runs r WHERE r.period_id = p.id AND r.status = 'locked') AS locked
       FROM payroll_periods p WHERE p.id = $1`, [id])
  if (!rows[0]) throw new PeriodError('PERIOD_NOT_FOUND', 'no such payroll period')
  if (rows[0].locked) throw new PeriodError('PERIOD_LOCKED', 'this period has a locked run; its pay date is history')
  if (payDate < rows[0].period_end) throw new PeriodError('VALIDATION_FAILED', 'pay date cannot be before the period ends')
  await tx.query(`UPDATE payroll_periods SET pay_date = $2 WHERE id = $1`, [id, payDate])
  return (await listPayrollPeriods(tx, 1000)).find((p) => p.id === id)!
}

/** A period with no run can be removed; one with a run is history. */
export async function deletePeriod(tx: PoolClient, id: string): Promise<void> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM payroll_runs WHERE period_id = $1`, [id])
  if (Number(rows[0]!.n) > 0) throw new PeriodError('PERIOD_IN_USE', 'a period with a payroll run cannot be deleted')
  const { rowCount } = await tx.query(`DELETE FROM payroll_periods WHERE id = $1`, [id])
  if (!rowCount) throw new PeriodError('PERIOD_NOT_FOUND', 'no such payroll period')
}

/** The month the job should make sure exists: next month once we are within `daysAhead` of it. */
export function upcomingMonth(today: Date, daysAhead: number): string {
  const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()))
  d.setUTCDate(d.getUTCDate() + daysAhead)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
}
