/**
 * Compensatory off: a day worked on a weekly off or holiday earns a day of
 * leave. The credit lands on the CO leave type in the ledger — so it is spent
 * through the ordinary leave request, shows in balances, and reverses on
 * cancellation like any other leave — and is tracked per worked date in
 * comp_off_credits so it can expire.
 *
 * Credits are granted by a nightly job from the muster (present on an
 * off-day, at least half a day), or by HR for a date the muster missed.
 * An expired credit lapses from the ledger; a consumed one does not.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { appendEntry, creditCompOff } from './ledger.ts'
import { leaveCycleYear } from './apply.ts'
import { isWeeklyOff } from '../attendance/index.ts'

export class CompOffError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'CompOffError' }
}

async function coType(tx: PoolClient): Promise<string | null> {
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM leave_types WHERE code = 'CO' AND status = 'active'`)
  return rows[0]?.id ?? null
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}

/**
 * Credit one worked off-day. `days` is 1 or 0.5. Idempotent per (employee,
 * date): the ledger key and the credits table both refuse a second grant.
 */
export async function grantCompOff(
  tx: PoolClient, cfg: ResolvedConfig,
  args: { employeeId: string; workDate: string; days: 0.5 | 1; actorUserId?: string; note?: string },
): Promise<{ granted: boolean; expiresOn: string }> {
  const typeId = await coType(tx)
  if (!typeId) throw new CompOffError('NO_CO_LEAVE_TYPE', 'this company has no Compensatory Off (CO) leave type')
  const expiresOn = addDays(args.workDate, cfg.get<number>('leave.comp_off_expiry_days'))
  const fresh = await creditCompOff(tx, { employeeId: args.employeeId, workDate: args.workDate, expiresOn })
  if (!fresh) return { granted: false, expiresOn }
  await appendEntry(tx, {
    employeeId: args.employeeId, leaveTypeId: typeId, entryType: 'accrual', deltaDays: args.days,
    effectiveDate: args.workDate, cycleYear: leaveCycleYear(args.workDate, cfg.get<number>('leave.cycle_start_month')),
    sourceType: 'comp_off', idempotencyKey: `compoff:${args.employeeId}:${args.workDate}`,
    note: args.note ?? `worked on ${args.workDate} (off day)`, actorUserId: args.actorUserId,
  })
  if (args.days === 0.5) await tx.query(`UPDATE comp_off_credits SET status = 'available_half' WHERE employee_id = $1 AND work_date = $2`, [args.employeeId, args.workDate])
  return { granted: true, expiresOn }
}

/**
 * The nightly pass: every present day on a weekly off or holiday in the
 * window that has no credit yet. Half a day when the person worked less than
 * the company's half-day hours. Returns the number of credits granted.
 */
export async function creditFromMuster(
  tx: PoolClient, cfg: ResolvedConfig, args: { from: string; to: string },
): Promise<number> {
  if (!cfg.isEnabled('leave.comp_off_enabled')) return 0
  const typeId = await coType(tx)
  if (!typeId) return 0
  const halfDayHours = cfg.get<number>('attendance.half_day_hours')
  const pattern = cfg.get<'five_day' | 'six_day' | 'alternate_saturday' | 'roster'>('attendance.week_pattern')
  const { rows: holidays } = await tx.query<{ d: string }>(
    `SELECT holiday_on::text AS d FROM holidays WHERE holiday_on BETWEEN $1::date AND $2::date AND NOT is_optional AND location IS NULL`, [args.from, args.to])
  const holidaySet = new Set(holidays.map((h) => h.d))
  const { rows } = await tx.query<{ employee_id: string; work_date: string; worked_minutes: number; shift_off: number[] | null }>(
    `SELECT d.employee_id, d.work_date::text, d.worked_minutes, s.weekly_off_days AS shift_off
       FROM daily_attendance d
       LEFT JOIN shifts s ON (s.tenant_id, s.id) = (d.tenant_id, d.shift_id)
      WHERE d.work_date BETWEEN $1::date AND $2::date AND d.status = 'present' AND d.worked_minutes >= $3
        AND NOT EXISTS (SELECT 1 FROM comp_off_credits c WHERE c.employee_id = d.employee_id AND c.work_date = d.work_date)`,
    [args.from, args.to, Math.round(halfDayHours * 60 / 2)])
  let granted = 0
  for (const r of rows) {
    const dow = new Date(r.work_date + 'T00:00:00Z').getUTCDay()
    const off = holidaySet.has(r.work_date) || (r.shift_off ? r.shift_off.includes(dow) : isWeeklyOff(r.work_date, pattern))
    if (!off) continue
    const days: 0.5 | 1 = r.worked_minutes >= halfDayHours * 60 ? 1 : 0.5
    if ((await grantCompOff(tx, cfg, { employeeId: r.employee_id, workDate: r.work_date, days, note: `worked ${Math.round(r.worked_minutes / 60)}h on an off day` })).granted) granted++
  }
  return granted
}

/** Credits past their expiry that were never spent lapse from the ledger. */
export async function lapseExpired(tx: PoolClient, cfg: ResolvedConfig, today: string): Promise<number> {
  const typeId = await coType(tx)
  if (!typeId) return 0
  const { rows } = await tx.query<{ id: string; employee_id: string; work_date: string; status: string; expires_on: string }>(
    `UPDATE comp_off_credits SET status = 'expired'
      WHERE status IN ('available','available_half') AND expires_on < $1::date
      RETURNING id, employee_id, work_date::text, (CASE WHEN status = 'available_half' THEN 'half' ELSE 'full' END) AS status, expires_on::text`, [today])
  for (const c of rows) {
    // Lapse only what is still unspent: a CO balance below the credit means part of it was used.
    const bal = await tx.query<{ b: string }>(
      `SELECT coalesce(sum(delta_days),0)::text AS b FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2`, [c.employee_id, typeId])
    const days = Math.min(Number(bal.rows[0]!.b), c.status === 'half' ? 0.5 : 1)
    if (days <= 0) continue
    await appendEntry(tx, {
      employeeId: c.employee_id, leaveTypeId: typeId, entryType: 'lapse', deltaDays: -days,
      effectiveDate: c.expires_on, cycleYear: leaveCycleYear(c.expires_on, cfg.get<number>('leave.cycle_start_month')),
      sourceType: 'comp_off', idempotencyKey: `compoff-lapse:${c.id}`, note: `comp-off for ${c.work_date} expired`,
    })
  }
  return rows.length
}

export async function listCredits(tx: PoolClient, employeeId: string): Promise<{ id: string; work_date: string; expires_on: string; status: string }[]> {
  const { rows } = await tx.query<{ id: string; work_date: string; expires_on: string; status: string }>(
    `SELECT id, work_date::text, expires_on::text, status FROM comp_off_credits WHERE employee_id = $1 ORDER BY work_date DESC LIMIT 100`, [employeeId])
  return rows
}
