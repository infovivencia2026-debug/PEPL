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
import { currentPosting, stateOfLocation } from '../people/profile.ts'
import type { FreezeRow } from '../payroll/run.ts'

export interface SummaryPolicy {
  unmarkedDayIsLop: boolean
  /** 0 disables. */
  lateMarksPerHalfDay: number
  weekPattern: 'five_day' | 'six_day' | 'alternate_saturday' | 'roster'
  defaultStateCode: string
}

/**
 * The policy for ONE person: the tenant's settings resolved against their
 * department / location / grade, so an override for "Hyderabad" reaches the
 * people posted there. Given a plain policy, every employee gets the same.
 */
export type PolicyFor = SummaryPolicy | ((employeeId: string) => Promise<SummaryPolicy>)

/**
 * One calendar day as the muster shows it. The code is what goes in the cell;
 * payable/lop are the same numbers summarisePeriod sums, so the register and
 * the payslip can never disagree.
 *   P present · ½ half day · A absent · L paid leave · LH half leave · LWP unpaid leave
 *   WO weekly off · H holiday · OD on duty (field) · WFH remote · NJ not joined / left · – no record
 */
export interface MusterCell {
  date: string
  code: 'P' | '½' | 'A' | 'L' | 'LH' | 'LWP' | 'WO' | 'H' | 'OD' | 'WFH' | 'NJ' | '–'
  payable: number
  lop: number
  late: boolean
  otMinutes: number
  firstIn: string | null
  lastOut: string | null
  workedMinutes: number
}

export interface EmployeeSummary {
  employeeId: string
  department: string | null
  designation: string | null
  days: MusterCell[]
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
  args: { periodStart: string; periodEnd: string; policy: PolicyFor; employeeIds?: string[] },
): Promise<EmployeeSummary[]> {
  const policyFor = typeof args.policy === 'function' ? args.policy : async () => args.policy as SummaryPolicy
  const start = new Date(args.periodStart + 'T00:00:00Z'), end = new Date(args.periodEnd + 'T00:00:00Z')
  const calendarDays = Math.round((end.getTime() - start.getTime()) / DAY) + 1

  const { rows: employees } = await tx.query<{
    id: string; employee_number: string; first_name: string; last_name: string | null
    date_of_joining: string; date_of_exit: string | null; status: string
    pf_applicable: boolean; esi_applicable: boolean
  }>(
    `SELECT id, employee_number, first_name, last_name, date_of_joining::text, date_of_exit::text, status,
            pf_applicable, esi_applicable
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
    const policy = await policyFor(e.id)
    // Professional tax follows the office the person is posted at; the
    // tenant-wide setting is the fallback for a company with one office.
    const posting = await currentPosting(tx, e.id, args.periodEnd)
    const stateCode = (await stateOfLocation(tx, posting?.location_code ?? null)) ?? policy.defaultStateCode
    const { rows: days } = await tx.query<{
      work_date: string; status: string; day_fraction: string; late_minutes: number; ot_minutes: number; shift_id: string | null
      is_remote: boolean; is_field_duty: boolean; first_in: string | null; last_out: string | null; worked_minutes: number
    }>(
      `SELECT work_date::text, status, day_fraction::text, late_minutes, ot_minutes, shift_id, is_remote, is_field_duty, first_in::text, last_out::text, worked_minutes
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
    const cells: MusterCell[] = []
    const warnings: string[] = []
    const joinedMid = e.date_of_joining > args.periodStart
    const exitedMid = !!e.date_of_exit && e.date_of_exit < args.periodEnd

    const blank = { late: false, otMinutes: 0, firstIn: null, lastOut: null, workedMinutes: 0 }
    for (let i = 0; i < calendarDays; i++) {
      const date = iso(new Date(start.getTime() + i * DAY))
      if (date < e.date_of_joining || (e.date_of_exit && date > e.date_of_exit)) { cells.push({ date, code: 'NJ', payable: 0, lop: 0, ...blank }); continue }
      const d = byDate.get(date)
      const off = shiftOffs ? shiftOffs.includes(new Date(date + 'T00:00:00Z').getUTCDay()) : isWeeklyOff(date, policy.weekPattern)
      if (!d) {
        if (off) { payable += 1; cells.push({ date, code: 'WO', payable: 1, lop: 0, ...blank }); continue }
        if (holidaySet.has(date)) { payable += 1; cells.push({ date, code: 'H', payable: 1, lop: 0, ...blank }); continue }
        unmarked++
        if (policy.unmarkedDayIsLop) { lop += 1; cells.push({ date, code: '–', payable: 0, lop: 1, ...blank }) }
        else { payable += 1; cells.push({ date, code: '–', payable: 1, lop: 0, ...blank }) }
        continue
      }
      const fraction = Number(d.day_fraction)
      lateMarks += d.late_minutes > 0 ? 1 : 0
      ot += d.ot_minutes
      const detail = { late: d.late_minutes > 0, otMinutes: d.ot_minutes, firstIn: d.first_in, lastOut: d.last_out, workedMinutes: d.worked_minutes }
      let code: MusterCell['code'] = 'P', cp = 0, cl = 0
      switch (d.status) {
        case 'weekly_off': code = 'WO'; cp = 1; break
        case 'holiday': code = 'H'; cp = 1; break
        case 'on_leave': cp = fraction; paidLeave += fraction; cl = 1 - fraction; code = fraction === 0 ? 'LWP' : fraction < 1 ? 'LH' : 'L'; break
        case 'present': case 'on_duty': cp = fraction; cl = 1 - fraction; code = d.is_field_duty || d.status === 'on_duty' ? 'OD' : d.is_remote ? 'WFH' : fraction < 1 ? '½' : 'P'; break
        case 'absent': code = 'A'; cl = 1; break
        case 'not_joined': code = 'NJ'; break
        default: cp = fraction; cl = 1 - fraction
      }
      payable += cp; lop += cl
      cells.push({ date, code, payable: cp, lop: cl, ...detail })
    }

    let lateHalfDays = 0
    if (policy.lateMarksPerHalfDay > 0 && lateMarks >= policy.lateMarksPerHalfDay) {
      lateHalfDays = Math.floor(lateMarks / policy.lateMarksPerHalfDay) * 0.5
      const take = Math.min(lateHalfDays, payable)
      payable -= take
      lop += take
    }
    if (unmarked > 0) warnings.push(`${unmarked} day(s) with no attendance record, treated as ${policy.unmarkedDayIsLop ? 'LOP' : 'paid'}`)

    const { rows: comp } = await tx.query<{ components: Record<string, number>; annual_ctc_paise: string }>(
      `SELECT components, annual_ctc_paise::text FROM compensation_records
        WHERE employee_id = $1 AND superseded_at IS NULL
          AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
        ORDER BY effective_from DESC LIMIT 1`, [e.id, args.periodEnd])
    if (!comp[0]) warnings.push('no salary structure in force; the row cannot be frozen')
    if (!stateCode) warnings.push('no professional-tax state: set the location\'s state or payroll.pt_state_code')

    const round2 = (n: number): number => Math.round(n * 100) / 100
    out.push({
      employeeId: e.id, employeeNumber: e.employee_number, name: [e.first_name, e.last_name].filter(Boolean).join(' '),
      department: posting?.department ?? null, designation: posting?.designation ?? null, days: cells,
      calendarDays, payableDays: round2(payable), lopDays: round2(lop), paidLeaveDays: round2(paidLeave),
      unmarkedDays: unmarked, lateMarks, lateHalfDays, otMinutes: ot,
      joinedMidPeriod: joinedMid, exitedMidPeriod: exitedMid, warnings,
      row: comp[0] ? {
        employeeId: e.id, calendarDays, payableDays: round2(payable), lopDays: round2(lop), paidLeaveDays: round2(paidLeave),
        otMinutes: ot, monthlyComponents: comp[0].components, annualCtcPaise: BigInt(comp[0].annual_ctc_paise),
        stateCode: stateCode || 'NA', pfApplicable: e.pf_applicable, esiApplicable: e.esi_applicable,
        joinedMidPeriod: joinedMid, exitedMidPeriod: exitedMid,
      } : null,
    })
  }
  return out
}
