/**
 * Roster planning, shift swaps, optional holidays, overtime pre-approval.
 *
 * Precedence for "what is this person's day": a roster_days row (planned /
 * pattern / swap) → the standing shift_rosters assignment → the company week
 * pattern. shiftFor() and recomputeDay() read it through resolveDay() so the
 * muster, the payroll freeze and the punch all agree.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { notify } from '../comms/index.ts'

export class RosterError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RosterError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const DAY = 86_400_000
const iso = (d: Date): string => d.toISOString().slice(0, 10)
const eachDate = (from: string, to: string): string[] => {
  const out: string[] = []
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += DAY) out.push(iso(new Date(t)))
  return out
}

// ── day-level roster ─────────────────────────────────────────────────────────

export interface RosterDay { employee_id: string; work_date: string; shift_id: string | null; shift_code: string | null; is_off: boolean; source: string; published: boolean }
const RD_COLS = `r.employee_id, r.work_date::text, r.shift_id, s.code AS shift_code, r.is_off, r.source, r.published`

/** The planned day, if one exists. NULL means fall back to the standing shift / week pattern. */
export async function rosterDay(tx: PoolClient, employeeId: string, date: string): Promise<RosterDay | null> {
  const { rows } = await tx.query<RosterDay>(
    `SELECT ${RD_COLS} FROM roster_days r LEFT JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id) WHERE r.employee_id = $1 AND r.work_date = $2::date`, [employeeId, date])
  return rows[0] ?? null
}

export async function planDays(
  tx: PoolClient, args: { employeeId: string; days: Array<{ date: string; shiftId: string | null; off?: boolean }>; actorUserId: string; source?: 'planned' | 'pattern' | 'swap' },
): Promise<number> {
  const tid = await tenantId(tx)
  if (!args.days.length) return 0
  if (args.days.length > 366) throw new RosterError('VALIDATION_FAILED', 'plan at most a year at a time')
  const shiftIds = [...new Set(args.days.map((d) => d.shiftId).filter((x): x is string => Boolean(x)))]
  if (shiftIds.length) {
    const { rows } = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM shifts WHERE id = ANY($1::uuid[]) AND status = 'active'`, [shiftIds])
    if (Number(rows[0]!.n) !== shiftIds.length) throw new RosterError('SHIFT_NOT_FOUND', 'a shift in the plan does not exist or is retired')
  }
  // A frozen payroll period is history: refuse to redraw it.
  const frozen = await tx.query(`SELECT 1 FROM attendance_periods WHERE status = 'frozen' AND period_start <= $2::date AND period_end >= $1::date`,
    [args.days.reduce((a, d) => d.date < a ? d.date : a, args.days[0]!.date), args.days.reduce((a, d) => d.date > a ? d.date : a, args.days[0]!.date)])
  if (frozen.rowCount) throw new RosterError('PERIOD_FROZEN', 'that range is in a frozen attendance period')
  for (const d of args.days) {
    const off = d.off === true || d.shiftId === null
    await tx.query(
      `INSERT INTO roster_days (tenant_id, employee_id, work_date, shift_id, is_off, source, created_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET shift_id = EXCLUDED.shift_id, is_off = EXCLUDED.is_off, source = EXCLUDED.source, created_by_user_id = EXCLUDED.created_by_user_id, updated_at = now()`,
      [tid, args.employeeId, d.date, off ? null : d.shiftId, off, args.source ?? 'planned', args.actorUserId])
  }
  return args.days.length
}

/**
 * Rotation: a cycle like ['A','A','A','A','A','A','OFF'] applied from `from`
 * for each employee, offset by `stagger` days per person so offs rotate.
 */
export async function applyPattern(
  tx: PoolClient, args: { employeeIds: string[]; from: string; to: string; cycle: Array<string | 'OFF'>; stagger?: number; actorUserId: string },
): Promise<{ employees: number; days: number }> {
  if (!args.cycle.length || args.cycle.length > 31) throw new RosterError('VALIDATION_FAILED', 'a cycle is 1–31 entries of shift codes or OFF')
  const codes = [...new Set(args.cycle.filter((c) => c !== 'OFF'))]
  const { rows } = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM shifts WHERE code = ANY($1::text[]) AND status = 'active'`, [codes])
  const byCode = new Map(rows.map((r) => [r.code, r.id]))
  const missing = codes.filter((c) => !byCode.has(c))
  if (missing.length) throw new RosterError('SHIFT_NOT_FOUND', `no active shift: ${missing.join(', ')}`)
  const dates = eachDate(args.from, args.to)
  if (dates.length > 92) throw new RosterError('VALIDATION_FAILED', 'apply a pattern to at most a quarter at a time')
  let days = 0
  args.employeeIds.forEach(() => undefined)
  for (const [i, employeeId] of args.employeeIds.entries()) {
    const offset = (args.stagger ?? 0) * i
    const plan = dates.map((date, j) => { const c = args.cycle[(j + offset) % args.cycle.length]!; return c === 'OFF' ? { date, shiftId: null, off: true } : { date, shiftId: byCode.get(c)!, off: false } })
    days += await planDays(tx, { employeeId, days: plan, actorUserId: args.actorUserId, source: 'pattern' })
  }
  return { employees: args.employeeIds.length, days }
}

export interface RosterCell { date: string; shiftCode: string | null; off: boolean; source: 'day' | 'standing' | 'pattern' | 'swap' | 'none' }
/** The week as the supervisor sees it: one cell per employee-day, with where it came from. */
export async function rosterGrid(tx: PoolClient, args: { from: string; to: string; employeeIds?: string[] | null; weekPattern: string }): Promise<Array<{ employeeId: string; name: string; cells: RosterCell[] }>> {
  const dates = eachDate(args.from, args.to)
  if (dates.length > 62) throw new RosterError('VALIDATION_FAILED', 'at most two months in one grid')
  const { rows: people } = await tx.query<{ id: string; name: string }>(
    `SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS name FROM employees e WHERE e.status = 'active' AND e.erased_at IS NULL AND ($1::uuid[] IS NULL OR e.id = ANY($1)) ORDER BY name`, [args.employeeIds ?? null])
  const { rows: planned } = await tx.query<RosterDay>(
    `SELECT ${RD_COLS} FROM roster_days r LEFT JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id) WHERE r.work_date BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR r.employee_id = ANY($3))`,
    [args.from, args.to, args.employeeIds ?? null])
  const byKey = new Map(planned.map((p) => [`${p.employee_id}:${p.work_date}`, p]))
  const { rows: standing } = await tx.query<{ employee_id: string; code: string; weekly_off_days: number[]; effective_from: string; effective_to: string | null }>(
    `SELECT r.employee_id, s.code, s.weekly_off_days, r.effective_from::text, r.effective_to::text FROM shift_rosters r JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id)
      WHERE r.effective_from <= $2::date AND (r.effective_to IS NULL OR r.effective_to >= $1::date) AND ($3::uuid[] IS NULL OR r.employee_id = ANY($3))`, [args.from, args.to, args.employeeIds ?? null])
  const patternOff = (date: string): boolean => {
    const dow = new Date(date + 'T00:00:00Z').getUTCDay()
    if (args.weekPattern === 'five_day') return dow === 0 || dow === 6
    if (args.weekPattern === 'six_day') return dow === 0
    if (args.weekPattern === 'alternate_saturday') return dow === 0 || (dow === 6 && [2, 4].includes(Math.ceil(Number(date.slice(8, 10)) / 7)))
    return false
  }
  return people.map((p) => ({
    employeeId: p.id, name: p.name,
    cells: dates.map((date): RosterCell => {
      const d = byKey.get(`${p.id}:${date}`)
      if (d) return { date, shiftCode: d.shift_code, off: d.is_off, source: d.source === 'planned' ? 'day' : (d.source as 'pattern' | 'swap') }
      const s = standing.filter((x) => x.employee_id === p.id && x.effective_from <= date && (!x.effective_to || x.effective_to >= date)).sort((a, b) => b.effective_from.localeCompare(a.effective_from))[0]
      if (s) return { date, shiftCode: s.code, off: s.weekly_off_days.includes(new Date(date + 'T00:00:00Z').getUTCDay()), source: 'standing' }
      return { date, shiftCode: null, off: patternOff(date), source: 'none' }
    }),
  }))
}

/** Shifts whose planned headcount on a date is below their minimum. */
export async function shortages(tx: PoolClient, args: { from: string; to: string }): Promise<Array<{ date: string; shiftCode: string; planned: number; minimum: number }>> {
  const { rows } = await tx.query<{ date: string; code: string; planned: string; minimum: number }>(
    `WITH d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS date)
     SELECT d.date::text, s.code, count(r.id)::text AS planned, s.min_headcount AS minimum
       FROM d CROSS JOIN shifts s
       LEFT JOIN roster_days r ON r.shift_id = s.id AND r.work_date = d.date AND NOT r.is_off
      WHERE s.status = 'active' AND s.min_headcount > 0
      GROUP BY d.date, s.code, s.min_headcount
     HAVING count(r.id) < s.min_headcount ORDER BY d.date, s.code`, [args.from, args.to])
  return rows.map((r) => ({ date: r.date, shiftCode: r.code, planned: Number(r.planned), minimum: r.minimum }))
}

/** Nightly: tell HR and managers about shortages in the next `daysAhead` days. */
export async function alertShortages(tx: PoolClient, daysAhead: number, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  if (daysAhead <= 0) return 0
  const to = iso(new Date(Date.parse(today + 'T00:00:00Z') + daysAhead * DAY))
  const list = await shortages(tx, { from: today, to })
  if (!list.length) return 0
  const { rows } = await tx.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM user_roles WHERE role IN ('hr_admin', 'manager')`)
  const body = list.slice(0, 8).map((s) => `${s.date} ${s.shiftCode}: ${s.planned}/${s.minimum}`).join(' · ')
  for (const u of rows) {
    await notify(tx, { userId: u.user_id, eventType: 'roster.shortage', title: `${list.length} shift(s) under strength in the next ${daysAhead} days`, body, entityType: 'roster', dedupeKey: `shortage:${today}:${u.user_id}` })
  }
  return list.length
}

// ── shift swaps ──────────────────────────────────────────────────────────────

export interface Swap { id: string; requester_employee_id: string; counterpart_employee_id: string; work_date: string; requester_shift_id: string | null; counterpart_shift_id: string | null; reason: string | null; status: string; approval_request_id: string | null }
const SW_COLS = `id, requester_employee_id, counterpart_employee_id, work_date::text, requester_shift_id, counterpart_shift_id, reason, status, approval_request_id`

async function effectiveShiftId(tx: PoolClient, employeeId: string, date: string): Promise<string | null> {
  const day = await rosterDay(tx, employeeId, date)
  if (day) return day.is_off ? null : day.shift_id
  const { rows } = await tx.query<{ shift_id: string }>(
    `SELECT shift_id FROM shift_rosters WHERE employee_id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date) ORDER BY effective_from DESC LIMIT 1`, [employeeId, date])
  return rows[0]?.shift_id ?? null
}

export async function proposeSwap(tx: PoolClient, args: { requesterEmployeeId: string; counterpartEmployeeId: string; date: string; reason?: string; requestedByUserId: string }): Promise<Swap> {
  const tid = await tenantId(tx)
  if (args.requesterEmployeeId === args.counterpartEmployeeId) throw new RosterError('VALIDATION_FAILED', 'swap with someone else')
  if (args.date < new Date().toISOString().slice(0, 10)) throw new RosterError('VALIDATION_FAILED', 'that day has passed')
  const live = await tx.query(`SELECT 1 FROM shift_swaps WHERE work_date = $1 AND status IN ('proposed','accepted') AND (requester_employee_id IN ($2,$3) OR counterpart_employee_id IN ($2,$3))`, [args.date, args.requesterEmployeeId, args.counterpartEmployeeId])
  if (live.rowCount) throw new RosterError('SWAP_OPEN', 'one of you already has a swap in flight for that day')
  const a = await effectiveShiftId(tx, args.requesterEmployeeId, args.date), b = await effectiveShiftId(tx, args.counterpartEmployeeId, args.date)
  if (a === b) throw new RosterError('VALIDATION_FAILED', 'you are already on the same shift that day')
  const { rows } = await tx.query<Swap>(
    `INSERT INTO shift_swaps (tenant_id, requester_employee_id, counterpart_employee_id, work_date, requester_shift_id, counterpart_shift_id, reason) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${SW_COLS}`,
    [tid, args.requesterEmployeeId, args.counterpartEmployeeId, args.date, a, b, args.reason?.trim() || null])
  const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [args.counterpartEmployeeId])).rows[0]?.id
  if (u) await notify(tx, { userId: u, eventType: 'roster.swap.proposed', title: `Shift swap proposed for ${args.date}`, body: args.reason ?? undefined, entityType: 'shift_swap', entityId: rows[0]!.id, dedupeKey: `swap:${rows[0]!.id}` })
  return rows[0]!
}

/** The counterpart accepts (or declines). Acceptance raises the approval unless the company skips it. */
export async function respondSwap(tx: PoolClient, cfg: ResolvedConfig, args: { swapId: string; counterpartEmployeeId: string; accept: boolean; userId: string }): Promise<Swap> {
  const s = (await tx.query<Swap>(`SELECT ${SW_COLS} FROM shift_swaps WHERE id = $1 FOR UPDATE`, [args.swapId])).rows[0]
  if (!s) throw new RosterError('NOT_FOUND', 'no such swap')
  if (s.counterpart_employee_id !== args.counterpartEmployeeId) throw new RosterError('NOT_YOURS', 'only the person asked can answer')
  if (s.status !== 'proposed') throw new RosterError('SWAP_STATE', `the swap is ${s.status}`)
  if (!args.accept) {
    return (await tx.query<Swap>(`UPDATE shift_swaps SET status = 'declined', decided_at = now() WHERE id = $1 RETURNING ${SW_COLS}`, [s.id])).rows[0]!
  }
  if (!cfg.get<boolean>('attendance.swap_requires_approval')) {
    await tx.query(`UPDATE shift_swaps SET status = 'accepted' WHERE id = $1`, [s.id])
    await settleSwapDecision(tx, { swapId: s.id, status: 'approved', actorUserId: args.userId })
    return (await tx.query<Swap>(`SELECT ${SW_COLS} FROM shift_swaps WHERE id = $1`, [s.id])).rows[0]!
  }
  const approval = await raiseWithPolicy(tx, {
    entityType: 'shift_swap', entityId: s.id, requestedByUserId: args.userId, subjectEmployeeId: s.requester_employee_id, magnitude: 1,
    fallback: cfg.get<string>('attendance.regularisation_chain') as ChainCode, title: `Shift swap · ${s.work_date}`,
  })
  await tx.query(`UPDATE shift_swaps SET status = 'accepted', approval_request_id = $2 WHERE id = $1`, [s.id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleSwapDecision(tx, { approvalRequestId: approval.requestId, status: 'approved', actorUserId: args.userId })
  return (await tx.query<Swap>(`SELECT ${SW_COLS} FROM shift_swaps WHERE id = $1`, [s.id])).rows[0]!
}

/** On approval both people's days are redrawn as 'swap' rows; on rejection the swap closes. */
export async function settleSwapDecision(tx: PoolClient, args: { swapId?: string; approvalRequestId?: string; status: 'approved' | 'rejected'; actorUserId: string }): Promise<{ changed: boolean }> {
  const s = (await tx.query<Swap>(`SELECT ${SW_COLS} FROM shift_swaps WHERE ($1::uuid IS NULL OR id = $1) AND ($2::uuid IS NULL OR approval_request_id = $2) AND status = 'accepted' FOR UPDATE`,
    [args.swapId ?? null, args.approvalRequestId ?? null])).rows[0]
  if (!s) return { changed: false }
  if (args.status === 'approved') {
    await planDays(tx, { employeeId: s.requester_employee_id, days: [{ date: s.work_date, shiftId: s.counterpart_shift_id, off: s.counterpart_shift_id === null }], actorUserId: args.actorUserId, source: 'swap' })
    await planDays(tx, { employeeId: s.counterpart_employee_id, days: [{ date: s.work_date, shiftId: s.requester_shift_id, off: s.requester_shift_id === null }], actorUserId: args.actorUserId, source: 'swap' })
  }
  await tx.query(`UPDATE shift_swaps SET status = $2, decided_at = now() WHERE id = $1`, [s.id, args.status])
  for (const e of [s.requester_employee_id, s.counterpart_employee_id]) {
    const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [e])).rows[0]?.id
    if (u) await notify(tx, { userId: u, eventType: 'roster.swap.decided', title: `Shift swap for ${s.work_date} ${args.status}`, entityType: 'shift_swap', entityId: s.id, dedupeKey: `swap:${s.id}:${u}:${args.status}` })
  }
  return { changed: true }
}

export async function listSwaps(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<Swap[]> {
  return (await tx.query<Swap>(
    `SELECT ${SW_COLS} FROM shift_swaps WHERE ($1::uuid[] IS NULL OR requester_employee_id = ANY($1) OR counterpart_employee_id = ANY($1))
        AND ($2::uuid IS NULL OR requester_employee_id = $2 OR counterpart_employee_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY work_date DESC LIMIT 200`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])).rows
}

// ── optional holidays ────────────────────────────────────────────────────────

export async function pickOptionalHoliday(tx: PoolClient, cfg: ResolvedConfig, args: { employeeId: string; holidayId: string }): Promise<{ picked: number; allowed: number }> {
  const tid = await tenantId(tx)
  const allowed = cfg.get<number>('leave.optional_holidays_allowed')
  if (allowed <= 0) throw new RosterError('OPTIONAL_HOLIDAYS_OFF', 'this company does not offer optional holidays')
  const h = (await tx.query<{ holiday_on: string; is_optional: boolean }>(`SELECT holiday_on::text, is_optional FROM holidays WHERE id = $1`, [args.holidayId])).rows[0]
  if (!h) throw new RosterError('NOT_FOUND', 'no such holiday')
  if (!h.is_optional) throw new RosterError('VALIDATION_FAILED', 'that holiday is not optional; everyone has it')
  if (h.holiday_on < new Date().toISOString().slice(0, 10)) throw new RosterError('VALIDATION_FAILED', 'that day has passed')
  const year = h.holiday_on.slice(0, 4)
  const { rows } = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM optional_holiday_picks WHERE employee_id = $1 AND holiday_on BETWEEN ($2 || '-01-01')::date AND ($2 || '-12-31')::date`, [args.employeeId, year])
  if (Number(rows[0]!.n) >= allowed) throw new RosterError('OPTIONAL_HOLIDAY_CAP', `you may pick ${allowed} optional holiday(s) a year`)
  await tx.query(`INSERT INTO optional_holiday_picks (tenant_id, employee_id, holiday_id, holiday_on) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, employee_id, holiday_id) DO NOTHING`, [tid, args.employeeId, args.holidayId, h.holiday_on])
  return { picked: Number(rows[0]!.n) + 1, allowed }
}

export async function unpickOptionalHoliday(tx: PoolClient, args: { employeeId: string; holidayId: string }): Promise<void> {
  const r = await tx.query(`DELETE FROM optional_holiday_picks WHERE employee_id = $1 AND holiday_id = $2 AND holiday_on >= CURRENT_DATE`, [args.employeeId, args.holidayId])
  if (!r.rowCount) throw new RosterError('NOT_FOUND', 'no such upcoming pick')
}

export async function optionalHolidayPicks(tx: PoolClient, employeeId: string, from: string, to: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ d: string }>(`SELECT holiday_on::text AS d FROM optional_holiday_picks WHERE employee_id = $1 AND holiday_on BETWEEN $2::date AND $3::date`, [employeeId, from, to])
  return new Set(rows.map((r) => r.d))
}

// ── overtime pre-approval ────────────────────────────────────────────────────

export interface OtRequest { id: string; employee_id: string; work_date: string; minutes: number; reason: string | null; status: string; approval_request_id: string | null }
const OT_COLS = `id, employee_id, work_date::text, minutes, reason, status, approval_request_id`

export async function requestOt(tx: PoolClient, cfg: ResolvedConfig, args: { employeeId: string; date: string; minutes: number; reason?: string; requestedByUserId: string }): Promise<OtRequest> {
  const tid = await tenantId(tx)
  if (!Number.isInteger(args.minutes) || args.minutes < 15 || args.minutes > 720) throw new RosterError('VALIDATION_FAILED', 'minutes is 15–720')
  const live = await tx.query(`SELECT 1 FROM ot_requests WHERE employee_id = $1 AND work_date = $2 AND status IN ('pending','approved')`, [args.employeeId, args.date])
  if (live.rowCount) throw new RosterError('OT_REQUEST_OPEN', 'overtime is already requested or approved for that day')
  const { rows } = await tx.query<OtRequest>(`INSERT INTO ot_requests (tenant_id, employee_id, work_date, minutes, reason, requested_by_user_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${OT_COLS}`,
    [tid, args.employeeId, args.date, args.minutes, args.reason?.trim() || null, args.requestedByUserId])
  const approval = await raiseWithPolicy(tx, { entityType: 'overtime', entityId: rows[0]!.id, requestedByUserId: args.requestedByUserId, subjectEmployeeId: args.employeeId, magnitude: args.minutes,
    fallback: cfg.get<string>('attendance.regularisation_chain') as ChainCode, title: `Overtime · ${args.date} · ${Math.round(args.minutes / 60 * 10) / 10} h` })
  await tx.query(`UPDATE ot_requests SET approval_request_id = $2 WHERE id = $1`, [rows[0]!.id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleOtDecision(tx, { approvalRequestId: approval.requestId, status: 'approved' })
  return (await tx.query<OtRequest>(`SELECT ${OT_COLS} FROM ot_requests WHERE id = $1`, [rows[0]!.id])).rows[0]!
}

export async function settleOtDecision(tx: PoolClient, args: { approvalRequestId: string; status: 'approved' | 'rejected' }): Promise<{ changed: boolean }> {
  const { rowCount } = await tx.query(`UPDATE ot_requests SET status = $2, decided_at = now() WHERE approval_request_id = $1 AND status = 'pending'`, [args.approvalRequestId, args.status])
  return { changed: (rowCount ?? 0) > 0 }
}

export async function listOt(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; from?: string; to?: string; status?: string }): Promise<OtRequest[]> {
  return (await tx.query<OtRequest>(
    `SELECT ${OT_COLS} FROM ot_requests WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::date IS NULL OR work_date >= $3) AND ($4::date IS NULL OR work_date <= $4) AND ($5::text IS NULL OR status = $5) ORDER BY work_date DESC LIMIT 500`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.from ?? null, args.to ?? null, args.status ?? null])).rows
}

/** Approved OT minutes per date in a range — what the payroll summary caps against when pre-approval is on. */
export async function approvedOtByDate(tx: PoolClient, employeeId: string, from: string, to: string): Promise<Map<string, number>> {
  const { rows } = await tx.query<{ d: string; m: number }>(`SELECT work_date::text AS d, minutes AS m FROM ot_requests WHERE employee_id = $1 AND status = 'approved' AND work_date BETWEEN $2::date AND $3::date`, [employeeId, from, to])
  return new Map(rows.map((r) => [r.d, r.m]))
}
