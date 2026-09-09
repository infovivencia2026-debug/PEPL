/**
 * Payroll run orchestration: freeze → calculate → validate → approve → lock,
 * and revisions instead of edits.
 *
 * The freeze step is the boundary. Before it, payroll reads the live world;
 * after it, payroll reads only what it wrote down. That is the whole basis of
 * reproducibility, and every rule below exists to protect it.
 */
import type { PoolClient } from 'pg'
import { computePayroll, validateRun, type EngineOptions, type PayrollInput, type StatutoryConfig } from './engine.ts'

export class PayrollError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PayrollError'
  }
}

export type RunStatus =
  | 'draft' | 'inputs_frozen' | 'calculated' | 'validated' | 'approved' | 'locked' | 'cancelled'

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new PayrollError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

export async function createRun(
  tx: PoolClient,
  args: { periodId: string; processedByUserId: string },
): Promise<string> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payroll_runs (tenant_id, period_id, processed_by_user_id)
     VALUES ($1, $2, $3) RETURNING id`,
    [tid, args.periodId, args.processedByUserId],
  )
  return rows[0]!.id
}

export interface FreezeRow {
  employeeId: string
  calendarDays: number
  payableDays: number
  lopDays: number
  paidLeaveDays?: number
  otMinutes?: number
  monthlyComponents: Record<string, number>
  annualCtcPaise: bigint | number
  stateCode: string
  pfApplicable?: boolean
  esiApplicable?: boolean
  taxRegime?: 'old' | 'new'
  adhoc?: { code: string; amountPaise: number }[]
  joinedMidPeriod?: boolean
  exitedMidPeriod?: boolean
}

/**
 * Writes the snapshot. Resolved VALUES, not references — a structure edited next
 * year must not change what this run saw.
 */
export async function freezeInputs(
  tx: PoolClient,
  runId: string,
  rows: readonly FreezeRow[],
  configSnapshot: Record<string, unknown>,
  statutoryConfigId: string,
): Promise<number> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'draft') {
    throw new PayrollError('RUN_NOT_DRAFT', `inputs can only be frozen from draft, not ${run.status}`)
  }

  for (const r of rows) {
    await tx.query(
      `INSERT INTO payroll_inputs
         (tenant_id, run_id, employee_id, calendar_days, payable_days, lop_days,
          paid_leave_days, ot_minutes, monthly_components, annual_ctc_paise, state_code,
          pf_applicable, esi_applicable, tax_regime, adhoc, joined_mid_period, exited_mid_period)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17)`,
      [tid, runId, r.employeeId, r.calendarDays, r.payableDays, r.lopDays,
       r.paidLeaveDays ?? 0, r.otMinutes ?? 0,
       JSON.stringify(r.monthlyComponents), String(r.annualCtcPaise), r.stateCode,
       r.pfApplicable ?? true, r.esiApplicable ?? false, r.taxRegime ?? 'new',
       JSON.stringify(r.adhoc ?? []), r.joinedMidPeriod ?? false, r.exitedMidPeriod ?? false],
    )
  }

  await tx.query(
    `UPDATE payroll_runs
        SET status = 'inputs_frozen', frozen_at = now(),
            config_snapshot = $3::jsonb, statutory_config_id = $4, employee_count = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tid, runId, JSON.stringify(configSnapshot), statutoryConfigId, rows.length],
  )
  return rows.length
}

/** Only before calculation, and only from inputs_frozen. Audited by the caller. */
export async function unfreezeInputs(tx: PoolClient, runId: string): Promise<void> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'inputs_frozen') {
    throw new PayrollError('CANNOT_UNFREEZE', `cannot unfreeze a run in status ${run.status}`)
  }
  await tx.query('DELETE FROM payroll_inputs WHERE tenant_id = $1 AND run_id = $2', [tid, runId])
  await tx.query(
    `UPDATE payroll_runs SET status = 'draft', frozen_at = NULL WHERE tenant_id = $1 AND id = $2`,
    [tid, runId],
  )
}

export async function calculate(
  tx: PoolClient,
  runId: string,
  opts: Omit<EngineOptions, 'statutory'> & { statutory: StatutoryConfig },
): Promise<{ gross: bigint; deductions: bigint; net: bigint }> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'inputs_frozen') {
    throw new PayrollError('INPUTS_NOT_FROZEN', `calculate requires inputs_frozen, not ${run.status}`)
  }

  const inputs = await readInputs(tx, runId)
  await tx.query('DELETE FROM payroll_lines WHERE tenant_id = $1 AND run_id = $2', [tid, runId])
  await tx.query('DELETE FROM payslips WHERE tenant_id = $1 AND run_id = $2', [tid, runId])

  let gross = 0n
  let deductions = 0n
  let net = 0n

  for (const input of inputs) {
    const c = computePayroll(input, opts)
    for (const line of c.lines) {
      await tx.query(
        `INSERT INTO payroll_lines (tenant_id, run_id, employee_id, component_code, component_type, amount_paise, calc_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [tid, runId, input.employeeId, line.code, line.type, String(line.amountPaise),
         JSON.stringify(line.note ?? {})],
      )
    }
    await tx.query(
      `INSERT INTO payslips (tenant_id, run_id, employee_id, gross_paise, deductions_paise, net_paise)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [tid, runId, input.employeeId, String(c.grossPaise), String(c.deductionsPaise), String(c.netPaise)],
    )
    gross += c.grossPaise
    deductions += c.deductionsPaise
    net += c.netPaise
  }

  await tx.query(
    `UPDATE payroll_runs
        SET status = 'calculated', calculated_at = now(),
            gross_paise = $3, deductions_paise = $4, net_paise = $5
      WHERE tenant_id = $1 AND id = $2`,
    [tid, runId, String(gross), String(deductions), String(net)],
  )
  return { gross, deductions, net }
}

export async function validate(
  tx: PoolClient,
  runId: string,
  opts: Omit<EngineOptions, 'statutory'> & { statutory: StatutoryConfig; variancePct: number },
): Promise<ReturnType<typeof validateRun>> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'calculated') {
    throw new PayrollError('NOT_CALCULATED', `validate requires calculated, not ${run.status}`)
  }

  const inputs = await readInputs(tx, runId)
  const rows = inputs.map((input) => ({ input, computed: computePayroll(input, opts) }))
  const result = validateRun(rows, { variancePct: opts.variancePct })

  if (result.blockers.length === 0) {
    await tx.query(`UPDATE payroll_runs SET status = 'validated' WHERE tenant_id = $1 AND id = $2`, [tid, runId])
  }
  return result
}

/**
 * Separation of duty: the person who ran payroll cannot approve it. This is a
 * standard audit finding and costs one check to prevent.
 */
export async function approve(
  tx: PoolClient,
  runId: string,
  approverUserId: string,
  opts: { requireSeparateApprover: boolean },
): Promise<void> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'validated') {
    throw new PayrollError('NOT_VALIDATED', `approve requires validated, not ${run.status}`)
  }
  if (opts.requireSeparateApprover && run.processed_by_user_id === approverUserId) {
    throw new PayrollError(
      'SEPARATION_OF_DUTY',
      'the user who ran this payroll cannot also approve it',
    )
  }
  await tx.query(
    `UPDATE payroll_runs SET status = 'approved', approved_by_user_id = $3, approved_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tid, runId, approverUserId],
  )
}

export async function lock(
  tx: PoolClient,
  runId: string,
  lockerUserId: string,
  opts: { requireSeparateApprover: boolean },
): Promise<void> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'approved') {
    throw new PayrollError('NOT_APPROVED', `lock requires approved, not ${run.status}`)
  }
  if (opts.requireSeparateApprover && run.processed_by_user_id === lockerUserId) {
    throw new PayrollError('SEPARATION_OF_DUTY', 'the user who ran this payroll cannot also lock it')
  }
  await tx.query(
    `UPDATE payroll_runs SET status = 'locked', locked_by_user_id = $3, locked_at = now()
      WHERE tenant_id = $1 AND id = $2`,
    [tid, runId, lockerUserId],
  )
}

/**
 * A locked run is never edited. A revision is a full recomputation on corrected
 * inputs, pointing back at what it supersedes.
 */
export async function revise(
  tx: PoolClient,
  runId: string,
  args: { reason: string; processedByUserId: string },
): Promise<string> {
  const tid = await tenantId(tx)
  if (!args.reason?.trim()) {
    throw new PayrollError('REVISION_REASON_REQUIRED', 'a revision must record why it exists')
  }
  const run = await getRun(tx, runId)
  if (run.status !== 'locked') {
    throw new PayrollError('NOT_LOCKED', `only a locked run is revised; this one is ${run.status}`)
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO payroll_runs
       (tenant_id, period_id, revision, supersedes_run_id, correction_reason, processed_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [tid, run.period_id, run.revision + 1, runId, args.reason, args.processedByUserId],
  )
  return rows[0]!.id
}

export interface DeltaRow {
  employee_id: string
  component_code: string
  old_amount: string | null
  new_amount: string
  delta_paise: string
}

/** The difference is DERIVED from the two runs, never stored. */
export async function delta(tx: PoolClient, newRunId: string): Promise<DeltaRow[]> {
  const { rows } = await tx.query<DeltaRow>(
    `SELECT n.employee_id, n.component_code,
            o.amount_paise::text AS old_amount,
            n.amount_paise::text AS new_amount,
            (n.amount_paise - COALESCE(o.amount_paise, 0))::text AS delta_paise
       FROM payroll_lines n
       LEFT JOIN payroll_lines o
              ON (o.tenant_id, o.employee_id, o.component_code)
               = (n.tenant_id, n.employee_id, n.component_code)
             AND o.run_id = (SELECT supersedes_run_id FROM payroll_runs
                              WHERE tenant_id = n.tenant_id AND id = n.run_id)
      WHERE n.run_id = $1
        AND n.amount_paise IS DISTINCT FROM COALESCE(o.amount_paise, 0)
      ORDER BY n.employee_id, n.component_code`,
    [newRunId],
  )
  return rows
}

interface RunRow {
  id: string
  period_id: string
  revision: number
  status: RunStatus
  processed_by_user_id: string | null
  supersedes_run_id: string | null
}

export async function getRun(tx: PoolClient, runId: string): Promise<RunRow> {
  const { rows } = await tx.query<RunRow>(
    `SELECT id, period_id, revision, status, processed_by_user_id, supersedes_run_id
       FROM payroll_runs WHERE id = $1`,
    [runId],
  )
  const run = rows[0]
  if (!run) throw new PayrollError('RUN_NOT_FOUND', `no payroll run ${runId}`)
  return run
}

async function readInputs(tx: PoolClient, runId: string): Promise<PayrollInput[]> {
  const { rows } = await tx.query<{
    employee_id: string; calendar_days: string; payable_days: string; lop_days: string
    monthly_components: Record<string, number>; state_code: string
    pf_applicable: boolean; esi_applicable: boolean; tax_regime: 'old' | 'new'
    adhoc: { code: string; amountPaise: number }[]
    joined_mid_period: boolean; exited_mid_period: boolean
  }>(
    `SELECT employee_id, calendar_days::text, payable_days::text, lop_days::text,
            monthly_components, state_code, pf_applicable, esi_applicable, tax_regime,
            adhoc, joined_mid_period, exited_mid_period
       FROM payroll_inputs WHERE run_id = $1 ORDER BY employee_id`,
    [runId],
  )
  return rows.map((r) => ({
    employeeId: r.employee_id,
    calendarDays: Number(r.calendar_days),
    payableDays: Number(r.payable_days),
    lopDays: Number(r.lop_days),
    monthlyComponents: r.monthly_components,
    stateCode: r.state_code,
    pfApplicable: r.pf_applicable,
    esiApplicable: r.esi_applicable,
    taxRegime: r.tax_regime,
    adhoc: r.adhoc ?? [],
    joinedMidPeriod: r.joined_mid_period,
    exitedMidPeriod: r.exited_mid_period,
  }))
}
