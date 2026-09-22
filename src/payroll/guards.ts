/**
 * Anomaly guards: the checks a careful payroll manager runs by eye, made
 * mechanical. They read the CALCULATED run and the books around it, and
 * write findings; approval refuses while a blocking finding is open.
 *
 *   payroll   duplicate bank account across people · duplicate PAN · an
 *             exited person still paid · a joiner paid a full month before
 *             joining · payable days above calendar days of attendance ·
 *             headcount or total net moved more than the threshold against
 *             the previous locked run · a person in two runs for one period
 *   attendance (nightly)  a day over the maximum hours · a manager whose
 *             regularisations exceed the alert rate · a team 100% present
 *             for 30 days with every punch from the web (buddy-punch smell)
 *
 * A finding's fingerprint is stable, so a re-run refreshes `last_seen_at`
 * rather than duplicating; a dismissed finding stays dismissed until the
 * evidence changes (a new fingerprint).
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'

export class GuardError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'GuardError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface Finding { id: string; area: 'payroll' | 'attendance'; code: string; severity: 'blocking' | 'warning' | 'info'; run_id: string | null; employee_id: string | null; employee_name: string | null; message: string; detail: Record<string, unknown>; status: string; found_at: string; last_seen_at: string; dismissed_by_user_id: string | null; dismissed_at: string | null; dismiss_reason: string | null }
const F_COLS = `f.id, f.area, f.code, f.severity, f.run_id, f.employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = f.employee_id) AS employee_name, f.message, f.detail, f.status, f.found_at::text, f.last_seen_at::text, f.dismissed_by_user_id, f.dismissed_at::text, f.dismiss_reason`

interface Raw { area: 'payroll' | 'attendance'; code: string; severity: Finding['severity']; runId?: string | null; employeeId?: string | null; fingerprint: string; message: string; detail?: Record<string, unknown> }

async function record(tx: PoolClient, raws: Raw[]): Promise<{ opened: number; refreshed: number }> {
  const tid = await tenantId(tx)
  let opened = 0, refreshed = 0
  for (const r of raws) {
    const res = await tx.query<{ inserted: boolean }>(
      `INSERT INTO anomaly_findings (tenant_id, area, code, severity, run_id, employee_id, fingerprint, message, detail) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (tenant_id, fingerprint) DO UPDATE SET last_seen_at = now(), message = EXCLUDED.message, detail = EXCLUDED.detail
       RETURNING (xmax = 0) AS inserted`,
      [tid, r.area, r.code, r.severity, r.runId ?? null, r.employeeId ?? null, r.fingerprint, r.message, JSON.stringify(r.detail ?? {})])
    if (res.rows[0]?.inserted) opened++; else refreshed++
  }
  return { opened, refreshed }
}

/** Payroll guards over a calculated run. Idempotent: the same evidence yields the same fingerprints. */
export async function runPayrollGuards(tx: PoolClient, cfg: ResolvedConfig, runId: string): Promise<{ findings: Finding[]; opened: number; blocking: number }> {
  const run = (await tx.query<{ status: string; period_id: string; period_start: string; period_end: string; supersedes_run_id: string | null }>(
    `SELECT r.status, r.period_id, p.period_start::text, p.period_end::text, r.supersedes_run_id FROM payroll_runs r JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id) WHERE r.id = $1`, [runId])).rows[0]
  if (!run) throw new GuardError('NOT_FOUND', 'no such run')
  if (!['calculated', 'validated', 'approved', 'locked'].includes(run.status)) throw new GuardError('RUN_NOT_CALCULATED', `guards read a calculated run, not ${run.status}`)
  const raws: Raw[] = []
  const fp = (code: string, ...parts: Array<string | number>): string => `payroll:${runId}:${code}:${parts.join(':')}`

  const inputs = (await tx.query<{ employee_id: string; calendar_days: string; payable_days: string; lop_days: string; joined_mid_period: boolean; exited_mid_period: boolean; net: string | null; name: string; doj: string; dol: string | null; status: string }>(
    `SELECT i.employee_id, i.calendar_days::text, i.payable_days::text, i.lop_days::text, i.joined_mid_period, i.exited_mid_period, s.net_paise::text AS net,
            concat_ws(' ', e.first_name, e.last_name) AS name, e.date_of_joining::text AS doj, e.date_of_exit::text AS dol, e.status
       FROM payroll_inputs i JOIN employees e ON (e.tenant_id, e.id) = (i.tenant_id, i.employee_id) LEFT JOIN payslips s ON (s.tenant_id, s.run_id, s.employee_id) = (i.tenant_id, i.run_id, i.employee_id)
      WHERE i.run_id = $1`, [runId])).rows

  // 1. duplicate primary bank account across people in the run
  const banks = (await tx.query<{ account_number: string; ifsc: string; employees: string[] }>(
    `SELECT b.account_number, b.ifsc, array_agg(b.employee_id::text ORDER BY b.employee_id) AS employees FROM employee_bank_accounts b
      WHERE b.is_primary AND b.superseded_at IS NULL AND b.employee_id IN (SELECT employee_id FROM payroll_inputs WHERE run_id = $1)
      GROUP BY b.account_number, b.ifsc HAVING count(DISTINCT b.employee_id) > 1`, [runId])).rows
  for (const b of banks) raws.push({ area: 'payroll', code: 'DUPLICATE_BANK_ACCOUNT', severity: 'blocking', runId, fingerprint: fp('DUPLICATE_BANK_ACCOUNT', b.ifsc, b.account_number.slice(-4), b.employees.join(',')), message: `${b.employees.length} people in this run share bank account ****${b.account_number.slice(-4)} (${b.ifsc})`, detail: { employees: b.employees } })
  // 2. duplicate PAN
  const pans = (await tx.query<{ pan: string; employees: string[] }>(
    `SELECT s.pan, array_agg(s.employee_id::text ORDER BY s.employee_id) AS employees FROM employee_statutory_ids s WHERE s.pan IS NOT NULL AND s.employee_id IN (SELECT employee_id FROM payroll_inputs WHERE run_id = $1) GROUP BY s.pan HAVING count(*) > 1`, [runId])).rows
  for (const p of pans) raws.push({ area: 'payroll', code: 'DUPLICATE_PAN', severity: 'blocking', runId, fingerprint: fp('DUPLICATE_PAN', p.pan, p.employees.join(',')), message: `${p.employees.length} people in this run share PAN ${p.pan.slice(0, 3)}*****${p.pan.slice(-1)}`, detail: { employees: p.employees } })
  // 3. per-person checks
  for (const i of inputs) {
    if (i.dol && i.dol < run.period_start) raws.push({ area: 'payroll', code: 'EXITED_STILL_PAID', severity: 'blocking', runId, employeeId: i.employee_id, fingerprint: fp('EXITED_STILL_PAID', i.employee_id), message: `${i.name} left on ${i.dol} but is in the ${run.period_start.slice(0, 7)} run`, detail: { dateOfExit: i.dol } })
    if (i.doj > run.period_end) raws.push({ area: 'payroll', code: 'PAID_BEFORE_JOINING', severity: 'blocking', runId, employeeId: i.employee_id, fingerprint: fp('PAID_BEFORE_JOINING', i.employee_id), message: `${i.name} joins on ${i.doj}, after this period ends`, detail: { dateOfJoining: i.doj } })
    else if (i.doj > run.period_start && !i.joined_mid_period && Number(i.payable_days) >= Number(i.calendar_days)) raws.push({ area: 'payroll', code: 'JOINER_FULL_MONTH', severity: 'warning', runId, employeeId: i.employee_id, fingerprint: fp('JOINER_FULL_MONTH', i.employee_id), message: `${i.name} joined ${i.doj} mid-period but is paid all ${i.calendar_days} days`, detail: { dateOfJoining: i.doj, payableDays: Number(i.payable_days) } })
    if (Number(i.payable_days) + Number(i.lop_days) > Number(i.calendar_days) + 0.001) raws.push({ area: 'payroll', code: 'DAYS_EXCEED_CALENDAR', severity: 'blocking', runId, employeeId: i.employee_id, fingerprint: fp('DAYS_EXCEED_CALENDAR', i.employee_id), message: `${i.name}: ${i.payable_days} payable + ${i.lop_days} LOP exceeds ${i.calendar_days} calendar days`, detail: {} })
    // attendance book disagrees with what was frozen: more absences than LOP + paid leave
    const att = (await tx.query<{ absent: string }>(`SELECT count(*)::text AS absent FROM daily_attendance WHERE employee_id = $1 AND work_date BETWEEN $2::date AND $3::date AND status = 'absent'`, [i.employee_id, run.period_start, run.period_end])).rows[0]!
    if (Number(att.absent) > 0 && Number(i.lop_days) === 0 && Number(i.payable_days) >= Number(i.calendar_days)) raws.push({ area: 'payroll', code: 'ABSENT_BUT_FULL_PAY', severity: 'warning', runId, employeeId: i.employee_id, fingerprint: fp('ABSENT_BUT_FULL_PAY', i.employee_id, att.absent), message: `${i.name} has ${att.absent} absent day(s) in the book but no LOP and full payable days`, detail: { absentDays: Number(att.absent) } })
  }
  // 4. against the previous locked run for the previous period
  const prev = (await tx.query<{ id: string; label: string; heads: string; net: string }>(
    `SELECT r.id, p.label, count(s.employee_id)::text AS heads, coalesce(sum(s.net_paise), 0)::text AS net
       FROM payroll_runs r JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id) LEFT JOIN payslips s ON (s.tenant_id, s.run_id) = (r.tenant_id, r.id)
      WHERE r.status = 'locked' AND p.period_end < $1::date AND r.id <> $2 AND NOT EXISTS (SELECT 1 FROM payroll_runs n WHERE n.tenant_id = r.tenant_id AND n.supersedes_run_id = r.id AND n.status = 'locked')
      GROUP BY r.id, p.label, p.period_end ORDER BY p.period_end DESC LIMIT 1`, [run.period_start, runId])).rows[0]
  if (prev && Number(prev.heads) > 0) {
    const heads = inputs.length, net = inputs.reduce((s, i) => s + Number(i.net ?? 0), 0)
    const headPct = Math.abs(heads - Number(prev.heads)) / Number(prev.heads) * 100
    const netPct = Number(prev.net) > 0 ? Math.abs(net - Number(prev.net)) / Number(prev.net) * 100 : 0
    const headLimit = cfg.get<number>('payroll.guard_headcount_change_pct'), netLimit = cfg.get<number>('payroll.guard_total_change_pct')
    if (headPct > headLimit) raws.push({ area: 'payroll', code: 'HEADCOUNT_JUMP', severity: 'warning', runId, fingerprint: fp('HEADCOUNT_JUMP', heads, prev.heads), message: `${heads} people paid against ${prev.heads} in ${prev.label} (${headPct.toFixed(0)}% change, limit ${headLimit}%)`, detail: { heads, previous: Number(prev.heads), previousRun: prev.id } })
    if (netPct > netLimit) raws.push({ area: 'payroll', code: 'TOTAL_NET_JUMP', severity: 'blocking', runId, fingerprint: fp('TOTAL_NET_JUMP', Math.round(net / 100), Math.round(Number(prev.net) / 100)), message: `total net ₹${(net / 100).toLocaleString('en-IN')} against ₹${(Number(prev.net) / 100).toLocaleString('en-IN')} in ${prev.label} (${netPct.toFixed(0)}% change, limit ${netLimit}%)`, detail: { netPaise: net, previousNetPaise: Number(prev.net), previousRun: prev.id } })
  }
  // 5. the same person in another non-superseded run for this period
  const twice = (await tx.query<{ employee_id: string; name: string }>(
    `SELECT i.employee_id, concat_ws(' ', e.first_name, e.last_name) AS name FROM payroll_inputs i JOIN payroll_runs r ON (r.tenant_id, r.id) = (i.tenant_id, i.run_id) JOIN employees e ON (e.tenant_id, e.id) = (i.tenant_id, i.employee_id)
      WHERE r.period_id = $2 AND r.id <> $1 AND r.status NOT IN ('cancelled') AND r.supersedes_run_id IS NULL AND $3::uuid IS NULL AND i.employee_id IN (SELECT employee_id FROM payroll_inputs WHERE run_id = $1)`, [runId, run.period_id, run.supersedes_run_id])).rows
  for (const t of twice) raws.push({ area: 'payroll', code: 'PAID_TWICE_IN_PERIOD', severity: 'blocking', runId, employeeId: t.employee_id, fingerprint: fp('PAID_TWICE_IN_PERIOD', t.employee_id), message: `${t.name} is in another run for the same period`, detail: {} })

  const { opened } = await record(tx, raws)
  const findings = await listFindings(tx, { runId })
  return { findings, opened, blocking: findings.filter((f) => f.status === 'open' && f.severity === 'blocking').length }
}

/** What approval calls: refuse while any blocking finding on the run is open. */
export async function assertNoOpenBlockers(tx: PoolClient, runId: string): Promise<void> {
  const { rows } = await tx.query<{ n: string; codes: string[] }>(`SELECT count(*)::text AS n, array_agg(DISTINCT code) AS codes FROM anomaly_findings WHERE run_id = $1 AND status = 'open' AND severity = 'blocking'`, [runId])
  if (Number(rows[0]!.n) > 0) throw new GuardError('ANOMALIES_OPEN', `${rows[0]!.n} blocking finding(s) open on this run: ${rows[0]!.codes.join(', ')}. Dismiss each with a reason or fix the inputs.`)
}

export async function listFindings(tx: PoolClient, args: { area?: string; runId?: string; status?: string; employeeIds?: string[] | null }): Promise<Finding[]> {
  return (await tx.query<Finding>(`SELECT ${F_COLS} FROM anomaly_findings f WHERE ($1::text IS NULL OR f.area = $1) AND ($2::uuid IS NULL OR f.run_id = $2) AND ($3::text IS NULL OR f.status = $3) AND ($4::uuid[] IS NULL OR f.employee_id = ANY($4) OR f.employee_id IS NULL) ORDER BY f.severity, f.found_at DESC LIMIT 500`,
    [args.area ?? null, args.runId ?? null, args.status ?? null, args.employeeIds ?? null])).rows
}
export async function dismissFinding(tx: PoolClient, args: { id: string; reason: string; userId: string }): Promise<Finding> {
  if (!args.reason?.trim() || args.reason.trim().length < 5) throw new GuardError('VALIDATION_FAILED', 'say why this is not a problem (a sentence)')
  const r = await tx.query(`UPDATE anomaly_findings SET status = 'dismissed', dismissed_by_user_id = $2, dismissed_at = now(), dismiss_reason = $3 WHERE id = $1 AND status = 'open'`, [args.id, args.userId, args.reason.trim()])
  if (!r.rowCount) throw new GuardError('NOT_FOUND', 'no such open finding')
  return (await tx.query<Finding>(`SELECT ${F_COLS} FROM anomaly_findings f WHERE f.id = $1`, [args.id])).rows[0]!
}
/** Findings on a run whose evidence is gone (e.g. inputs re-frozen) are resolved, not left open forever. */
export async function resolveStale(tx: PoolClient, runId: string, keepFingerprints: string[]): Promise<number> {
  const r = await tx.query(`UPDATE anomaly_findings SET status = 'resolved' WHERE run_id = $1 AND status = 'open' AND NOT (fingerprint = ANY($2::text[]))`, [runId, keepFingerprints])
  return r.rowCount ?? 0
}

/** Nightly attendance guards for the trailing window. */
export async function runAttendanceGuards(tx: PoolClient, cfg: ResolvedConfig, today = new Date().toISOString().slice(0, 10)): Promise<{ opened: number }> {
  const raws: Raw[] = []
  const maxHours = cfg.get<number>('attendance.max_daily_hours')
  const from30 = new Date(Date.parse(today) - 30 * 86_400_000).toISOString().slice(0, 10)
  // a day over the maximum hours (yesterday and before, last 7 days)
  const long = (await tx.query<{ employee_id: string; name: string; work_date: string; hours: string }>(
    `SELECT a.employee_id, concat_ws(' ', e.first_name, e.last_name) AS name, a.work_date::text, round(a.worked_minutes / 60.0, 1)::text AS hours FROM daily_attendance a JOIN employees e ON (e.tenant_id, e.id) = (a.tenant_id, a.employee_id)
      WHERE a.work_date BETWEEN $1::date - 7 AND $1::date AND a.worked_minutes > $2 * 60`, [today, maxHours])).rows
  for (const l of long) raws.push({ area: 'attendance', code: 'OVERLONG_DAY', severity: 'warning', employeeId: l.employee_id, fingerprint: `attendance:OVERLONG_DAY:${l.employee_id}:${l.work_date}`, message: `${l.name} worked ${l.hours} h on ${l.work_date} (limit ${maxHours} h) — a missed punch-out or a real safety issue`, detail: { workDate: l.work_date, hours: Number(l.hours) } })
  // regularisation rate per manager over 30 days
  const rate = cfg.get<number>('attendance.regularisation_rate_alert_pct')
  const regs = (await tx.query<{ manager_id: string; name: string; total: string; regularised: string }>(
    `SELECT p.manager_employee_id AS manager_id, (SELECT concat_ws(' ', m.first_name, m.last_name) FROM employees m WHERE m.id = p.manager_employee_id) AS name, count(*)::text AS total, count(*) FILTER (WHERE a.is_regularized)::text AS regularised
       FROM daily_attendance a JOIN employee_assignments p ON (p.tenant_id, p.employee_id) = (a.tenant_id, a.employee_id) AND p.superseded_at IS NULL AND p.effective_to IS NULL
      WHERE a.work_date BETWEEN $1::date AND $2::date AND p.manager_employee_id IS NOT NULL AND a.status IN ('present','absent')
      GROUP BY p.manager_employee_id HAVING count(*) >= 20 AND count(*) FILTER (WHERE a.is_regularized) * 100.0 / count(*) > $3`, [from30, today, rate])).rows
  for (const r of regs) raws.push({ area: 'attendance', code: 'REGULARISATION_RATE', severity: 'warning', employeeId: r.manager_id, fingerprint: `attendance:REGULARISATION_RATE:${r.manager_id}:${today.slice(0, 7)}`, message: `${r.name}'s team: ${r.regularised} of ${r.total} days regularised in 30 days (${(Number(r.regularised) / Number(r.total) * 100).toFixed(0)}%, alert at ${rate}%)`, detail: { total: Number(r.total), regularised: Number(r.regularised) } })
  // a team fully present for 30 days with every punch from the web: nobody is that regular
  const perfect = (await tx.query<{ manager_id: string; name: string; heads: string }>(
    `WITH team AS (
       SELECT p.manager_employee_id AS manager_id, a.employee_id, count(*) AS days, count(*) FILTER (WHERE a.status = 'present') AS present
         FROM daily_attendance a JOIN employee_assignments p ON (p.tenant_id, p.employee_id) = (a.tenant_id, a.employee_id) AND p.superseded_at IS NULL AND p.effective_to IS NULL
        WHERE a.work_date BETWEEN $1::date AND $2::date AND p.manager_employee_id IS NOT NULL AND a.status IN ('present','absent') GROUP BY 1, 2)
     SELECT t.manager_id, (SELECT concat_ws(' ', m.first_name, m.last_name) FROM employees m WHERE m.id = t.manager_id) AS name, count(*)::text AS heads
       FROM team t WHERE t.days >= 20 GROUP BY t.manager_id HAVING count(*) >= 5 AND bool_and(t.present = t.days)
        AND NOT EXISTS (SELECT 1 FROM attendance_punches ap JOIN team t2 ON t2.employee_id = ap.employee_id AND t2.manager_id = t.manager_id WHERE ap.punched_at::date BETWEEN $1::date AND $2::date AND ap.source <> 'web')`, [from30, today])).rows
  for (const p of perfect) raws.push({ area: 'attendance', code: 'PERFECT_TEAM_WEB_ONLY', severity: 'info', employeeId: p.manager_id, fingerprint: `attendance:PERFECT_TEAM_WEB_ONLY:${p.manager_id}:${today.slice(0, 7)}`, message: `${p.name}'s team of ${p.heads} was present every day for 30 days, every punch from the web — worth a look`, detail: { heads: Number(p.heads) } })
  const { opened } = await record(tx, raws)
  return { opened }
}
