/**
 * Report builder: a SPEC over a declared READ MODEL becomes a parameterised
 * query. Nothing from the spec reaches the SQL text except whitelisted field
 * and function names; values are always bound. Every model names its
 * employee column so a manager's report is cut to their scope by construction,
 * and its permission so the money models stay with the roles that hold them.
 */
import type { PoolClient } from 'pg'
import type { AuthzContext, Permission } from '../authz/permissions.ts'
import { can } from '../authz/permissions.ts'
import { csvCell } from '../lib/csv.ts'

export class ReportError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ReportError' }
}

export type FieldType = 'text' | 'number' | 'money' | 'date' | 'boolean'
export interface Field { key: string; label: string; type: FieldType; sql: string; dimension?: boolean }
export interface ReadModel { key: string; label: string; permission: Permission; from: string; employeeColumn: string | null; fields: Field[]; defaultColumns: string[]; help: string }

const posting = `LEFT JOIN LATERAL (SELECT department, designation, location_code, grade_code, manager_employee_id FROM employee_assignments x WHERE (x.tenant_id, x.employee_id) = (e.tenant_id, e.id) AND x.superseded_at IS NULL AND x.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) p ON true`
const person: Field[] = [
  { key: 'employee_number', label: 'Emp no', type: 'text', sql: 'e.employee_number' },
  { key: 'employee_name', label: 'Name', type: 'text', sql: "concat_ws(' ', e.first_name, e.last_name)" },
  { key: 'department', label: 'Department', type: 'text', sql: 'p.department', dimension: true },
  { key: 'designation', label: 'Designation', type: 'text', sql: 'p.designation', dimension: true },
  { key: 'location', label: 'Location', type: 'text', sql: 'p.location_code', dimension: true },
  { key: 'grade', label: 'Grade', type: 'text', sql: 'p.grade_code', dimension: true },
]

export const READ_MODELS: readonly ReadModel[] = [
  { key: 'employees', label: 'People', permission: 'employee.read', employeeColumn: 'e.id', help: 'One row per person with their current posting.',
    from: `employees e ${posting}`, defaultColumns: ['employee_number', 'employee_name', 'department', 'designation', 'status', 'date_of_joining'],
    fields: [...person,
      { key: 'status', label: 'Status', type: 'text', sql: 'e.status', dimension: true },
      { key: 'employment_type', label: 'Employment type', type: 'text', sql: 'e.employment_type', dimension: true },
      { key: 'gender', label: 'Gender', type: 'text', sql: 'e.gender', dimension: true },
      { key: 'date_of_joining', label: 'Joined', type: 'date', sql: 'e.date_of_joining' },
      { key: 'date_of_exit', label: 'Exited', type: 'date', sql: 'e.date_of_exit' },
      { key: 'date_of_birth', label: 'Born', type: 'date', sql: 'e.date_of_birth' },
      { key: 'tenure_months', label: 'Tenure (months)', type: 'number', sql: "(extract(year FROM age(coalesce(e.date_of_exit, current_date), e.date_of_joining)) * 12 + extract(month FROM age(coalesce(e.date_of_exit, current_date), e.date_of_joining)))::int" },
      { key: 'joining_month', label: 'Joining month', type: 'text', sql: "to_char(e.date_of_joining, 'YYYY-MM')", dimension: true },
    ] },
  { key: 'attendance', label: 'Attendance days', permission: 'attendance.read', employeeColumn: 'a.employee_id', help: 'One row per person per day from the attendance book.',
    from: `daily_attendance a JOIN employees e ON (e.tenant_id, e.id) = (a.tenant_id, a.employee_id) ${posting}`, defaultColumns: ['work_date', 'employee_name', 'department', 'status', 'worked_hours', 'late_minutes'],
    fields: [...person,
      { key: 'work_date', label: 'Date', type: 'date', sql: 'a.work_date' },
      { key: 'month', label: 'Month', type: 'text', sql: "to_char(a.work_date, 'YYYY-MM')", dimension: true },
      { key: 'status', label: 'Status', type: 'text', sql: 'a.status', dimension: true },
      { key: 'day_fraction', label: 'Day fraction', type: 'number', sql: 'a.day_fraction' },
      { key: 'worked_hours', label: 'Worked (h)', type: 'number', sql: 'round(coalesce(a.worked_minutes, 0) / 60.0, 2)' },
      { key: 'late_minutes', label: 'Late (min)', type: 'number', sql: 'a.late_minutes' },
      { key: 'ot_minutes', label: 'OT (min)', type: 'number', sql: 'a.ot_minutes' },
      { key: 'is_remote', label: 'Remote', type: 'boolean', sql: 'a.is_remote', dimension: true },
      { key: 'is_field_duty', label: 'Field duty', type: 'boolean', sql: 'a.is_field_duty', dimension: true },
    ] },
  { key: 'leave', label: 'Leave requests', permission: 'leave.read', employeeColumn: 'l.employee_id', help: 'One row per leave request with its type and status.',
    from: `leave_requests l JOIN leave_types lt ON (lt.tenant_id, lt.id) = (l.tenant_id, l.leave_type_id) JOIN employees e ON (e.tenant_id, e.id) = (l.tenant_id, l.employee_id) ${posting}`, defaultColumns: ['employee_name', 'department', 'leave_type', 'start_date', 'end_date', 'total_days', 'status'],
    fields: [...person,
      { key: 'leave_type', label: 'Leave type', type: 'text', sql: 'lt.code', dimension: true },
      { key: 'is_paid', label: 'Paid', type: 'boolean', sql: 'lt.is_paid', dimension: true },
      { key: 'start_date', label: 'From', type: 'date', sql: 'l.start_date' },
      { key: 'end_date', label: 'To', type: 'date', sql: 'l.end_date' },
      { key: 'month', label: 'Month', type: 'text', sql: "to_char(l.start_date, 'YYYY-MM')", dimension: true },
      { key: 'total_days', label: 'Days', type: 'number', sql: 'l.total_days' },
      { key: 'status', label: 'Status', type: 'text', sql: 'l.status', dimension: true },
      { key: 'applied_at', label: 'Applied', type: 'date', sql: 'l.applied_at::date' },
    ] },
  { key: 'payroll', label: 'Payroll lines', permission: 'payroll.read', employeeColumn: 'pl.employee_id', help: 'Every component of every LOCKED run: what was actually paid.',
    from: `payroll_lines pl JOIN payroll_runs r ON (r.tenant_id, r.id) = (pl.tenant_id, pl.run_id) AND r.status = 'locked' JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id) JOIN employees e ON (e.tenant_id, e.id) = (pl.tenant_id, pl.employee_id) ${posting}`, defaultColumns: ['period', 'employee_name', 'department', 'component', 'component_type', 'amount'],
    fields: [...person,
      { key: 'period', label: 'Period', type: 'text', sql: 'pp.label', dimension: true },
      { key: 'component', label: 'Component', type: 'text', sql: 'pl.component_code', dimension: true },
      { key: 'component_type', label: 'Type', type: 'text', sql: 'pl.component_type', dimension: true },
      { key: 'amount', label: 'Amount (₹)', type: 'money', sql: 'pl.amount_paise / 100.0' },
    ] },
  { key: 'expenses', label: 'Expense claims', permission: 'expense.read', employeeColumn: 'c.employee_id', help: 'One row per claim line.',
    from: `expense_claims c JOIN expense_categories ec ON (ec.tenant_id, ec.id) = (c.tenant_id, c.category_id) JOIN employees e ON (e.tenant_id, e.id) = (c.tenant_id, c.employee_id) ${posting}`, defaultColumns: ['incurred_on', 'employee_name', 'department', 'category', 'amount', 'status'],
    fields: [...person,
      { key: 'incurred_on', label: 'Incurred', type: 'date', sql: 'c.incurred_on' },
      { key: 'month', label: 'Month', type: 'text', sql: "to_char(c.incurred_on, 'YYYY-MM')", dimension: true },
      { key: 'category', label: 'Category', type: 'text', sql: 'ec.code', dimension: true },
      { key: 'amount', label: 'Amount (₹)', type: 'money', sql: 'c.amount_paise / 100.0' },
      { key: 'status', label: 'Status', type: 'text', sql: 'c.status', dimension: true },
      { key: 'cost_centre', label: 'Cost centre', type: 'text', sql: 'c.cost_centre', dimension: true },
      { key: 'merchant', label: 'Merchant', type: 'text', sql: 'c.merchant' },
    ] },
  { key: 'tickets', label: 'Helpdesk tickets', permission: 'ticket.read', employeeColumn: 't.subject_employee_id', help: 'One row per ticket; confidential tickets are absent for anyone not on them.',
    from: `tickets t LEFT JOIN ticket_categories tc ON (tc.tenant_id, tc.id) = (t.tenant_id, t.category_id) LEFT JOIN employees e ON (e.tenant_id, e.id) = (t.tenant_id, t.subject_employee_id) ${posting}`, defaultColumns: ['ticket_number', 'title', 'category', 'priority', 'status', 'created_on'],
    fields: [...person,
      { key: 'ticket_number', label: 'Ticket', type: 'text', sql: 't.ticket_number::text' },
      { key: 'title', label: 'Title', type: 'text', sql: 't.title' },
      { key: 'category', label: 'Category', type: 'text', sql: 'tc.name', dimension: true },
      { key: 'priority', label: 'Priority', type: 'text', sql: 't.priority', dimension: true },
      { key: 'status', label: 'Status', type: 'text', sql: 't.status', dimension: true },
      { key: 'created_on', label: 'Raised', type: 'date', sql: 't.created_at::date' },
      { key: 'month', label: 'Month', type: 'text', sql: "to_char(t.created_at, 'YYYY-MM')", dimension: true },
      { key: 'resolution_hours', label: 'Resolution (h)', type: 'number', sql: 'round(extract(epoch FROM (t.resolved_at - t.created_at)) / 3600.0, 1)' },
      { key: 'sla_breached', label: 'SLA breached', type: 'boolean', sql: '(t.resolved_at > t.sla_resolution_due_at OR (t.resolved_at IS NULL AND t.sla_resolution_due_at < now()))', dimension: true },
    ] },
  { key: 'approvals', label: 'Approvals', permission: 'approval.act', employeeColumn: 'ar.subject_employee_id', help: 'One row per approval request, with how long it took.',
    from: `approval_requests ar LEFT JOIN employees e ON (e.tenant_id, e.id) = (ar.tenant_id, ar.subject_employee_id) ${posting}`, defaultColumns: ['created_on', 'entity_type', 'title', 'employee_name', 'status', 'turnaround_hours'],
    fields: [...person,
      { key: 'entity_type', label: 'Kind', type: 'text', sql: 'ar.entity_type', dimension: true },
      { key: 'title', label: 'Title', type: 'text', sql: 'ar.title' },
      { key: 'chain', label: 'Chain', type: 'text', sql: 'ar.chain_code', dimension: true },
      { key: 'status', label: 'Status', type: 'text', sql: 'ar.status', dimension: true },
      { key: 'created_on', label: 'Raised', type: 'date', sql: 'ar.created_at::date' },
      { key: 'month', label: 'Month', type: 'text', sql: "to_char(ar.created_at, 'YYYY-MM')", dimension: true },
      { key: 'turnaround_hours', label: 'Turnaround (h)', type: 'number', sql: 'round(extract(epoch FROM (ar.closed_at - ar.created_at)) / 3600.0, 1)' },
    ] },
]
export const modelByKey = (key: string): ReadModel | undefined => READ_MODELS.find((m) => m.key === key)

export type Op = 'eq' | 'neq' | 'in' | 'gte' | 'lte' | 'gt' | 'lt' | 'contains' | 'is_null' | 'not_null'
export interface Filter { field: string; op: Op; value?: unknown }
export type Fn = 'count' | 'sum' | 'avg' | 'min' | 'max'
export interface Measure { field: string; fn: Fn; label?: string }
export interface Spec { model: string; columns?: string[]; filters?: Filter[]; groupBy?: string[]; measures?: Measure[]; sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>; limit?: number }
export interface Result { columns: Array<{ key: string; label: string; type: FieldType }>; rows: Record<string, unknown>[]; total: number; truncated: boolean; csv: string }

const OPS: Record<Op, string> = { eq: '=', neq: '<>', in: 'IN', gte: '>=', lte: '<=', gt: '>', lt: '<', contains: 'ILIKE', is_null: 'IS NULL', not_null: 'IS NOT NULL' }
const MAX_ROWS = 5000

/** Validates the spec against the model and the caller's rights; returns the parameterised SQL. Exported so a test can read the SQL it would run. */
export function compile(spec: Spec, auth: AuthzContext): { sql: string; params: unknown[]; columns: Result['columns']; model: ReadModel } {
  const model = modelByKey(spec.model)
  if (!model) throw new ReportError('UNKNOWN_MODEL', `no read model "${spec.model}"`)
  if (!can(auth, model.permission)) throw new ReportError('PERMISSION_DENIED', `the ${model.label} model needs ${model.permission}`)
  const field = (key: string): Field => { const f = model.fields.find((x) => x.key === key); if (!f) throw new ReportError('UNKNOWN_FIELD', `no field "${key}" on ${model.label}`); return f }
  const params: unknown[] = []
  const bind = (v: unknown): string => { params.push(v); return `$${params.length}` }

  const where: string[] = []
  if (auth.scope !== 'all') {
    if (!model.employeeColumn) throw new ReportError('PERMISSION_DENIED', 'this model is company-wide')
    const ids = [auth.employeeId, ...(auth.scope === 'reports' ? auth.reportIds : [])].filter((x): x is string => Boolean(x))
    where.push(`${model.employeeColumn} = ANY(${bind(ids)}::uuid[])`)
  }
  for (const f of spec.filters ?? []) {
    const fld = field(f.field)
    if (!(f.op in OPS)) throw new ReportError('VALIDATION_FAILED', `unknown operator "${f.op}"`)
    if (f.op === 'is_null' || f.op === 'not_null') { where.push(`${fld.sql} ${OPS[f.op]}`); continue }
    if (f.op === 'in') { if (!Array.isArray(f.value) || !f.value.length || f.value.length > 200) throw new ReportError('VALIDATION_FAILED', `"in" takes a list of up to 200 values`); where.push(`${fld.sql}::text = ANY(${bind(f.value.map(String))}::text[])`); continue }
    if (f.op === 'contains') { if (fld.type !== 'text') throw new ReportError('VALIDATION_FAILED', 'contains is for text'); where.push(`${fld.sql} ILIKE ${bind(`%${String(f.value).replace(/[%_\\]/g, '\\$&')}%`)}`); continue }
    if (f.value === undefined || f.value === null || f.value === '') throw new ReportError('VALIDATION_FAILED', `filter on ${f.field} needs a value`)
    const cast = fld.type === 'date' ? '::date' : fld.type === 'number' || fld.type === 'money' ? '::numeric' : fld.type === 'boolean' ? '::boolean' : '::text'
    where.push(`${fld.sql} ${OPS[f.op]} ${bind(String(f.value))}${cast}`)
  }

  const grouped = Boolean(spec.groupBy?.length || spec.measures?.length)
  const select: string[] = []
  const columns: Result['columns'] = []
  const groupExprs: string[] = []
  if (grouped) {
    for (const g of spec.groupBy ?? []) { const fld = field(g); if (!fld.dimension) throw new ReportError('VALIDATION_FAILED', `${g} is not a dimension`); select.push(`${fld.type === 'date' ? `(${fld.sql})::text` : fld.sql} AS "${fld.key}"`); groupExprs.push(fld.sql); columns.push({ key: fld.key, label: fld.label, type: fld.type }) }
    const measures = spec.measures?.length ? spec.measures : [{ field: '*', fn: 'count' as Fn }]
    for (const m of measures) {
      if (!['count', 'sum', 'avg', 'min', 'max'].includes(m.fn)) throw new ReportError('VALIDATION_FAILED', `unknown function "${m.fn}"`)
      const key = m.fn === 'count' && (m.field === '*' || !m.field) ? 'count' : `${m.fn}_${m.field}`
      if (m.fn === 'count' && (m.field === '*' || !m.field)) { select.push(`count(*)::int AS "count"`); columns.push({ key, label: m.label ?? 'Count', type: 'number' }); continue }
      const fld = field(m.field)
      if (m.fn !== 'count' && m.fn !== 'min' && m.fn !== 'max' && fld.type !== 'number' && fld.type !== 'money') throw new ReportError('VALIDATION_FAILED', `${m.fn} needs a numeric field`)
      select.push(`${m.fn === 'count' ? `count(${fld.sql})::int` : fld.type === 'date' ? `${m.fn}(${fld.sql})::text` : `round(${m.fn}(${fld.sql})::numeric, 2)`} AS "${key}"`)
      columns.push({ key, label: m.label ?? `${m.fn} ${fld.label}`, type: m.fn === 'count' ? 'number' : fld.type })
    }
  } else {
    const cols = spec.columns?.length ? spec.columns : model.defaultColumns
    // dates as text: pg would otherwise hand back a JS Date at local midnight, which shifts a day under toISOString()
    for (const c of cols) { const fld = field(c); select.push(`${fld.type === 'date' ? `(${fld.sql})::text` : fld.sql} AS "${fld.key}"`); columns.push({ key: fld.key, label: fld.label, type: fld.type }) }
  }
  const order = (spec.sort ?? []).map((s) => { const k = columns.find((c) => c.key === s.field); if (!k) throw new ReportError('VALIDATION_FAILED', `sort by a selected column, not "${s.field}"`); return `"${k.key}" ${s.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST` })
  const limit = Math.min(MAX_ROWS, Math.max(1, spec.limit ?? MAX_ROWS))
  const sql = `SELECT ${select.join(', ')} FROM ${model.from}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${groupExprs.length ? ` GROUP BY ${groupExprs.join(', ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : grouped ? '' : ` ORDER BY 1`} LIMIT ${limit + 1}`
  return { sql, params, columns, model }
}

export async function runReport(tx: PoolClient, spec: Spec, auth: AuthzContext): Promise<Result> {
  const c = compile(spec, auth)
  const limit = Math.min(MAX_ROWS, Math.max(1, spec.limit ?? MAX_ROWS))
  const { rows } = await tx.query<Record<string, unknown>>(c.sql, c.params)
  const truncated = rows.length > limit
  const out = truncated ? rows.slice(0, limit) : rows
  const norm = out.map((r) => Object.fromEntries(c.columns.map((col) => { const v = r[col.key]; return [col.key, v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === 'string' && (col.type === 'number' || col.type === 'money') ? Number(v) : v] })))
  const csv = [c.columns.map((x) => csvCell(x.label)).join(','), ...norm.map((r) => c.columns.map((x) => csvCell(r[x.key])).join(','))].join('\n') + '\n'
  return { columns: c.columns, rows: norm, total: norm.length, truncated, csv }
}

/** The catalogue the builder UI renders from. Only models the caller may read. */
export function catalogue(auth: AuthzContext): Array<{ key: string; label: string; help: string; fields: Array<Omit<Field, 'sql'>>; defaultColumns: string[] }> {
  return READ_MODELS.filter((m) => can(auth, m.permission)).map((m) => ({ key: m.key, label: m.label, help: m.help, defaultColumns: m.defaultColumns, fields: m.fields.map(({ sql: _sql, ...f }) => f) }))
}
