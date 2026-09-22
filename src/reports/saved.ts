/**
 * Saved reports and schedules. A schedule runs AS ITS OWNER — their authz
 * context is rebuilt from the database at run time, so a manager who left
 * the company stops receiving other people's data the same day.
 */
import type { PoolClient } from 'pg'
import type { AuthzContext } from '../authz/permissions.ts'
import { loadAuthzContext } from '../auth/index.ts'
import { putDocument } from '../documents/index.ts'
import { senderAccount } from '../comms/delivery.ts'
import { sendMail } from '../mail/index.ts'
import { compile, runReport, type Spec, ReportError } from './builder.ts'

const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface SavedReport { id: string; name: string; description: string | null; spec: Spec; owner_user_id: string; owner_name: string; shared: boolean; created_at: string; updated_at: string; schedules: number }
const S_COLS = `s.id, s.name, s.description, s.spec, s.owner_user_id, (SELECT full_name FROM app_users u WHERE u.id = s.owner_user_id) AS owner_name, s.shared, s.created_at::text, s.updated_at::text, (SELECT count(*)::int FROM report_schedules r WHERE (r.tenant_id, r.report_id) = (s.tenant_id, s.id) AND r.status = 'active') AS schedules`

export async function saveReport(tx: PoolClient, auth: AuthzContext, args: { id?: string; name: string; description?: string | null; spec: Spec; shared?: boolean }): Promise<SavedReport> {
  const tid = await tenantId(tx)
  const name = args.name?.trim()
  if (!name) throw new ReportError('VALIDATION_FAILED', 'name is required')
  compile(args.spec, auth)   // validates model, fields and the caller's right to it
  if (args.id) {
    const r = await tx.query(`UPDATE saved_reports SET name = $2, description = $3, spec = $4::jsonb, shared = $5, updated_at = now() WHERE id = $1 AND owner_user_id = $6`, [args.id, name, args.description ?? null, JSON.stringify(args.spec), args.shared ?? false, auth.userId])
    if (!r.rowCount) throw new ReportError('NOT_FOUND', 'no such report of yours')
    return (await getReport(tx, auth, args.id))!
  }
  if ((await tx.query(`SELECT 1 FROM saved_reports WHERE owner_user_id = $1 AND name = $2`, [auth.userId, name])).rowCount) throw new ReportError('REPORT_EXISTS', 'you already have a report by that name')
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO saved_reports (tenant_id, name, description, spec, owner_user_id, shared) VALUES ($1,$2,$3,$4::jsonb,$5,$6) RETURNING id`, [tid, name, args.description ?? null, JSON.stringify(args.spec), auth.userId, args.shared ?? false])
  return (await getReport(tx, auth, rows[0]!.id))!
}
/** Mine, plus shared ones whose model I may read. */
export async function listReports(tx: PoolClient, auth: AuthzContext): Promise<SavedReport[]> {
  const rows = (await tx.query<SavedReport>(`SELECT ${S_COLS} FROM saved_reports s WHERE s.owner_user_id = $1 OR s.shared ORDER BY s.name`, [auth.userId])).rows
  return rows.filter((r) => { try { compile(r.spec, auth); return true } catch { return false } })
}
export async function getReport(tx: PoolClient, auth: AuthzContext, id: string): Promise<SavedReport | null> {
  const r = (await tx.query<SavedReport>(`SELECT ${S_COLS} FROM saved_reports s WHERE s.id = $1 AND (s.owner_user_id = $2 OR s.shared)`, [id, auth.userId])).rows[0]
  if (!r) return null
  compile(r.spec, auth)
  return r
}
export async function deleteReport(tx: PoolClient, auth: AuthzContext, id: string): Promise<void> {
  const r = await tx.query(`DELETE FROM saved_reports WHERE id = $1 AND owner_user_id = $2`, [id, auth.userId])
  if (!r.rowCount) throw new ReportError('NOT_FOUND', 'no such report of yours')
}

export interface Schedule { id: string; report_id: string; report_name: string; frequency: 'daily' | 'weekly' | 'monthly'; day_of_week: number | null; day_of_month: number | null; hour: number; recipients: string[]; format: string; status: string; next_run_on: string; last_run_at: string | null; last_error: string | null; created_by_user_id: string }
const SC_COLS = `sc.id, sc.report_id, (SELECT name FROM saved_reports s WHERE (s.tenant_id, s.id) = (sc.tenant_id, sc.report_id)) AS report_name, sc.frequency, sc.day_of_week, sc.day_of_month, sc.hour, sc.recipients, sc.format, sc.status, sc.next_run_on::text, sc.last_run_at::text, sc.last_error, sc.created_by_user_id`

/** The next date on or after `from` matching the cadence. */
export function nextRunOn(s: Pick<Schedule, 'frequency' | 'day_of_week' | 'day_of_month'>, from: string): string {
  const d = new Date(from + 'T00:00:00Z')
  if (s.frequency === 'daily') return d.toISOString().slice(0, 10)
  if (s.frequency === 'weekly') { const want = s.day_of_week ?? 1; while (d.getUTCDay() !== want) d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10) }
  const want = s.day_of_month ?? 1
  if (d.getUTCDate() > want) { d.setUTCMonth(d.getUTCMonth() + 1) }
  d.setUTCDate(want)
  return d.toISOString().slice(0, 10)
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
export async function createSchedule(tx: PoolClient, auth: AuthzContext, args: { reportId: string; frequency: Schedule['frequency']; dayOfWeek?: number | null; dayOfMonth?: number | null; hour?: number; recipients: string[]; today?: string }): Promise<Schedule> {
  const tid = await tenantId(tx)
  const report = (await tx.query<{ owner_user_id: string }>(`SELECT owner_user_id FROM saved_reports WHERE id = $1`, [args.reportId])).rows[0]
  if (!report || report.owner_user_id !== auth.userId) throw new ReportError('NOT_FOUND', 'schedule your own report')
  if (!['daily', 'weekly', 'monthly'].includes(args.frequency)) throw new ReportError('VALIDATION_FAILED', 'frequency is daily, weekly or monthly')
  const recipients = [...new Set((args.recipients ?? []).map((r) => r.trim().toLowerCase()).filter(Boolean))]
  if (!recipients.length || recipients.length > 20 || recipients.some((r) => !EMAIL.test(r))) throw new ReportError('VALIDATION_FAILED', '1–20 valid email recipients')
  const s = { frequency: args.frequency, day_of_week: args.frequency === 'weekly' ? (args.dayOfWeek ?? 1) : null, day_of_month: args.frequency === 'monthly' ? (args.dayOfMonth ?? 1) : null }
  const today = args.today ?? new Date().toISOString().slice(0, 10)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO report_schedules (tenant_id, report_id, frequency, day_of_week, day_of_month, hour, recipients, next_run_on, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [tid, args.reportId, s.frequency, s.day_of_week, s.day_of_month, args.hour ?? 7, recipients, nextRunOn(s, today), auth.userId])
  return (await tx.query<Schedule>(`SELECT ${SC_COLS} FROM report_schedules sc WHERE sc.id = $1`, [rows[0]!.id])).rows[0]!
}
export async function listSchedules(tx: PoolClient, auth: AuthzContext): Promise<Schedule[]> {
  return (await tx.query<Schedule>(`SELECT ${SC_COLS} FROM report_schedules sc WHERE sc.created_by_user_id = $1 ORDER BY sc.next_run_on`, [auth.userId])).rows
}
export async function setScheduleStatus(tx: PoolClient, auth: AuthzContext, id: string, status: 'active' | 'paused' | 'deleted'): Promise<void> {
  const r = status === 'deleted' ? await tx.query(`DELETE FROM report_schedules WHERE id = $1 AND created_by_user_id = $2`, [id, auth.userId])
    : await tx.query(`UPDATE report_schedules SET status = $3 WHERE id = $1 AND created_by_user_id = $2`, [id, auth.userId, status])
  if (!r.rowCount) throw new ReportError('NOT_FOUND', 'no such schedule of yours')
}

/**
 * Run every schedule due today whose hour has come. Each runs as its owner;
 * the CSV becomes a tenant document and is mailed from the company's sender
 * mailbox. A schedule whose owner can no longer read the model is paused with
 * the reason, not silently skipped.
 */
export async function runDueSchedules(tx: PoolClient, args: { tenantId: string; senderEmail: string | null; companyName: string; now?: Date }): Promise<number> {
  const now = args.now ?? new Date()
  const today = now.toISOString().slice(0, 10)
  const due = (await tx.query<Schedule & { spec: Spec; owner_user_id: string }>(
    `SELECT ${SC_COLS}, s.spec, s.owner_user_id FROM report_schedules sc JOIN saved_reports s ON (s.tenant_id, s.id) = (sc.tenant_id, sc.report_id)
      WHERE sc.status = 'active' AND sc.next_run_on <= $1::date AND sc.hour <= $2`, [today, now.getUTCHours() + 6])).rows   // hours are IST-ish (UTC+5:30 rounded)
  let sent = 0
  for (const s of due) {
    const advance = (): string => { const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return nextRunOn(s, d.toISOString().slice(0, 10)) }
    try {
      const owner = (await tx.query<{ status: string }>(`SELECT status FROM app_users WHERE id = $1`, [s.owner_user_id])).rows[0]
      if (!owner || owner.status !== 'active') throw new ReportError('OWNER_INACTIVE', 'the report owner is no longer active')
      const auth = await loadAuthzContext(tx, { tenantId: args.tenantId, userId: s.owner_user_id, sessionId: `schedule:${s.id}` })
      const result = await runReport(tx, s.spec, auth)
      const fileName = `${s.report_name.replace(/[^\w.-]+/g, '_')}-${today}.csv`
      const doc = await putDocument(tx, { ownerType: 'tenant', fileName, contentType: 'text/csv', bytes: Buffer.from(result.csv), category: 'report', uploadedByUserId: s.owner_user_id })
      const sender = await senderAccount(tx, args.senderEmail)
      if (!sender) throw new ReportError('NO_SENDER', 'no sender mailbox is configured (notifications.sender_email)')
      await sendMail(tx, { account: sender, userId: sender.user_id, idempotencyKey: `report-schedule:${s.id}:${today}`, allowExternal: true,
        draft: { to: s.recipients, subject: `${s.report_name} — ${today}`, bodyHtml: `<p>${args.companyName}: the scheduled report <b>${s.report_name}</b> for ${today} is attached (${result.total} rows${result.truncated ? ', truncated' : ''}).</p>`, attachmentDocumentIds: [doc.id] } })
      await tx.query(`UPDATE report_schedules SET last_run_at = now(), last_error = NULL, next_run_on = $2 WHERE id = $1`, [s.id, advance()])
      sent++
    } catch (err) {
      const e = err as { code?: string; message: string }
      const pause = e.code === 'PERMISSION_DENIED' || e.code === 'OWNER_INACTIVE'
      await tx.query(`UPDATE report_schedules SET last_run_at = now(), last_error = $2, status = CASE WHEN $3 THEN 'paused' ELSE status END, next_run_on = CASE WHEN $3 THEN next_run_on ELSE $4::date END WHERE id = $1`, [s.id, e.message.slice(0, 500), pause, advance()])
    }
  }
  return sent
}
