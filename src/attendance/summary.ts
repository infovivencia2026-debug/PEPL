/**
 * The attendance → payroll bridge.
 *
 * Until now the freeze screen asked payroll to TYPE payable and LOP days per
 * employee — the engine read only payroll_inputs, and payroll_inputs came from
 * a form. This produces the freeze rows from what the system already knows:
 * the muster, the holiday calendar, the roster, the late rule, and the salary
 * structure in force. The freeze still resolves it once into values; this is
 * how the values are proposed, and a person can still override a row.
 *
 * Day accounting, per calendar day in the period:
 *   before joining / after exit    not payable, and the row is flagged mid-period
 *   weekly off, holiday            paid, no work expected
 *   on_leave                       paid for the leave's fraction (unpaid leave is LOP)
 *   present                        paid for day_fraction; the rest is LOP
 *   absent                         LOP
 *   no row at all                  paid unless attendance.unmarked_day_is_lop
 *
 * Then the late rule: every N late marks cost half a day.
 */
import type { PoolClient } from 'pg'
import type { FreezeRow } from '../payroll/run.ts'

export interface SummaryPolicy {
  unmarkedDayIsLop: boolean
  /** 0 disables. */
  lateMarksPerHalfDay: number
  weekPattern: 'five_day' | 'six_day' | 'alternate_saturday' | 'roster'
  defaultStateCode: string
}

export interface EmployeeSummary {
  employeeId: string
  employeeNumber: string
  name: string
  calendarDays: number
  payableDays: number
  lopDays: number
  paidLeaveDays: number
  unmarkedDays: number
  lateMarks: number
  lateHalfDays: number
  otMinutes: number
  joinedMidPeriod: boolean
  exitedMidPeriod: boolean
  /** Things a human should look at before freezing. */
  warnings: string[]
  row: FreezeRow | null
}

const DAY = 86_400_000
const iso = (d: Date): string => d.toISOString().slice(0, 10)

function isWeeklyOff(date: string, pattern: SummaryPolicy['weekPattern']): boolean {
  const day = new Date(date + 'T00:00:00Z').getUTCDay()
  const idx = Math.ceil(Number(date.slice(8, 10)) / 7)
  if (pattern === 'five_day') return day === 0 || day === 6
  if (pattern === 'alternate_saturday') return day === 0 || (day === 6 && (idx === 2 || idx === 4))
  if (pattern === 'six_day') return day === 0
  return false
}

export async function summarisePeriod(
  tx: PoolClient,
  args: { periodStart: string; periodEnd: string; policy: SummaryPolicy; employeeIds?: string[] },
): Promise<EmployeeSummary[]> {
  const start = new Date(args.periodStart + 'T00:00:00Z'), end = new Date(args.periodEnd + 'T00:00:00Z')
  const calendarDays = Math.round((end.getTime() - start.getTime()) / DAY) + 1

  const { rows: employees } = await tx.query<{
    id: string; employee_number: string; first_name: string; last_name: string | null
    date_of_joining: string; date_of_exit: string | null; status: string
  }>(
    `SELECT id, employee_number, first_name, last_name, date_of_joining::text, date_of_exit::text, status
       FROM employees
      WHERE date_of_joining <= $2::date
        AND (date_of_exit IS NULL OR date_of_exit >= $1::date)
        AND erased_at IS NULL
        AND ($3::uuid[] IS NULL OR id = ANY($3))
      ORDER BY employee_number`,
    [args.periodStart, args.periodEnd, args.employeeIds ?? null])

  const { rows: holidays } = await tx.query<{ holiday_on: string }>(
    `SELECT holiday_on::text FROM holidays WHERE holiday_on BETWEEN $1::date AND $2::date AND NOT is_optional AND location IS NULL`,
    [args.periodStart, args.periodEnd])
  const holidaySet = new Set(holidays.map((h) => h.holiday_on))

  const out: EmployeeSummary[] = []
  for (const e of employees) {
    const { rows: days } = await tx.query<{
      work_date: string; status: string; day_fraction: string; late_minutes: number; ot_minutes: number; shift_id: string | null
    }>(
      `SELECT work_date::text, status, day_fraction::text, late_minutes, ot_minutes, shift_id
         FROM daily_attendance WHERE employee_id = $1 AND work_date BETWEEN $2::date AND $3::date`,
      [e.id, args.periodStart, args.periodEnd])
    const byDate = new Map(days.map((d) => [d.work_date, d]))
    // Weekly offs for rostered people come from the shift; the muster already
    // recorded them as weekly_off rows, so only unrecorded days need the pattern.
    const { rows: roster } = await tx.query<{ weekly_off_days: number[] }>(
      `SELECT s.weekly_off_days FROM shift_rosters r JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id)
        WHERE r.employee_id = $1 AND r.effective_from <= $3::date AND (r.effective_to IS NULL OR r.effective_to >= $2::date)
        ORDER BY r.effective_from DESC LIMIT 1`, [e.id, args.periodStart, args.periodEnd])
    const shiftOffs = roster[0]?.weekly_off_days ?? null

    let payable = 0, lop = 0, paidLeave = 0, unmarked = 0, lateMarks = 0, ot = 0
    const warnings: string[] = []
    const joinedMid = e.date_of_joining > args.periodStart
    const exitedMid = !!e.date_of_exit && e.date_of_exit < args.periodEnd

    for (let i = 0; i < calendarDays; i++) {
      const date = iso(new Date(start.getTime() + i * DAY))
      if (date < e.date_of_joining || (e.date_of_exit && date > e.date_of_exit)) continue
      const d = byDate.get(date)
      const off = shiftOffs ? shiftOffs.includes(new Date(date + 'T00:00:00Z').getUTCDay()) : isWeeklyOff(date, args.policy.weekPattern)
      if (!d) {
        if (off || holidaySet.has(date)) { payable += 1; continue }
        unmarked++
        if (args.policy.unmarkedDayIsLop) lop += 1; else payable += 1
        continue
      }
      const fraction = Number(d.day_fraction)
      lateMarks += d.late_minutes > 0 ? 1 : 0
      ot += d.ot_minutes
      switch (d.status) {
        case 'weekly_off': case 'holiday': payable += 1; break
        case 'on_leave': payable += fraction; paidLeave += fraction; lop += 1 - fraction; break
        case 'present': case 'on_duty': payable += fraction; lop += 1 - fraction; break
        case 'absent': lop += 1; break
        case 'not_joined': break
        default: payable += fraction; lop += 1 - fraction
      }
    }

    let lateHalfDays = 0
    if (args.policy.lateMarksPerHalfDay > 0 && lateMarks >= args.policy.lateMarksPerHalfDay) {
      lateHalfDays = Math.floor(lateMarks / args.policy.lateMarksPerHalfDay) * 0.5
      const take = Math.min(lateHalfDays, payable)
      payable -= take
      lop += take
    }
    if (unmarked > 0) warnings.push(`${unmarked} day(s) with no attendance record, treated as ${args.policy.unmarkedDayIsLop ? 'LOP' : 'paid'}`)

    const { rows: comp } = await tx.query<{ components: Record<string, number>; annual_ctc_paise: string }>(
      `SELECT components, annual_ctc_paise::text FROM compensation_records
        WHERE employee_id = $1 AND superseded_at IS NULL
          AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC LIMIT 1`, [e.id, args.periodEnd])
    if (!comp[0]) warnings.push('no salary structure in force; the row cannot be frozen')
    if (!args.policy.defaultStateCode) warnings.push('no professional-tax state set (payroll.pt_state_code)')

    const round2 = (n: number): number => Math.round(n * 100) / 100
    out.push({
      employeeId: e.id, employeeNumber: e.employee_number, name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      calendarDays, payableDays: round2(payable), lopDays: round2(lop), paidLeaveDays: round2(paidLeave),
      unmarkedDays: unmarked, lateMarks, lateHalfDays, otMinutes: ot,
      joinedMidPeriod: joinedMid, exitedMidPeriod: exitedMid, warnings,
      row: comp[0] ? {
        employeeId: e.id, calendarDays, payableDays: round2(payable), lopDays: round2(lop), paidLeaveDays: round2(paidLeave),
        otMinutes: ot, monthlyComponents: comp[0].components, annualCtcPaise: BigInt(comp[0].annual_ctc_paise),
        stateCode: args.policy.defaultStateCode || 'NA', pfApplicable: true, esiApplicable: true,
        joinedMidPeriod: joinedMid, exitedMidPeriod: exitedMid,
      } : null,
    })
  }
  return out
}
