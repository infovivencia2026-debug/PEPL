/**
 * Projects, allocations, timesheets and the daily work log.
 *
 * Hours are booked by day against a project, inside a weekly timesheet that
 * is submitted whole and approved by the manager through the approval
 * engine. Only an open (or rejected) week can be edited; a submitted one is
 * what the manager sees; an approved one is what reports and billing see.
 * A person books hours only on projects they are allocated to on that day.
 */
import type { PoolClient } from 'pg'
import { createHash } from 'node:crypto'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { notify } from '../comms/index.ts'

export class TimesheetError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'TimesheetError' }
}

const tenantId = async (tx: PoolClient): Promise<string> => {
  const t = (await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')).rows[0]?.t
  if (!t) throw new TimesheetError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

/** A stable uuid for the n-th submission of a sheet (entity ids are uuids). */
export function submissionEntityId(sheetId: string, n: number): string {
  const h = createHash('sha256').update(`timesheet:${sheetId}:${n}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** The Monday on or before a date. */
export function weekStartOf(date: string): string {
  const d = new Date(date + 'T00:00:00Z')
  const back = (d.getUTCDay() + 6) % 7
  d.setUTCDate(d.getUTCDate() - back)
  return d.toISOString().slice(0, 10)
}

// ── projects ─────────────────────────────────────────────────────────────────

export interface Project {
  id: string; code: string; name: string; client: string | null; kind: string; owner_employee_id: string | null
  starts_on: string | null; ends_on: string | null; budget_hours: string | null; billable: boolean; bill_rate_paise_per_hour: string | null; status: string
  /** Derived: approved hours booked so far. */
  approved_hours: string
}
const PROJ_COLS = `p.id, p.code, p.name, p.client, p.kind, p.owner_employee_id, p.starts_on::text, p.ends_on::text, p.budget_hours::text,
  p.billable, p.bill_rate_paise_per_hour::text, p.status,
  coalesce((SELECT sum(e.hours) FROM timesheet_entries e JOIN timesheets t ON (t.tenant_id, t.id) = (e.tenant_id, e.timesheet_id)
            WHERE e.project_id = p.id AND t.status = 'approved'), 0)::text AS approved_hours`

export async function listProjects(tx: PoolClient, opts: { includeClosed?: boolean; employeeId?: string } = {}): Promise<Project[]> {
  const { rows } = await tx.query<Project>(
    `SELECT ${PROJ_COLS} FROM projects p
      WHERE ($1 OR p.status <> 'closed')
        AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM project_allocations a WHERE a.project_id = p.id AND a.employee_id = $2
                                           AND a.starts_on <= CURRENT_DATE AND (a.ends_on IS NULL OR a.ends_on >= CURRENT_DATE)))
      ORDER BY p.status, p.name`, [opts.includeClosed ?? false, opts.employeeId ?? null])
  return rows
}

export async function upsertProject(
  tx: PoolClient,
  args: { code: string; name: string; client?: string | null; kind?: Project['kind']; ownerEmployeeId?: string | null; startsOn?: string | null; endsOn?: string | null
    budgetHours?: number | null; billable?: boolean; billRatePaisePerHour?: number | null; status?: 'active' | 'on_hold' | 'closed' },
): Promise<Project> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) throw new TimesheetError('VALIDATION_FAILED', 'code must be letters, digits, _ or -, up to 24 characters')
  if (!args.name?.trim()) throw new TimesheetError('VALIDATION_FAILED', 'a project needs a name')
  if (args.startsOn && args.endsOn && args.endsOn < args.startsOn) throw new TimesheetError('VALIDATION_FAILED', 'the project ends before it starts')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO projects (tenant_id, code, name, client, kind, owner_employee_id, starts_on, ends_on, budget_hours, billable, bill_rate_paise_per_hour, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, client = EXCLUDED.client, kind = EXCLUDED.kind, owner_employee_id = EXCLUDED.owner_employee_id,
       starts_on = EXCLUDED.starts_on, ends_on = EXCLUDED.ends_on, budget_hours = EXCLUDED.budget_hours, billable = EXCLUDED.billable,
       bill_rate_paise_per_hour = EXCLUDED.bill_rate_paise_per_hour, status = EXCLUDED.status
     RETURNING id`,
    [tid, code, args.name.trim().slice(0, 120), args.client?.trim() || null, args.kind ?? 'client', args.ownerEmployeeId ?? null, args.startsOn ?? null, args.endsOn ?? null,
     args.budgetHours ?? null, args.billable ?? true, args.billRatePaisePerHour ?? null, args.status ?? 'active'])
  return (await listProjects(tx, { includeClosed: true })).find((p) => p.id === rows[0]!.id)!
}

export interface Allocation { id: string; project_id: string; project_code: string; project_name: string; employee_id: string; employee_name: string; role: string | null; percent: number; starts_on: string; ends_on: string | null }

export async function listAllocations(tx: PoolClient, opts: { projectId?: string; employeeId?: string } = {}): Promise<Allocation[]> {
  const { rows } = await tx.query<Allocation>(
    `SELECT a.id, a.project_id, p.code AS project_code, p.name AS project_name, a.employee_id, concat_ws(' ', e.first_name, e.last_name) AS employee_name,
            a.role, a.percent, a.starts_on::text, a.ends_on::text
       FROM project_allocations a
       JOIN projects p ON (p.tenant_id, p.id) = (a.tenant_id, a.project_id)
       JOIN employees e ON (e.tenant_id, e.id) = (a.tenant_id, a.employee_id)
      WHERE ($1::uuid IS NULL OR a.project_id = $1) AND ($2::uuid IS NULL OR a.employee_id = $2)
      ORDER BY a.ends_on IS NOT NULL, a.starts_on DESC`, [opts.projectId ?? null, opts.employeeId ?? null])
  return rows
}

/** A person's allocations must not exceed 100% on any day. */
export async function allocate(
  tx: PoolClient, args: { projectId: string; employeeId: string; role?: string | null; percent?: number; startsOn?: string; endsOn?: string | null },
): Promise<Allocation> {
  const tid = await tenantId(tx)
  const percent = args.percent ?? 100
  const startsOn = args.startsOn ?? new Date().toISOString().slice(0, 10)
  const { rows: total } = await tx.query<{ pct: string }>(
    `SELECT coalesce(sum(percent),0)::text AS pct FROM project_allocations
      WHERE employee_id = $1 AND project_id <> $2 AND starts_on <= coalesce($4::date, DATE '9999-12-31') AND (ends_on IS NULL OR ends_on >= $3::date)`,
    [args.employeeId, args.projectId, startsOn, args.endsOn ?? null])
  if (Number(total[0]!.pct) + percent > 100) {
    throw new TimesheetError('OVER_ALLOCATED', `this person is already ${total[0]!.pct}% allocated in that window; ${percent}% more exceeds 100%`)
  }
  // one open allocation per (project, person): a new one closes the old
  await tx.query(`UPDATE project_allocations SET ends_on = $3::date - 1 WHERE project_id = $1 AND employee_id = $2 AND ends_on IS NULL AND starts_on < $3::date`, [args.projectId, args.employeeId, startsOn])
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO project_allocations (tenant_id, project_id, employee_id, role, percent, starts_on, ends_on) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tid, args.projectId, args.employeeId, args.role?.trim() || null, percent, startsOn, args.endsOn ?? null])
  return (await listAllocations(tx, { employeeId: args.employeeId })).find((a) => a.id === rows[0]!.id)!
}

export async function endAllocation(tx: PoolClient, id: string, endsOn: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE project_allocations SET ends_on = $2 WHERE id = $1 AND (ends_on IS NULL OR ends_on > $2)`, [id, endsOn])
  if (!rowCount) throw new TimesheetError('NOT_FOUND', 'no such open allocation')
}

// ── timesheets ───────────────────────────────────────────────────────────────

export interface Entry { id: string; project_id: string; project_code: string; project_name: string; work_date: string; hours: string; billable: boolean; note: string | null }
export interface Timesheet {
  id: string; employee_id: string; week_start: string; status: string; submitted_at: string | null; decided_at: string | null; comment: string | null
  approval_request_id: string | null; entries: Entry[]; total_hours: string; billable_hours: string
}

async function entriesOf(tx: PoolClient, timesheetId: string): Promise<Entry[]> {
  const { rows } = await tx.query<Entry>(
    `SELECT e.id, e.project_id, p.code AS project_code, p.name AS project_name, e.work_date::text, e.hours::text, e.billable, e.note
       FROM timesheet_entries e JOIN projects p ON (p.tenant_id, p.id) = (e.tenant_id, e.project_id)
      WHERE e.timesheet_id = $1 ORDER BY e.work_date, p.name`, [timesheetId])
  return rows
}

async function hydrate(tx: PoolClient, row: Omit<Timesheet, 'entries' | 'total_hours' | 'billable_hours'>): Promise<Timesheet> {
  const entries = await entriesOf(tx, row.id)
  const total = entries.reduce((s, e) => s + Number(e.hours), 0)
  const billable = entries.filter((e) => e.billable).reduce((s, e) => s + Number(e.hours), 0)
  return { ...row, entries, total_hours: total.toFixed(2), billable_hours: billable.toFixed(2) }
}

const TS_COLS = `id, employee_id, week_start::text, status, submitted_at::text, decided_at::text, comment, approval_request_id`

/** The week's sheet, created open if it does not exist yet. */
export async function getWeek(tx: PoolClient, employeeId: string, anyDateInWeek: string): Promise<Timesheet> {
  const tid = await tenantId(tx)
  const weekStart = weekStartOf(anyDateInWeek)
  await tx.query(`INSERT INTO timesheets (tenant_id, employee_id, week_start) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tid, employeeId, weekStart])
  const { rows } = await tx.query<Omit<Timesheet, 'entries' | 'total_hours' | 'billable_hours'>>(
    `SELECT ${TS_COLS} FROM timesheets WHERE employee_id = $1 AND week_start = $2`, [employeeId, weekStart])
  return hydrate(tx, rows[0]!)
}

export async function getTimesheet(tx: PoolClient, id: string): Promise<Timesheet | null> {
  const { rows } = await tx.query<Omit<Timesheet, 'entries' | 'total_hours' | 'billable_hours'>>(`SELECT ${TS_COLS} FROM timesheets WHERE id = $1`, [id])
  return rows[0] ? hydrate(tx, rows[0]) : null
}

export async function listTimesheets(
  tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string; limit?: number },
): Promise<Timesheet[]> {
  const { rows } = await tx.query<Omit<Timesheet, 'entries' | 'total_hours' | 'billable_hours'>>(
    `SELECT ${TS_COLS} FROM timesheets
      WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY week_start DESC LIMIT $4`, [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null, Math.min(args.limit ?? 26, 200)])
  const out: Timesheet[] = []
  for (const r of rows) out.push(await hydrate(tx, r))
  return out
}

/**
 * Sets the hours for one project on one day (0 removes the entry). The week
 * must be open or rejected; the person must be allocated to the project on
 * that day; a day cannot exceed 24 hours across projects.
 */
export async function setHours(
  tx: PoolClient, args: { employeeId: string; projectId: string; workDate: string; hours: number; billable?: boolean; note?: string | null },
): Promise<Timesheet> {
  const tid = await tenantId(tx)
  if (!Number.isFinite(args.hours) || args.hours < 0 || args.hours > 24) throw new TimesheetError('VALIDATION_FAILED', 'hours must be between 0 and 24')
  const sheet = await getWeek(tx, args.employeeId, args.workDate)
  if (!['open', 'rejected'].includes(sheet.status)) throw new TimesheetError('TIMESHEET_LOCKED', `week of ${sheet.week_start} is ${sheet.status}; it cannot be edited`)
  if (args.hours === 0) {
    await tx.query(`DELETE FROM timesheet_entries WHERE timesheet_id = $1 AND project_id = $2 AND work_date = $3`, [sheet.id, args.projectId, args.workDate])
    return (await getTimesheet(tx, sheet.id))!
  }
  const proj = (await tx.query<{ billable: boolean; status: string }>(`SELECT billable, status FROM projects WHERE id = $1`, [args.projectId])).rows[0]
  if (!proj) throw new TimesheetError('PROJECT_NOT_FOUND', 'no such project')
  if (proj.status !== 'active') throw new TimesheetError('PROJECT_INACTIVE', 'hours can only be booked to an active project')
  const alloc = await tx.query(
    `SELECT 1 FROM project_allocations WHERE project_id = $1 AND employee_id = $2 AND starts_on <= $3::date AND (ends_on IS NULL OR ends_on >= $3::date)`,
    [args.projectId, args.employeeId, args.workDate])
  if (!alloc.rowCount) throw new TimesheetError('NOT_ALLOCATED', 'you are not allocated to that project on that day')
  const { rows: day } = await tx.query<{ h: string }>(
    `SELECT coalesce(sum(hours),0)::text AS h FROM timesheet_entries WHERE timesheet_id = $1 AND work_date = $2 AND project_id <> $3`, [sheet.id, args.workDate, args.projectId])
  if (Number(day[0]!.h) + args.hours > 24) throw new TimesheetError('OVER_24_HOURS', `that would be ${Number(day[0]!.h) + args.hours} hours on ${args.workDate}`)
  await tx.query(
    `INSERT INTO timesheet_entries (tenant_id, timesheet_id, project_id, work_date, hours, billable, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, timesheet_id, project_id, work_date) DO UPDATE SET hours = EXCLUDED.hours, billable = EXCLUDED.billable, note = EXCLUDED.note`,
    [tid, sheet.id, args.projectId, args.workDate, args.hours, args.billable ?? proj.billable, args.note?.trim().slice(0, 500) || null])
  return (await getTimesheet(tx, sheet.id))!
}

export async function submitWeek(
  tx: PoolClient, args: { employeeId: string; weekStart: string; requestedByUserId: string; fallbackChain: ChainCode },
): Promise<Timesheet> {
  const sheet = await getWeek(tx, args.employeeId, args.weekStart)
  if (!['open', 'rejected'].includes(sheet.status)) throw new TimesheetError('TIMESHEET_LOCKED', `week of ${sheet.week_start} is already ${sheet.status}`)
  if (!sheet.entries.length) throw new TimesheetError('TIMESHEET_EMPTY', 'book some hours before submitting')
  // Each submission is its own approval entity: a week sent back and
  // resubmitted must not collide with the request the first submission raised.
  const { rows: sub } = await tx.query<{ n: number }>(`UPDATE timesheets SET submission_no = submission_no + 1 WHERE id = $1 RETURNING submission_no AS n`, [sheet.id])
  const approval = await raiseWithPolicy(tx, {
    entityType: 'timesheet', entityId: submissionEntityId(sheet.id, sub[0]!.n), requestedByUserId: args.requestedByUserId, subjectEmployeeId: args.employeeId,
    magnitude: Number(sheet.total_hours), fallback: args.fallbackChain,
    title: `Timesheet · week of ${sheet.week_start} · ${sheet.total_hours}h`,
  })
  await tx.query(`UPDATE timesheets SET status = 'submitted', submitted_at = now(), approval_request_id = $2, comment = NULL WHERE id = $1`, [sheet.id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleTimesheetDecision(tx, { timesheetId: sheet.id, status: 'approved', actorUserId: args.requestedByUserId })
  return (await getTimesheet(tx, sheet.id))!
}

/**
 * After the approval engine decides. Looks the sheet up by EITHER its id or the
 * approval request id (the decision routes only know the request), and only a
 * submitted sheet moves.
 */
export async function settleTimesheetDecision(
  tx: PoolClient, args: { timesheetId?: string; approvalRequestId?: string; status: 'approved' | 'rejected'; actorUserId: string; comment?: string | null },
): Promise<{ changed: boolean; timesheetId?: string }> {
  const { rows } = await tx.query<{ id: string; employee_id: string; week_start: string }>(
    `UPDATE timesheets SET status = $2, decided_at = now(), decided_by_user_id = $3, comment = $4
      WHERE ((($1::uuid IS NOT NULL) AND id = $1) OR (($5::uuid IS NOT NULL) AND approval_request_id = $5)) AND status = 'submitted'
      RETURNING id, employee_id, week_start::text`, [args.timesheetId ?? null, args.status, args.actorUserId, args.comment ?? null, args.approvalRequestId ?? null])
  if (!rows[0]) return { changed: false }
  const applicant = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [rows[0].employee_id])).rows[0]?.id
  if (applicant) {
    await notify(tx, {
      userId: applicant, eventType: `timesheet.${args.status}`,
      title: args.status === 'approved' ? 'Timesheet approved' : 'Timesheet sent back',
      body: `Week of ${rows[0].week_start}${args.comment ? ` — ${args.comment}` : ''}`,
      entityType: 'timesheet', entityId: rows[0].id, dedupeKey: `timesheet-${args.status}:${rows[0].id}:${Date.now()}`,
    })
  }
  return { changed: true, timesheetId: rows[0].id }
}

/** Approved hours by project for a date range — utilisation, billing, project profitability. */
export async function hoursReport(
  tx: PoolClient, args: { from: string; to: string; projectId?: string; employeeIds?: string[] | null },
): Promise<{ project_code: string; project_name: string; client: string | null; employee_number: string; employee_name: string; hours: string; billable_hours: string; billable_paise: string }[]> {
  const { rows } = await tx.query(
    `SELECT p.code AS project_code, p.name AS project_name, p.client, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS employee_name,
            sum(te.hours)::text AS hours, sum(te.hours) FILTER (WHERE te.billable)::text AS billable_hours,
            (coalesce(sum(te.hours) FILTER (WHERE te.billable), 0) * coalesce(p.bill_rate_paise_per_hour, 0))::bigint::text AS billable_paise
       FROM timesheet_entries te
       JOIN timesheets t ON (t.tenant_id, t.id) = (te.tenant_id, te.timesheet_id) AND t.status = 'approved'
       JOIN projects p ON (p.tenant_id, p.id) = (te.tenant_id, te.project_id)
       JOIN employees e ON (e.tenant_id, e.id) = (t.tenant_id, t.employee_id)
      WHERE te.work_date BETWEEN $1::date AND $2::date
        AND ($3::uuid IS NULL OR p.id = $3)
        AND ($4::uuid[] IS NULL OR t.employee_id = ANY($4))
      GROUP BY p.code, p.name, p.client, p.bill_rate_paise_per_hour, e.employee_number, e.first_name, e.last_name
      ORDER BY p.code, e.employee_number`, [args.from, args.to, args.projectId ?? null, args.employeeIds ?? null])
  return rows
}

// ── work log ─────────────────────────────────────────────────────────────────

export interface WorkLog { id: string; employee_id: string; work_date: string; project_id: string | null; done: string; blockers: string | null; next_plan: string | null; updated_at: string }

export async function writeWorkLog(
  tx: PoolClient, args: { employeeId: string; workDate: string; projectId?: string | null; done: string; blockers?: string | null; nextPlan?: string | null },
): Promise<WorkLog> {
  const tid = await tenantId(tx)
  if (!args.done?.trim()) throw new TimesheetError('VALIDATION_FAILED', 'say what was done')
  const { rows } = await tx.query<WorkLog>(
    `INSERT INTO work_logs (tenant_id, employee_id, work_date, project_id, done, blockers, next_plan)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, employee_id, work_date, project_id) DO UPDATE SET done = EXCLUDED.done, blockers = EXCLUDED.blockers, next_plan = EXCLUDED.next_plan, updated_at = now()
     RETURNING id, employee_id, work_date::text, project_id, done, blockers, next_plan, updated_at::text`,
    [tid, args.employeeId, args.workDate, args.projectId ?? null, args.done.trim().slice(0, 4000), args.blockers?.trim().slice(0, 2000) || null, args.nextPlan?.trim().slice(0, 2000) || null])
  return rows[0]!
}

export async function listWorkLogs(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; from: string; to: string }): Promise<WorkLog[]> {
  const { rows } = await tx.query<WorkLog>(
    `SELECT id, employee_id, work_date::text, project_id, done, blockers, next_plan, updated_at::text FROM work_logs
      WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND work_date BETWEEN $3::date AND $4::date
      ORDER BY work_date DESC, updated_at DESC LIMIT 500`, [args.employeeIds ?? null, args.employeeId ?? null, args.from, args.to])
  return rows
}
