/**
 * Work reports: one table, template-defined fields.
 *
 * A construction DPR, a trainer's session log and a sales visit report differ
 * only in their fields. A template declares them (typed, required, options);
 * a report is validated against its template and reviewed by the manager.
 * Defaults are seeded per organisation type on first use, which is how a
 * preset gives a school a session log without a line of school code.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { currentPosting } from '../people/profile.ts'

export class ReportError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ReportError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface Field { key: string; label: string; type: 'text' | 'number' | 'date' | 'choice' | 'photo' | 'geo' | 'boolean'; required?: boolean; options?: string[] }
export interface ReportTemplate { id: string; code: string; name: string; frequency: string; fields: Field[]; applies_to: { departments?: string[]; designations?: string[] }; status: string }
const T_COLS = `id, code, name, frequency, fields, applies_to, status`

export const DEFAULT_TEMPLATES: Record<string, Array<Omit<ReportTemplate, 'id' | 'status'>>> = {
  manufacturing: [{ code: 'DPR', name: 'Daily progress report', frequency: 'daily', applies_to: {}, fields: [
    { key: 'site', label: 'Site / block', type: 'text', required: true }, { key: 'manpower', label: 'Manpower on site', type: 'number', required: true },
    { key: 'work_done', label: 'Work done today', type: 'text', required: true }, { key: 'materials', label: 'Materials received', type: 'text' },
    { key: 'incidents', label: 'Safety incidents', type: 'boolean', required: true }, { key: 'blockers', label: 'Blockers', type: 'text' }, { key: 'photos', label: 'Site photos', type: 'photo' }] }],
  education: [{ code: 'SESSION', name: 'Session log', frequency: 'per_visit', applies_to: {}, fields: [
    { key: 'batch', label: 'Batch / class', type: 'text', required: true }, { key: 'topic', label: 'Topic covered', type: 'text', required: true },
    { key: 'students', label: 'Students present', type: 'number', required: true }, { key: 'homework', label: 'Homework given', type: 'boolean' }, { key: 'notes', label: 'Notes', type: 'text' }] }],
  field_sales: [{ code: 'VISIT', name: 'Visit report', frequency: 'per_visit', applies_to: {}, fields: [
    { key: 'account', label: 'Client / institution', type: 'text', required: true }, { key: 'contact', label: 'Person met', type: 'text', required: true },
    { key: 'outcome', label: 'Outcome', type: 'choice', required: true, options: ['Demo done', 'Proposal sent', 'Follow-up', 'Closed won', 'Closed lost'] },
    { key: 'next_step', label: 'Next step', type: 'text' }, { key: 'next_date', label: 'Next visit on', type: 'date' }, { key: 'location', label: 'Location', type: 'geo' }] }],
  agency: [{ code: 'STANDUP', name: 'Daily stand-up', frequency: 'daily', applies_to: {}, fields: [
    { key: 'yesterday', label: 'Done yesterday', type: 'text', required: true }, { key: 'today', label: 'Plan for today', type: 'text', required: true }, { key: 'blockers', label: 'Blockers', type: 'text' }] }],
}

const FIELD_TYPES = new Set(['text', 'number', 'date', 'choice', 'photo', 'geo', 'boolean'])
function validateFields(fields: Field[]): void {
  if (!Array.isArray(fields) || !fields.length || fields.length > 40) throw new ReportError('VALIDATION_FAILED', '1–40 fields')
  const keys = new Set<string>()
  for (const f of fields) {
    if (!/^[a-z][a-z0-9_]{0,30}$/.test(f.key ?? '')) throw new ReportError('VALIDATION_FAILED', `field key "${f.key}" must be snake_case`)
    if (keys.has(f.key)) throw new ReportError('VALIDATION_FAILED', `field key "${f.key}" repeats`)
    keys.add(f.key)
    if (!f.label?.trim()) throw new ReportError('VALIDATION_FAILED', `field ${f.key} needs a label`)
    if (!FIELD_TYPES.has(f.type)) throw new ReportError('VALIDATION_FAILED', `field ${f.key}: unknown type ${f.type}`)
    if (f.type === 'choice' && !(f.options?.length)) throw new ReportError('VALIDATION_FAILED', `field ${f.key}: choice needs options`)
  }
}

export async function listTemplates(tx: PoolClient, includeRetired = false): Promise<ReportTemplate[]> {
  const tid = await tenantId(tx)
  if ((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM report_templates`)).rows[0]!.n === '0') {
    const type = (await tx.query<{ t: string | null }>(`SELECT organisation_type AS t FROM tenants`)).rows[0]?.t
    for (const d of DEFAULT_TEMPLATES[type ?? ''] ?? []) {
      await tx.query(`INSERT INTO report_templates (tenant_id, code, name, frequency, fields, applies_to) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) ON CONFLICT (tenant_id, code) DO NOTHING`, [tid, d.code, d.name, d.frequency, JSON.stringify(d.fields), JSON.stringify(d.applies_to)])
    }
  }
  return (await tx.query<ReportTemplate>(`SELECT ${T_COLS} FROM report_templates WHERE $1 OR status = 'active' ORDER BY name`, [includeRetired])).rows
}
export async function upsertTemplate(tx: PoolClient, args: { code: string; name: string; frequency?: ReportTemplate['frequency']; fields: Field[]; appliesTo?: ReportTemplate['applies_to'] }): Promise<ReportTemplate> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 24)
  if (!code || !args.name?.trim()) throw new ReportError('VALIDATION_FAILED', 'code and name are required')
  validateFields(args.fields)
  const { rows } = await tx.query<ReportTemplate>(
    `INSERT INTO report_templates (tenant_id, code, name, frequency, fields, applies_to) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, frequency = EXCLUDED.frequency, fields = EXCLUDED.fields, applies_to = EXCLUDED.applies_to, status = 'active' RETURNING ${T_COLS}`,
    [tid, code, args.name.trim(), args.frequency ?? 'daily', JSON.stringify(args.fields), JSON.stringify(args.appliesTo ?? {})])
  return rows[0]!
}
export async function retireTemplate(tx: PoolClient, code: string): Promise<void> {
  const r = await tx.query(`UPDATE report_templates SET status = 'retired' WHERE code = $1 AND status = 'active'`, [code])
  if (!r.rowCount) throw new ReportError('NOT_FOUND', 'no such active template')
}

export interface WorkReport { id: string; template_id: string; template_code: string; employee_id: string; employee_name: string; report_date: string; project_id: string | null; values: Record<string, unknown>; geo_lat: number | null; geo_lng: number | null; photo_document_ids: string[]; status: string; review_note: string | null; reviewed_by_user_id: string | null; reviewed_at: string | null; submitted_at: string }
const R_COLS = `r.id, r.template_id, t.code AS template_code, r.employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = r.employee_id) AS employee_name, r.report_date::text, r.project_id, r.values, r.geo_lat, r.geo_lng, r.photo_document_ids, r.status, r.review_note, r.reviewed_by_user_id, r.reviewed_at::text, r.submitted_at::text`
const R_FROM = `FROM work_reports r JOIN report_templates t ON (t.tenant_id, t.id) = (r.tenant_id, r.template_id)`

function clean(fields: Field[], values: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    const v = values?.[f.key]
    const empty = v === undefined || v === null || v === ''
    if (empty) { if (f.required) throw new ReportError('VALIDATION_FAILED', `${f.label} is required`); continue }
    switch (f.type) {
      case 'number': if (typeof v !== 'number' || !Number.isFinite(v)) throw new ReportError('VALIDATION_FAILED', `${f.label} must be a number`); out[f.key] = v; break
      case 'date': if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new ReportError('VALIDATION_FAILED', `${f.label} must be a date`); out[f.key] = String(v); break
      case 'choice': if (!f.options!.includes(String(v))) throw new ReportError('VALIDATION_FAILED', `${f.label}: not an option`); out[f.key] = String(v); break
      case 'boolean': out[f.key] = v === true || v === 'true'; break
      case 'geo': { const g = v as { lat?: number; lng?: number }; if (typeof g?.lat !== 'number' || typeof g?.lng !== 'number') throw new ReportError('VALIDATION_FAILED', `${f.label} needs lat and lng`); out[f.key] = { lat: g.lat, lng: g.lng }; break }
      case 'photo': out[f.key] = Array.isArray(v) ? v.map(String).slice(0, 20) : [String(v)]; break
      default: out[f.key] = String(v).slice(0, 4000)
    }
  }
  return out
}

export async function submitReport(tx: PoolClient, args: { templateCode: string; employeeId: string; reportDate: string; values: Record<string, unknown>; projectId?: string | null; geo?: { lat: number; lng: number } | null; photoDocumentIds?: string[] }): Promise<WorkReport> {
  const tid = await tenantId(tx)
  const t = (await listTemplates(tx)).find((x) => x.code === args.templateCode)
  if (!t) throw new ReportError('NOT_FOUND', 'no such report template')
  if (t.applies_to.departments?.length || t.applies_to.designations?.length) {
    const p = await currentPosting(tx, args.employeeId)
    if ((t.applies_to.departments?.length && !t.applies_to.departments.includes(p?.department ?? '')) || (t.applies_to.designations?.length && !t.applies_to.designations.includes(p?.designation ?? ''))) throw new ReportError('NOT_APPLICABLE', 'this report is not for your role')
  }
  if (t.frequency === 'daily' && (await tx.query(`SELECT 1 FROM work_reports WHERE template_id = $1 AND employee_id = $2 AND report_date = $3`, [t.id, args.employeeId, args.reportDate])).rowCount) throw new ReportError('REPORT_EXISTS', 'you already filed this report for that day')
  const values = clean(t.fields, args.values ?? {})
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO work_reports (tenant_id, template_id, employee_id, report_date, project_id, values, geo_lat, geo_lng, photo_document_ids) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9::uuid[]) RETURNING id`,
    [tid, t.id, args.employeeId, args.reportDate, args.projectId ?? null, JSON.stringify(values), args.geo?.lat ?? null, args.geo?.lng ?? null, args.photoDocumentIds ?? []])
  return (await tx.query<WorkReport>(`SELECT ${R_COLS} ${R_FROM} WHERE r.id = $1`, [rows[0]!.id])).rows[0]!
}
export async function reviewReport(tx: PoolClient, args: { reportId: string; status: 'reviewed' | 'returned'; note?: string; actorUserId: string }): Promise<WorkReport> {
  if (args.status === 'returned' && !args.note?.trim()) throw new ReportError('VALIDATION_FAILED', 'say what to fix')
  const { rows } = await tx.query<{ employee_id: string; report_date: string }>(`UPDATE work_reports SET status = $2, review_note = $3, reviewed_by_user_id = $4, reviewed_at = now() WHERE id = $1 AND status = 'submitted' RETURNING employee_id, report_date::text`, [args.reportId, args.status, args.note?.trim() || null, args.actorUserId])
  if (!rows[0]) throw new ReportError('NOT_FOUND', 'no such submitted report')
  if (args.status === 'returned') {
    const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [rows[0].employee_id])).rows[0]?.id
    if (u) await notify(tx, { userId: u, eventType: 'report.returned', title: `Your report for ${rows[0].report_date} was returned`, body: args.note ?? undefined, entityType: 'work_report', entityId: args.reportId, dedupeKey: `report:returned:${args.reportId}` })
  }
  return (await tx.query<WorkReport>(`SELECT ${R_COLS} ${R_FROM} WHERE r.id = $1`, [args.reportId])).rows[0]!
}
export async function listReports(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; templateCode?: string; from?: string; to?: string; status?: string; projectId?: string }): Promise<WorkReport[]> {
  return (await tx.query<WorkReport>(
    `SELECT ${R_COLS} ${R_FROM} WHERE ($1::uuid[] IS NULL OR r.employee_id = ANY($1)) AND ($2::uuid IS NULL OR r.employee_id = $2) AND ($3::text IS NULL OR t.code = $3)
        AND ($4::date IS NULL OR r.report_date >= $4) AND ($5::date IS NULL OR r.report_date <= $5) AND ($6::text IS NULL OR r.status = $6) AND ($7::uuid IS NULL OR r.project_id = $7)
      ORDER BY r.report_date DESC, r.submitted_at DESC LIMIT 500`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.templateCode ?? null, args.from ?? null, args.to ?? null, args.status ?? null, args.projectId ?? null])).rows
}
/** Who has not filed a daily report today — the supervisor's morning list. */
export async function missingDaily(tx: PoolClient, args: { templateCode: string; date: string; employeeIds?: string[] | null }): Promise<Array<{ employeeId: string; name: string }>> {
  const { rows } = await tx.query<{ id: string; name: string }>(
    `SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS name FROM employees e
      WHERE e.status = 'active' AND e.erased_at IS NULL AND ($3::uuid[] IS NULL OR e.id = ANY($3))
        AND NOT EXISTS (SELECT 1 FROM work_reports r JOIN report_templates t ON t.id = r.template_id WHERE r.employee_id = e.id AND t.code = $1 AND r.report_date = $2::date)
        AND EXISTS (SELECT 1 FROM daily_attendance d WHERE d.employee_id = e.id AND d.work_date = $2::date AND d.first_in IS NOT NULL)
      ORDER BY name`, [args.templateCode, args.date, args.employeeIds ?? null])
  return rows.map((r) => ({ employeeId: r.id, name: r.name }))
}
