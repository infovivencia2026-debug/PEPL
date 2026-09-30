/**
 * Compliance calendar, registers and score.
 *
 * generateObligations() materialises the reference calendar for a window,
 * filtered to what applies to this company (PF/ESI registration codes,
 * PT state, headcount, organisation type). markFiled() records the filing
 * with evidence. complianceScore() is on-time filings over due filings in a
 * window — the number a founder or an auditor asks for first.
 *
 * Registers are the statutory books an inspector asks to see: wage register
 * (per employee per month), overtime register, leave register. The muster
 * (Form 25) already exists.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { OBLIGATIONS, dueDatesBetween } from '../../db/reference/compliance.ts'
import { notify } from '../comms/index.ts'
import { csvCell } from '../lib/csv.ts'

export class ComplianceError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ComplianceError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface Obligation { id: string; code: string; title: string; authority: string; help: string; check: boolean; period: string; due_on: string; status: string; filed_on: string | null; filed_by_user_id: string | null; evidence_document_id: string | null; reference_no: string | null; note: string | null; overdue: boolean; produced_by: string | null }
const O_COLS = `id, code, period, due_on::text, status, filed_on::text, filed_by_user_id, evidence_document_id, reference_no, note`

async function companyContext(tx: PoolClient, cfg: ResolvedConfig): Promise<Parameters<typeof OBLIGATIONS[number]['applies']>[0]> {
  const headcount = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees WHERE status = 'active' AND erased_at IS NULL`)).rows[0]!.n)
  const organisationType = (await tx.query<{ t: string | null }>(`SELECT organisation_type AS t FROM tenants`)).rows[0]?.t ?? null
  return { headcount, ptState: cfg.get<string>('payroll.pt_state_code') || null, organisationType, pfRegistered: Boolean(cfg.get<string>('payroll.pf_establishment_code')), esiRegistered: Boolean(cfg.get<string>('payroll.esi_employer_code')) }
}

/** Idempotent: rows for every applicable obligation due in [from, to]. */
export async function generateObligations(tx: PoolClient, cfg: ResolvedConfig, args: { from: string; to: string }): Promise<number> {
  const tid = await tenantId(tx)
  const ctx = await companyContext(tx, cfg)
  let n = 0
  for (const def of OBLIGATIONS) {
    if (!def.applies(ctx)) continue
    for (const d of dueDatesBetween(def, args.from, args.to)) {
      const r = await tx.query(`INSERT INTO compliance_obligations (tenant_id, code, period, due_on) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, code, period) DO NOTHING`, [tid, def.code, d.period, d.dueOn])
      n += r.rowCount ?? 0
    }
  }
  return n
}

const decorate = (rows: Array<Omit<Obligation, 'title' | 'authority' | 'help' | 'check' | 'overdue' | 'produced_by'>>, today: string): Obligation[] =>
  rows.map((r) => { const def = OBLIGATIONS.find((d) => d.code === r.code); return { ...r, title: def?.title ?? r.code, authority: def?.authority ?? '', help: def?.help ?? '', check: def?.check ?? false, produced_by: def?.producedBy ?? null, overdue: r.status === 'pending' && r.due_on < today } })

export async function calendar(tx: PoolClient, args: { from: string; to: string; status?: string; today?: string }): Promise<Obligation[]> {
  const { rows } = await tx.query<Omit<Obligation, 'title' | 'authority' | 'help' | 'check' | 'overdue' | 'produced_by'>>(
    `SELECT ${O_COLS} FROM compliance_obligations WHERE due_on BETWEEN $1::date AND $2::date AND ($3::text IS NULL OR status = $3) ORDER BY due_on, code`, [args.from, args.to, args.status ?? null])
  return decorate(rows, args.today ?? new Date().toISOString().slice(0, 10))
}

export async function markFiled(tx: PoolClient, args: { id: string; status: 'filed' | 'not_applicable' | 'pending'; filedOn?: string; evidenceDocumentId?: string | null; referenceNo?: string | null; note?: string | null; actorUserId: string }): Promise<Obligation> {
  if (!['filed', 'not_applicable', 'pending'].includes(args.status)) throw new ComplianceError('VALIDATION_FAILED', 'status is filed, not_applicable or pending')
  if (args.status === 'not_applicable' && !args.note?.trim()) throw new ComplianceError('VALIDATION_FAILED', 'say why it does not apply')
  const { rows } = await tx.query<Omit<Obligation, 'title' | 'authority' | 'help' | 'check' | 'overdue' | 'produced_by'>>(
    `UPDATE compliance_obligations SET status = $2, filed_on = CASE WHEN $2::text = 'filed' THEN coalesce($3::date, CURRENT_DATE) ELSE NULL END, filed_by_user_id = CASE WHEN $2 = 'pending' THEN NULL ELSE $4::uuid END,
        evidence_document_id = $5, reference_no = $6, note = $7 WHERE id = $1 RETURNING ${O_COLS}`,
    [args.id, args.status, args.filedOn ?? null, args.actorUserId, args.evidenceDocumentId ?? null, args.referenceNo?.trim() || null, args.note?.trim() || null])
  if (!rows[0]) throw new ComplianceError('NOT_FOUND', 'no such obligation')
  return decorate(rows, new Date().toISOString().slice(0, 10))[0]!
}

/** On-time filings / due filings in the window, with the breakdown the dashboard shows. */
export async function complianceScore(tx: PoolClient, args: { from: string; to: string; today?: string }): Promise<{ score: number | null; due: number; filedOnTime: number; filedLate: number; overdue: number; upcoming7: number; byCode: Array<{ code: string; title: string; due: number; onTime: number; late: number; overdue: number }> }> {
  const today = args.today ?? new Date().toISOString().slice(0, 10)
  const rows = await calendar(tx, { from: args.from, to: args.to, today })
  const counted = rows.filter((r) => r.status !== 'not_applicable' && (r.status === 'filed' || r.due_on <= today))
  const onTime = counted.filter((r) => r.status === 'filed' && r.filed_on! <= r.due_on).length
  const late = counted.filter((r) => r.status === 'filed' && r.filed_on! > r.due_on).length
  const overdue = counted.filter((r) => r.status === 'pending').length
  const upcoming7 = rows.filter((r) => r.status === 'pending' && r.due_on > today && r.due_on <= new Date(Date.parse(today) + 7 * 86_400_000).toISOString().slice(0, 10)).length
  const byCode = new Map<string, { code: string; title: string; due: number; onTime: number; late: number; overdue: number }>()
  for (const r of counted) {
    const b = byCode.get(r.code) ?? { code: r.code, title: r.title, due: 0, onTime: 0, late: 0, overdue: 0 }
    b.due++; if (r.status === 'pending') b.overdue++; else if (r.filed_on! <= r.due_on) b.onTime++; else b.late++
    byCode.set(r.code, b)
  }
  return { score: counted.length ? Math.round((onTime / counted.length) * 100) : null, due: counted.length, filedOnTime: onTime, filedLate: late, overdue, upcoming7, byCode: [...byCode.values()] }
}

/** Nightly: HR and payroll admins hear about obligations due within 3 days and anything overdue, once a day. */
export async function remindObligations(tx: PoolClient, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const soon = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10)
  const { rows } = await tx.query<{ id: string; code: string; period: string; due_on: string }>(
    `SELECT id, code, period, due_on::text FROM compliance_obligations WHERE status = 'pending' AND due_on <= $1::date AND (reminded_on IS NULL OR reminded_on < $2::date) ORDER BY due_on`, [soon, today])
  if (!rows.length) return 0
  const { rows: who } = await tx.query<{ user_id: string }>(`SELECT DISTINCT user_id FROM user_roles WHERE role IN ('hr_admin', 'payroll_admin', 'org_admin')`)
  let n = 0
  for (const o of rows) {
    const def = OBLIGATIONS.find((d) => d.code === o.code)
    const overdue = o.due_on < today
    for (const u of who) {
      if (await notify(tx, { userId: u.user_id, eventType: overdue ? 'compliance.overdue' : 'compliance.due', title: `${overdue ? 'OVERDUE' : 'Due ' + o.due_on}: ${def?.title ?? o.code} (${o.period})`, body: def?.help, entityType: 'compliance_obligation', entityId: o.id, dedupeKey: `compliance:${o.id}:${u.user_id}:${today}` })) n++
    }
    await tx.query(`UPDATE compliance_obligations SET reminded_on = $2 WHERE id = $1`, [o.id, today])
  }
  return n
}

// ── registers ────────────────────────────────────────────────────────────────

export interface Register { columns: string[]; rows: Record<string, string | number | null>[]; csv: string }
const q = csvCell
const csvOf = (columns: string[], rows: Record<string, unknown>[]): string => [columns.map(q).join(','), ...rows.map((r) => columns.map((c) => q(r[c])).join(','))].join('\n') + '\n'
const rupees = (paise: string | number | null): number => Math.round(Number(paise ?? 0)) / 100

/** Wage register (Form II shape): one row per employee for the month's locked run. */
export async function wageRegister(tx: PoolClient, month: string): Promise<Register> {
  const { rows } = await tx.query<{ employee_number: string; name: string; designation: string | null; department: string | null; payable_days: string; earnings: string; pf: string; esi: string; pt: string; tds: string; other: string; net: string; date_of_joining: string }>(
    `WITH run AS (SELECT r.id FROM payroll_runs r JOIN payroll_periods p ON p.id = r.period_id WHERE r.status = 'locked' AND to_char(p.period_start, 'YYYY-MM') = $1 ORDER BY r.revision DESC LIMIT 1)
     SELECT e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, a.designation, a.department, e.date_of_joining::text,
            coalesce(i.payable_days::text, '') AS payable_days,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_type = 'earning'), 0)::text AS earnings,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_code = 'PF_EE'), 0)::text AS pf,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_code = 'ESI_EE'), 0)::text AS esi,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_code = 'PT'), 0)::text AS pt,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_code = 'TDS'), 0)::text AS tds,
            coalesce(sum(l.amount_paise) FILTER (WHERE l.component_type = 'deduction' AND l.component_code NOT IN ('PF_EE','ESI_EE','PT','TDS')), 0)::text AS other,
            coalesce(s.net_paise, 0)::text AS net
       FROM run JOIN payslips s ON s.run_id = run.id JOIN employees e ON e.id = s.employee_id
       LEFT JOIN payroll_inputs i ON i.run_id = run.id AND i.employee_id = e.id
       LEFT JOIN payroll_lines l ON l.run_id = run.id AND l.employee_id = e.id
       LEFT JOIN LATERAL (SELECT designation, department FROM employee_assignments x WHERE x.employee_id = e.id AND x.superseded_at IS NULL ORDER BY effective_from DESC LIMIT 1) a ON true
      GROUP BY e.employee_number, e.first_name, e.last_name, a.designation, a.department, e.date_of_joining, i.payable_days, s.net_paise ORDER BY e.employee_number`, [month])
  const columns = ['Emp No', 'Name', 'Designation', 'Department', 'Date of joining', 'Days paid', 'Gross earnings', 'PF', 'ESI', 'PT', 'TDS', 'Other deductions', 'Net paid']
  const out = rows.map((r) => ({ 'Emp No': r.employee_number, Name: r.name, Designation: r.designation, Department: r.department, 'Date of joining': r.date_of_joining, 'Days paid': r.payable_days, 'Gross earnings': rupees(r.earnings), PF: rupees(r.pf), ESI: rupees(r.esi), PT: rupees(r.pt), TDS: rupees(r.tds), 'Other deductions': rupees(r.other), 'Net paid': rupees(r.net) }))
  return { columns, rows: out, csv: csvOf(columns, out) }
}

/** Overtime register (Form IV shape): per employee per day with OT hours and the OT pay for the month. */
export async function overtimeRegister(tx: PoolClient, month: string): Promise<Register> {
  const { rows } = await tx.query<{ employee_number: string; name: string; work_date: string; ot_minutes: number; ot_pay: string | null }>(
    `SELECT e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, d.work_date::text, d.ot_minutes,
            (SELECT sum(l.amount_paise)::text FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id JOIN payroll_periods p ON p.id = r.period_id
              WHERE l.employee_id = e.id AND l.component_code = 'OT' AND r.status = 'locked' AND to_char(p.period_start, 'YYYY-MM') = $1) AS ot_pay
       FROM daily_attendance d JOIN employees e ON e.id = d.employee_id
      WHERE to_char(d.work_date, 'YYYY-MM') = $1 AND d.ot_minutes > 0 ORDER BY e.employee_number, d.work_date`, [month])
  const columns = ['Emp No', 'Name', 'Date', 'OT hours', 'OT wages for month']
  const out = rows.map((r) => ({ 'Emp No': r.employee_number, Name: r.name, Date: r.work_date, 'OT hours': Math.round(r.ot_minutes / 6) / 10, 'OT wages for month': r.ot_pay ? rupees(r.ot_pay) : null }))
  return { columns, rows: out, csv: csvOf(columns, out) }
}

/** Leave register: per employee per leave type for a cycle year — opening, accrued, taken, balance. */
export async function leaveRegister(tx: PoolClient, cycleYear: number): Promise<Register> {
  const { rows } = await tx.query<{ employee_number: string; name: string; code: string; opening: string; accrued: string; consumed: string; adjusted: string }>(
    `SELECT e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, t.code,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type IN ('opening','carry_forward')), 0)::text AS opening,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type = 'accrual'), 0)::text AS accrued,
            coalesce(-sum(l.delta_days) FILTER (WHERE l.entry_type = 'consumption'), 0)::text AS consumed,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type NOT IN ('opening','carry_forward','accrual','consumption')), 0)::text AS adjusted
       FROM leave_ledger l JOIN employees e ON e.id = l.employee_id JOIN leave_types t ON t.id = l.leave_type_id
      WHERE l.cycle_year = $1 GROUP BY e.employee_number, e.first_name, e.last_name, t.code ORDER BY e.employee_number, t.code`, [cycleYear])
  const columns = ['Emp No', 'Name', 'Leave type', 'Opening', 'Accrued', 'Taken', 'Adjusted', 'Balance']
  const out = rows.map((r) => ({ 'Emp No': r.employee_number, Name: r.name, 'Leave type': r.code, Opening: Number(r.opening), Accrued: Number(r.accrued), Taken: Number(r.consumed), Adjusted: Number(r.adjusted), Balance: Math.round((Number(r.opening) + Number(r.accrued) - Number(r.consumed) + Number(r.adjusted)) * 100) / 100 }))
  return { columns, rows: out, csv: csvOf(columns, out) }
}
