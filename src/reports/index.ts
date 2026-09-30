/**
 * Reports: the four every finance team asks for in the first week.
 *
 *   salary register        one row per employee per locked run, every component as a column
 *   statutory summary      PF / ESI / PT / TDS totals per run, the numbers on the challans
 *   headcount & attrition  joiners, leavers, active count per month
 *   leave balances         per employee per type for a cycle year
 *
 * All DERIVED — from locked runs, the ledger, the employee dates. No report
 * table, nothing to keep in sync, and a report never disagrees with the
 * payslip because it is read from the same rows. Each returns rows plus a
 * CSV rendering, so the route can hand over a file.
 */
import type { PoolClient } from 'pg'

export interface Report {
  columns: string[]
  rows: Record<string, string | number | null>[]
  csv: string
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const toCsv = (columns: string[], rows: Record<string, unknown>[]): string =>
  [columns.join(','), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(','))].join('\n') + '\n'
const rupees = (paise: string | number | null | undefined): number => Number(paise ?? 0) / 100

/** Locked, non-superseded runs in a period range. */
async function lockedRuns(tx: PoolClient, from: string, to: string): Promise<{ id: string; label: string; period_start: string }[]> {
  const { rows } = await tx.query<{ id: string; label: string; period_start: string }>(
    `SELECT r.id, pp.label, pp.period_start::text
       FROM payroll_runs r JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
      WHERE r.status = 'locked' AND pp.period_start BETWEEN $1::date AND $2::date
        AND NOT EXISTS (SELECT 1 FROM payroll_runs n WHERE n.tenant_id = r.tenant_id AND n.supersedes_run_id = r.id AND n.status = 'locked')
      ORDER BY pp.period_start`, [from, to])
  return rows
}

export async function salaryRegister(tx: PoolClient, args: { from: string; to: string }): Promise<Report> {
  const runs = await lockedRuns(tx, args.from, args.to)
  if (!runs.length) return { columns: [], rows: [], csv: '' }
  const { rows } = await tx.query<{
    label: string; employee_number: string; name: string; department: string | null; designation: string | null
    payable_days: string; lop_days: string; gross: string; deductions: string; net: string; lines: Record<string, string>
  }>(
    `SELECT pp.label, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, a.department, a.designation,
            i.payable_days::text, i.lop_days::text, p.gross_paise::text AS gross, p.deductions_paise::text AS deductions, p.net_paise::text AS net,
            (SELECT jsonb_object_agg(l.component_code, l.amount_paise::text) FROM payroll_lines l
              WHERE (l.tenant_id, l.run_id, l.employee_id) = (p.tenant_id, p.run_id, p.employee_id) AND l.component_type <> 'informational') AS lines
       FROM payslips p
       JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
       JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
       JOIN employees e ON (e.tenant_id, e.id) = (p.tenant_id, p.employee_id)
       JOIN payroll_inputs i ON (i.tenant_id, i.run_id, i.employee_id) = (p.tenant_id, p.run_id, p.employee_id)
       LEFT JOIN LATERAL (SELECT department, designation FROM employee_assignments x
                           WHERE (x.tenant_id, x.employee_id) = (e.tenant_id, e.id) AND x.superseded_at IS NULL
                             AND x.effective_from <= pp.period_end AND (x.effective_to IS NULL OR x.effective_to > pp.period_end)
                           ORDER BY x.effective_from DESC LIMIT 1) a ON true
      WHERE p.run_id = ANY($1)
      ORDER BY pp.period_start, e.employee_number`, [runs.map((r) => r.id)])

  // Columns are the union of components seen, in a stable order: earnings first.
  const codes = new Set<string>()
  for (const r of rows) for (const c of Object.keys(r.lines ?? {})) codes.add(c)
  const order = (c: string): number => ['PF_EE', 'ESI_EE', 'PT', 'TDS', 'LOP'].includes(c) ? 2 : ['PF_ER', 'PF_EPS', 'EDLI_ER', 'ESI_ER'].includes(c) ? 3 : c.endsWith('_RECOVERY') || c === 'LOAN_EMI' || c === 'RECOVERY' ? 2 : 1
  const components = [...codes].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  const columns = ['period', 'employee_number', 'name', 'department', 'designation', 'payable_days', 'lop_days', ...components, 'gross', 'deductions', 'net']
  const out = rows.map((r) => {
    const row: Record<string, string | number | null> = {
      period: r.label, employee_number: r.employee_number, name: r.name, department: r.department, designation: r.designation,
      payable_days: Number(r.payable_days), lop_days: Number(r.lop_days),
      gross: rupees(r.gross), deductions: rupees(r.deductions), net: rupees(r.net),
    }
    for (const c of components) row[c] = rupees(r.lines?.[c])
    return row
  })
  return { columns, rows: out, csv: toCsv(columns, out) }
}

export async function statutorySummary(tx: PoolClient, args: { from: string; to: string }): Promise<Report> {
  const runs = await lockedRuns(tx, args.from, args.to)
  const columns = ['period', 'employees', 'gross', 'pf_employee', 'pf_employer', 'edli_employer', 'pf_total', 'esi_employee', 'esi_employer', 'esi_total', 'pt', 'tds', 'net']
  const out: Record<string, string | number | null>[] = []
  for (const run of runs) {
    const { rows } = await tx.query<{ code: string; total: string }>(
      `SELECT component_code AS code, sum(amount_paise)::text AS total FROM payroll_lines WHERE run_id = $1 GROUP BY component_code`, [run.id])
    const t = Object.fromEntries(rows.map((r) => [r.code, rupees(r.total)]))
    const { rows: s } = await tx.query<{ n: string; gross: string; net: string }>(
      `SELECT count(*)::text AS n, sum(gross_paise)::text AS gross, sum(net_paise)::text AS net FROM payslips WHERE run_id = $1`, [run.id])
    // The employer's 12% is stored as TWO lines when a pension rate is set: PF_ER (the EPF share)
    // and PF_EPS (the pension share). Reading PF_ER alone reported only the EPF share. EDLI is on
    // top of the 12% and is the employer's alone; `pf_total` is everything remitted to the EPFO.
    const pfE = t.PF_EE ?? 0, pfR = (t.PF_ER ?? 0) + (t.PF_EPS ?? 0), edli = t.EDLI_ER ?? 0
    const esiE = t.ESI_EE ?? 0, esiR = t.ESI_ER ?? 0
    out.push({ period: run.label, employees: Number(s[0]!.n), gross: rupees(s[0]!.gross),
      pf_employee: pfE, pf_employer: pfR, edli_employer: edli, pf_total: pfE + pfR + edli,
      esi_employee: esiE, esi_employer: esiR, esi_total: esiE + esiR,
      pt: t.PT ?? 0, tds: t.TDS ?? 0, net: rupees(s[0]!.net) })
  }
  return { columns, rows: out, csv: toCsv(columns, out) }
}

export async function headcount(tx: PoolClient, args: { from: string; to: string }): Promise<Report> {
  const { rows } = await tx.query<{ month: string; joined: string; left: string; active_end: string }>(
    `WITH months AS (SELECT generate_series(date_trunc('month', $1::date), date_trunc('month', $2::date), interval '1 month')::date AS m)
     SELECT to_char(m, 'YYYY-MM') AS month,
            (SELECT count(*) FROM employees e WHERE e.erased_at IS NULL AND date_trunc('month', e.date_of_joining) = m)::text AS joined,
            (SELECT count(*) FROM employees e WHERE e.erased_at IS NULL AND e.date_of_exit IS NOT NULL AND date_trunc('month', e.date_of_exit) = m)::text AS left,
            (SELECT count(*) FROM employees e WHERE e.erased_at IS NULL AND e.date_of_joining <= (m + interval '1 month - 1 day')::date
                AND (e.date_of_exit IS NULL OR e.date_of_exit > (m + interval '1 month - 1 day')::date))::text AS active_end
       FROM months ORDER BY m`, [args.from, args.to])
  const columns = ['month', 'active_at_end', 'joined', 'left', 'attrition_pct']
  const out = rows.map((r) => {
    const active = Number(r.active_end), left = Number(r.left)
    const opening = active - Number(r.joined) + left
    return { month: r.month, active_at_end: active, joined: Number(r.joined), left, attrition_pct: opening > 0 ? Math.round(left / opening * 1000) / 10 : 0 }
  })
  return { columns, rows: out, csv: toCsv(columns, out) }
}

export async function leaveBalances(tx: PoolClient, args: { cycleYear: number; asOf?: string }): Promise<Report> {
  const { rows } = await tx.query<{
    employee_number: string; name: string; department: string | null; code: string
    opening: string; accrued: string; consumed: string; adjusted: string
  }>(
    `SELECT e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name, a.department, t.code,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type IN ('opening','carry_forward')), 0)::text AS opening,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type = 'accrual'), 0)::text AS accrued,
            coalesce(-sum(l.delta_days) FILTER (WHERE l.entry_type IN ('consumption','reversal')), 0)::text AS consumed,
            coalesce(sum(l.delta_days) FILTER (WHERE l.entry_type IN ('adjustment','encashment','lapse')), 0)::text AS adjusted
       FROM leave_ledger l
       JOIN employees e ON (e.tenant_id, e.id) = (l.tenant_id, l.employee_id)
       JOIN leave_types t ON (t.tenant_id, t.id) = (l.tenant_id, l.leave_type_id)
       LEFT JOIN LATERAL (SELECT department FROM employee_assignments x WHERE (x.tenant_id, x.employee_id) = (e.tenant_id, e.id)
                           AND x.superseded_at IS NULL AND (x.effective_to IS NULL OR x.effective_to > CURRENT_DATE) ORDER BY x.effective_from DESC LIMIT 1) a ON true
      WHERE l.cycle_year = $1 AND e.erased_at IS NULL AND ($2::date IS NULL OR l.effective_date <= $2::date)
      GROUP BY e.employee_number, e.first_name, e.last_name, a.department, t.code
      ORDER BY e.employee_number, t.code`, [args.cycleYear, args.asOf ?? null])
  const columns = ['employee_number', 'name', 'department', 'leave_type', 'opening', 'accrued', 'consumed', 'adjusted', 'available']
  const out = rows.map((r) => {
    const o = Number(r.opening), ac = Number(r.accrued), c = Number(r.consumed), ad = Number(r.adjusted)
    return { employee_number: r.employee_number, name: r.name, department: r.department, leave_type: r.code,
      opening: o, accrued: ac, consumed: c, adjusted: ad, available: Math.round((o + ac + ad - c) * 100) / 100 }
  })
  return { columns, rows: out, csv: toCsv(columns, out) }
}

/** Leavers in a period by separation reason, department and tenure band, with the exit-interview reason where one was held. */
export async function attrition(tx: PoolClient, args: { from: string; to: string }): Promise<Report> {
  const { rows } = await tx.query<{ reason: string; department: string | null; tenure_band: string; n: string; regret: string; exit_reasons: string | null }>(
    `SELECT s.reason,
            (SELECT a.department FROM employee_assignments a WHERE a.employee_id = s.employee_id ORDER BY a.effective_from DESC LIMIT 1) AS department,
            CASE WHEN s.last_working_day - e.date_of_joining < 365 THEN '< 1 yr'
                 WHEN s.last_working_day - e.date_of_joining < 3 * 365 THEN '1-3 yrs'
                 WHEN s.last_working_day - e.date_of_joining < 5 * 365 THEN '3-5 yrs' ELSE '5+ yrs' END AS tenure_band,
            count(*)::text AS n,
            count(*) FILTER (WHERE s.reason = 'resignation')::text AS regret,
            string_agg(DISTINCT x.primary_reason, '; ') AS exit_reasons
       FROM employee_separations s
       JOIN employees e ON e.tenant_id = s.tenant_id AND e.id = s.employee_id
       LEFT JOIN exit_interviews x ON x.tenant_id = s.tenant_id AND x.separation_id = s.id
      WHERE s.status <> 'cancelled' AND s.last_working_day BETWEEN $1::date AND $2::date
      GROUP BY 1, 2, 3 ORDER BY 2 NULLS LAST, 1, 3`, [args.from, args.to])
  const columns = ['department', 'reason', 'tenure_band', 'leavers', 'voluntary', 'exit_interview_reasons']
  const out = rows.map((r) => ({ department: r.department, reason: r.reason, tenure_band: r.tenure_band, leavers: Number(r.n), voluntary: Number(r.regret), exit_interview_reasons: r.exit_reasons }))
  return { columns, rows: out, csv: toCsv(columns, out) }
}
