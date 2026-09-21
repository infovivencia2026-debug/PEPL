/**
 * Attendance operations — what a manager runs every morning and what an
 * employee does between punch-in and punch-out.
 *
 *  breaks         start/end; recorded minutes come off the day's worked time
 *  late reason    stored on the day; shown to the manager, never blocks the punch
 *  auto-checkout  a job closes a day nobody punched out of, N minutes after the
 *                 shift ends (12h after punch-in without a shift), and marks it
 *  control room   today, live: expected / in / late / on break / missing / leave
 *                 / remote / field / auto-closed, by location
 *  QR punch       a rotating code a manager's phone or a wall tablet shows; a
 *                 scan is a punch AT that site with no location fix needed
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import { recomputeDay, type DayPolicy } from './index.ts'
import { shiftFor, evaluateShiftDay } from './shifts.ts'

export class OpsError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OpsError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

// ── breaks ───────────────────────────────────────────────────────────────────

export interface Break { id: string; employee_id: string; work_date: string; started_at: string; ended_at: string | null; kind: string; minutes: number }
const BREAK_COLS = `id, employee_id, work_date::text, started_at::text, ended_at::text, kind,
  coalesce(floor(extract(epoch FROM (coalesce(ended_at, now()) - started_at)) / 60), 0)::int AS minutes`

export async function startBreak(tx: PoolClient, args: { employeeId: string; workDate: string; kind?: string }): Promise<Break> {
  const tid = await tenantId(tx)
  const day = (await tx.query<{ first_in: string | null; last_out: string | null }>(`SELECT first_in::text, last_out::text FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`, [args.employeeId, args.workDate])).rows[0]
  if (!day?.first_in || day.last_out) throw new OpsError('NOT_PUNCHED_IN', 'a break starts after punch-in and before punch-out')
  const open = await tx.query(`SELECT 1 FROM attendance_breaks WHERE employee_id = $1 AND ended_at IS NULL`, [args.employeeId])
  if (open.rowCount) throw new OpsError('BREAK_OPEN', 'end the current break first')
  const { rows } = await tx.query<Break>(`INSERT INTO attendance_breaks (tenant_id, employee_id, work_date, kind) VALUES ($1,$2,$3,$4) RETURNING ${BREAK_COLS}`,
    [tid, args.employeeId, args.workDate, ['break', 'lunch', 'personal'].includes(args.kind ?? '') ? args.kind : 'break'])
  return rows[0]!
}

export async function endBreak(tx: PoolClient, args: { employeeId: string; policy?: DayPolicy }): Promise<Break> {
  const { rows } = await tx.query<Break>(`UPDATE attendance_breaks SET ended_at = now() WHERE employee_id = $1 AND ended_at IS NULL RETURNING ${BREAK_COLS}`, [args.employeeId])
  if (!rows[0]) throw new OpsError('NO_OPEN_BREAK', 'no break is running')
  await recomputeDay(tx, args.employeeId, rows[0].work_date, args.policy)
  return rows[0]
}

export async function breaksOn(tx: PoolClient, employeeId: string, workDate: string): Promise<Break[]> {
  return (await tx.query<Break>(`SELECT ${BREAK_COLS} FROM attendance_breaks WHERE employee_id = $1 AND work_date = $2 ORDER BY started_at`, [employeeId, workDate])).rows
}

/** Closed break minutes on a day — what recomputeDay deducts when the company deducts recorded breaks. */
export async function recordedBreakMinutes(tx: PoolClient, employeeId: string, workDate: string): Promise<number> {
  const { rows } = await tx.query<{ m: string }>(
    `SELECT coalesce(sum(floor(extract(epoch FROM (ended_at - started_at)) / 60)), 0)::text AS m FROM attendance_breaks WHERE employee_id = $1 AND work_date = $2 AND ended_at IS NOT NULL`, [employeeId, workDate])
  return Number(rows[0]!.m)
}

// ── late reason ──────────────────────────────────────────────────────────────

export async function setLateReason(tx: PoolClient, args: { employeeId: string; workDate: string; reason: string }): Promise<{ lateMinutes: number }> {
  if (!args.reason?.trim()) throw new OpsError('VALIDATION_FAILED', 'say why')
  const { rows } = await tx.query<{ late_minutes: number }>(
    `UPDATE daily_attendance SET late_reason = $3 WHERE employee_id = $1 AND work_date = $2 AND late_minutes > 0 RETURNING late_minutes`, [args.employeeId, args.workDate, args.reason.trim().slice(0, 300)])
  if (!rows[0]) throw new OpsError('NOT_LATE', 'this day has no late mark to explain')
  return { lateMinutes: rows[0].late_minutes }
}

// ── auto-checkout ────────────────────────────────────────────────────────────

/**
 * Days with a punch-in and no punch-out, older than the shift end + grace (or
 * 12 h after the punch-in when there is no shift): an OUT punch is written at
 * the scheduled end (or punch-in + 9 h), the day is recomputed and flagged
 * auto_closed so the person and the manager both see it happened.
 */
export async function autoCheckout(tx: PoolClient, args: { afterMinutes: number; timezone: string; policy?: DayPolicy; now?: Date }): Promise<number> {
  if (args.afterMinutes <= 0) return 0
  const tid = await tenantId(tx)
  const now = args.now ?? new Date()
  const { rows } = await tx.query<{ employee_id: string; work_date: string; first_in: string }>(
    `SELECT employee_id, work_date::text, first_in::text FROM daily_attendance
      WHERE first_in IS NOT NULL AND last_out IS NULL AND status IN ('present','on_duty') AND NOT auto_closed AND work_date >= ($1::timestamptz - interval '3 days')::date`, [now.toISOString()])
  let closed = 0
  for (const d of rows) {
    const shift = await shiftFor(tx, d.employee_id, d.work_date)
    const firstIn = new Date(d.first_in)
    const scheduledEnd = shift ? evaluateShiftDay(shift, d.work_date, { firstIn, lastOut: null }, args.timezone).scheduledEnd : new Date(firstIn.getTime() + 9 * 3_600_000)
    const deadline = shift ? scheduledEnd.getTime() + args.afterMinutes * 60_000 : firstIn.getTime() + 12 * 3_600_000
    if (now.getTime() < deadline) continue
    const outAt = new Date(Math.max(scheduledEnd.getTime(), firstIn.getTime() + 60_000))
    await tx.query(
      `INSERT INTO attendance_punches (tenant_id, employee_id, punched_at, local_date, direction, source, client_punch_id) VALUES ($1,$2,$3,$4,'out','manual',$5)`,
      [tid, d.employee_id, outAt.toISOString(), d.work_date, `auto:${d.work_date}`])
    await tx.query(`UPDATE attendance_breaks SET ended_at = $3 WHERE employee_id = $1 AND work_date = $2 AND ended_at IS NULL`, [d.employee_id, d.work_date, outAt.toISOString()])
    await recomputeDay(tx, d.employee_id, d.work_date, args.policy)
    await tx.query(`UPDATE daily_attendance SET auto_closed = true WHERE employee_id = $1 AND work_date = $2`, [d.employee_id, d.work_date])
    closed++
  }
  return closed
}

// ── control room ─────────────────────────────────────────────────────────────

export interface ControlRoomPerson { employeeId: string; employeeNumber: string; name: string; department: string | null; location: string | null; firstIn: string | null; lastOut: string | null; lateMinutes: number; lateReason: string | null; onBreak: boolean; mode: 'office' | 'wfh' | 'field'; autoClosed: boolean }
export interface ControlRoom {
  date: string
  counts: { expected: number; in: number; out: number; late: number; onBreak: number; missing: number; onLeave: number; remote: number; field: number; weeklyOff: number; holiday: number; autoClosed: number }
  in: ControlRoomPerson[]; late: ControlRoomPerson[]; missing: ControlRoomPerson[]; onLeave: ControlRoomPerson[]; onBreak: ControlRoomPerson[]
  byLocation: Array<{ location: string; expected: number; in: number; missing: number }>
}

export async function controlRoom(tx: PoolClient, args: { date: string; employeeIds?: string[] | null; timezone: string; weekPattern: string }): Promise<ControlRoom> {
  const { rows } = await tx.query<{
    id: string; employee_number: string; name: string; department: string | null; location: string | null
    status: string | null; first_in: string | null; last_out: string | null; late_minutes: number | null; late_reason: string | null; is_remote: boolean | null; is_field_duty: boolean | null; auto_closed: boolean | null
    on_break: boolean; remote_kind: string | null; holiday: boolean; weekly_off_days: number[] | null
  }>(
    `SELECT e.id, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, a.department, a.location_code AS location,
            d.status, d.first_in::text, d.last_out::text, d.late_minutes, d.late_reason, d.is_remote, d.is_field_duty, d.auto_closed,
            EXISTS (SELECT 1 FROM attendance_breaks b WHERE b.employee_id = e.id AND b.ended_at IS NULL) AS on_break,
            (SELECT kind FROM remote_requests r WHERE r.employee_id = e.id AND r.status = 'approved' AND $1::date BETWEEN r.starts_on AND r.ends_on LIMIT 1) AS remote_kind,
            EXISTS (SELECT 1 FROM holidays h WHERE h.holiday_on = $1::date AND NOT h.is_optional AND (h.location IS NULL OR h.location = a.location_code)) AS holiday,
            (SELECT s.weekly_off_days FROM shift_rosters r JOIN shifts s ON (s.tenant_id, s.id) = (r.tenant_id, r.shift_id)
              WHERE r.employee_id = e.id AND r.effective_from <= $1::date AND (r.effective_to IS NULL OR r.effective_to >= $1::date) ORDER BY r.effective_from DESC LIMIT 1) AS weekly_off_days
       FROM employees e
       LEFT JOIN LATERAL (SELECT department, location_code FROM employee_assignments x WHERE x.employee_id = e.id AND x.superseded_at IS NULL AND x.effective_from <= $1::date AND (x.effective_to IS NULL OR x.effective_to >= $1::date) ORDER BY effective_from DESC LIMIT 1) a ON true
       LEFT JOIN daily_attendance d ON d.employee_id = e.id AND d.work_date = $1::date
      WHERE e.status = 'active' AND e.erased_at IS NULL AND e.date_of_joining <= $1::date AND (e.date_of_exit IS NULL OR e.date_of_exit >= $1::date)
        AND ($2::uuid[] IS NULL OR e.id = ANY($2))
      ORDER BY a.department NULLS LAST, name`, [args.date, args.employeeIds ?? null])

  const dow = new Date(args.date + 'T00:00:00Z').getUTCDay()
  const patternOff = args.weekPattern === 'five_day' ? dow === 0 || dow === 6 : args.weekPattern === 'six_day' ? dow === 0
    : args.weekPattern === 'alternate_saturday' ? dow === 0 || (dow === 6 && [2, 4].includes(Math.ceil(Number(args.date.slice(8, 10)) / 7))) : false

  const person = (r: typeof rows[number]): ControlRoomPerson => ({
    employeeId: r.id, employeeNumber: r.employee_number, name: r.name, department: r.department, location: r.location,
    firstIn: r.first_in, lastOut: r.last_out, lateMinutes: r.late_minutes ?? 0, lateReason: r.late_reason, onBreak: r.on_break,
    mode: r.is_field_duty || r.remote_kind === 'field' ? 'field' : r.is_remote || r.remote_kind === 'wfh' ? 'wfh' : 'office', autoClosed: r.auto_closed ?? false,
  })
  const out: ControlRoom = { date: args.date, counts: { expected: 0, in: 0, out: 0, late: 0, onBreak: 0, missing: 0, onLeave: 0, remote: 0, field: 0, weeklyOff: 0, holiday: 0, autoClosed: 0 }, in: [], late: [], missing: [], onLeave: [], onBreak: [], byLocation: [] }
  const loc = new Map<string, { expected: number; in: number; missing: number }>()
  for (const r of rows) {
    const off = r.weekly_off_days ? r.weekly_off_days.includes(dow) : patternOff
    if (r.status === 'holiday' || (r.holiday && !r.first_in)) { out.counts.holiday++; continue }
    if (r.status === 'weekly_off' || (off && !r.first_in && !r.status)) { out.counts.weeklyOff++; continue }
    const p = person(r)
    const l = loc.get(p.location ?? '—') ?? { expected: 0, in: 0, missing: 0 }
    if (r.status === 'on_leave') { out.counts.onLeave++; out.onLeave.push(p); continue }
    out.counts.expected++; l.expected++
    if (p.mode === 'wfh') out.counts.remote++
    if (p.mode === 'field') out.counts.field++
    if (r.first_in) {
      out.counts.in++; l.in++; out.in.push(p)
      if (r.last_out) out.counts.out++
      if ((r.late_minutes ?? 0) > 0) { out.counts.late++; out.late.push(p) }
      if (r.on_break) { out.counts.onBreak++; out.onBreak.push(p) }
      if (r.auto_closed) out.counts.autoClosed++
    } else {
      out.counts.missing++; l.missing++; out.missing.push(p)
    }
    loc.set(p.location ?? '—', l)
  }
  out.byLocation = [...loc].map(([location, v]) => ({ location, ...v })).sort((a, b) => b.expected - a.expected)
  return out
}

// ── QR punch ─────────────────────────────────────────────────────────────────

const SLOT_MS = 60_000
async function qrSecret(tx: PoolClient): Promise<Buffer> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ secret: Buffer }>(`SELECT secret FROM attendance_qr_secrets`)
  if (rows[0]) return rows[0].secret
  const secret = randomBytes(32)
  await tx.query(`INSERT INTO attendance_qr_secrets (tenant_id, secret) VALUES ($1, $2) ON CONFLICT (tenant_id) DO NOTHING`, [tid, secret])
  return (await tx.query<{ secret: Buffer }>(`SELECT secret FROM attendance_qr_secrets`)).rows[0]!.secret
}
const sign = (secret: Buffer, siteId: string, slot: number): string => createHmac('sha256', secret).update(`${siteId}:${slot}`).digest('base64url').slice(0, 12)

/** The code a kiosk shows right now: valid for this minute and the next. */
export async function qrCode(tx: PoolClient, siteId: string, now = new Date()): Promise<{ payload: string; siteId: string; siteName: string; expiresAt: string }> {
  const site = (await tx.query<{ id: string; name: string }>(`SELECT id, name FROM geofence_sites WHERE id = $1 AND status = 'active'`, [siteId])).rows[0]
  if (!site) throw new OpsError('SITE_NOT_FOUND', 'no such active site')
  const slot = Math.floor(now.getTime() / SLOT_MS)
  const code = sign(await qrSecret(tx), siteId, slot)
  return { payload: `pepl:qr:${siteId}:${slot}:${code}`, siteId, siteName: site.name, expiresAt: new Date((slot + 2) * SLOT_MS).toISOString() }
}

/** Verifies a scanned payload; accepts the current slot and the previous one. */
export async function verifyQr(tx: PoolClient, payload: string, now = new Date()): Promise<{ siteId: string }> {
  const m = /^pepl:qr:([0-9a-f-]{36}):(\d+):([A-Za-z0-9_-]{12})$/.exec(payload ?? '')
  if (!m) throw new OpsError('QR_INVALID', 'that is not a PEPL attendance code')
  const [, siteId, slotStr, code] = m as unknown as [string, string, string, string]
  const slot = Number(slotStr), current = Math.floor(now.getTime() / SLOT_MS)
  if (slot > current + 1 || slot < current - 1) throw new OpsError('QR_EXPIRED', 'this code has expired; scan the current one')
  const expected = sign(await qrSecret(tx), siteId, slot)
  if (expected.length !== code.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(code))) throw new OpsError('QR_INVALID', 'this code was not issued here')
  return { siteId }
}

export async function rotateQrSecret(tx: PoolClient): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(`INSERT INTO attendance_qr_secrets (tenant_id, secret) VALUES ($1, $2) ON CONFLICT (tenant_id) DO UPDATE SET secret = EXCLUDED.secret, rotated_at = now()`, [tid, randomBytes(32)])
}
