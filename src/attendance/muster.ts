import { AttendanceError } from './index.ts'
/**
 * The muster roll: employees down the side, days of the month across, one
 * code per cell, totals per person. Shaped like Form 25 (Factories Act) and
 * the Shops & Establishments attendance register, which is what a labour
 * inspector asks for; also what a manager opens every morning.
 *
 * Every cell comes from summarisePeriod — the same classification payroll
 * freezes — so paid days here equal paid days on the payslip.
 */
import type { PoolClient } from 'pg'
import { summarisePeriod, type PolicyFor, type MusterCell } from './summary.ts'
import { csvCell } from '../lib/csv.ts'

export interface MusterRow {
  employeeId: string
  employeeNumber: string
  name: string
  department: string | null
  designation: string | null
  days: MusterCell[]
  totals: { present: number; half: number; absent: number; leave: number; unpaidLeave: number; weeklyOff: number; holiday: number; onDuty: number; remote: number; unmarked: number; late: number; otHours: number; payable: number; lop: number }
}
export interface Muster { month: string; from: string; to: string; days: string[]; rows: MusterRow[]; legend: Record<string, string> }

export const LEGEND: Record<MusterCell['code'], string> = {
  P: 'Present', '½': 'Half day', A: 'Absent', L: 'Leave (paid)', LH: 'Half-day leave', LWP: 'Leave without pay',
  WO: 'Weekly off', H: 'Holiday', OD: 'On duty (field)', WFH: 'Work from home', NJ: 'Not on rolls', '–': 'No record',
}

export function monthBounds(month: string): { from: string; to: string } {
  // A typed error, not a bare one. `month` comes straight off a query string,
  // and an untyped throw becomes a 500 -- so a user typing a bad month was
  // told the server had broken. The fix for a client mistake returning 500 is
  // to give the error a code, never to swallow it.
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new AttendanceError('VALIDATION_FAILED', 'month must be YYYY-MM')
  }
  const [y, m] = month.split('-').map(Number) as [number, number]
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` }
}

export async function musterRoll(
  tx: PoolClient,
  args: { month: string; policy: PolicyFor; employeeIds?: string[] | null; department?: string | null; location?: string | null },
): Promise<Muster> {
  const { from, to } = monthBounds(args.month)
  let ids = args.employeeIds ?? null
  if (args.department || args.location) {
    const { rows } = await tx.query<{ employee_id: string }>(
      `SELECT DISTINCT a.employee_id FROM employee_assignments a
        WHERE a.superseded_at IS NULL AND a.effective_from <= $3::date AND (a.effective_to IS NULL OR a.effective_to >= $2::date)
          AND ($4::text IS NULL OR a.department = $4) AND ($5::text IS NULL OR a.location_code = $5)
          AND ($1::uuid[] IS NULL OR a.employee_id = ANY($1))`, [ids, from, to, args.department ?? null, args.location ?? null])
    ids = rows.map((r) => r.employee_id)
    if (ids.length === 0) return { month: args.month, from, to, days: [], rows: [], legend: LEGEND }
  }
  const summary = await summarisePeriod(tx, { periodStart: from, periodEnd: to, policy: args.policy, employeeIds: ids ?? undefined })
  const days = summary[0]?.days.map((d) => d.date) ?? []
  const rows: MusterRow[] = summary.map((s) => {
    const t = { present: 0, half: 0, absent: 0, leave: 0, unpaidLeave: 0, weeklyOff: 0, holiday: 0, onDuty: 0, remote: 0, unmarked: 0, late: 0, otHours: 0, payable: s.payableDays, lop: s.lopDays }
    for (const c of s.days) {
      if (c.late) t.late++
      t.otHours += c.otMinutes / 60
      switch (c.code) {
        case 'P': t.present++; break
        case '½': t.half++; break
        case 'A': t.absent++; break
        case 'L': case 'LH': t.leave += c.code === 'L' ? 1 : 0.5; break
        case 'LWP': t.unpaidLeave++; break
        case 'WO': t.weeklyOff++; break
        case 'H': t.holiday++; break
        case 'OD': t.onDuty++; break
        case 'WFH': t.remote++; break
        case '–': t.unmarked++; break
        default: break
      }
    }
    t.otHours = Math.round(t.otHours * 10) / 10
    return { employeeId: s.employeeId, employeeNumber: s.employeeNumber, name: s.name, department: s.department, designation: s.designation, days: s.days, totals: t }
  })
  return { month: args.month, from, to, days, rows, legend: LEGEND }
}

/** Form-25-shaped CSV: one row per employee, one column per day, then the totals. */
export function musterCsv(m: Muster): string {
  const q = csvCell
  const head = ['Emp No', 'Name', 'Department', 'Designation', ...m.days.map((d) => d.slice(8)), 'Present', 'Half', 'Absent', 'Leave', 'LWP', 'WO', 'Holiday', 'OD', 'WFH', 'No record', 'Late', 'OT hrs', 'Payable', 'LOP']
  const lines = m.rows.map((r) => [r.employeeNumber, r.name, r.department, r.designation, ...r.days.map((c) => c.code),
    r.totals.present, r.totals.half, r.totals.absent, r.totals.leave, r.totals.unpaidLeave, r.totals.weeklyOff, r.totals.holiday, r.totals.onDuty, r.totals.remote, r.totals.unmarked, r.totals.late, r.totals.otHours, r.totals.payable, r.totals.lop].map(q).join(','))
  return [head.map(q).join(','), ...lines].join('\n') + '\n'
}
