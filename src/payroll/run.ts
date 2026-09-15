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
import { allowanceFor } from './declarations.ts'
import { fiscalYearOf, monthsRemainingInFY } from './tds.ts'
import { finalizeSettlements, releaseSettlements, settlementForFreeze, type SettlementOptions } from './exit.ts'

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
  /** Allowed Chapter VI-A deductions + HRA exemption for the year, resolved at freeze. */
  chapterViaPaise?: bigint | number
  /** Taxable gross already paid this fiscal year in locked runs. Resolved at freeze if omitted. */
  ytdTaxablePaise?: bigint | number
  /** TDS already deducted this fiscal year in locked runs. Resolved at freeze if omitted. */
  ytdTdsPaise?: bigint | number
  adhoc?: { code: string; amountPaise: number; taxable?: boolean; type?: 'earning' | 'deduction' }[]
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
  extra: { settlement?: SettlementOptions } = {},
): Promise<number> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'draft') {
    throw new PayrollError('RUN_NOT_DRAFT', `inputs can only be frozen from draft, not ${run.status}`)
  }

  // The fiscal year of the period decides which declaration (and which caps) apply.
  const { rows: period } = await tx.query<{ period_start: string; period_end: string }>(
    `SELECT period_start::text, period_end::text FROM payroll_periods WHERE id = $1`, [run.period_id])
  if (!period[0]) throw new PayrollError('PERIOD_NOT_FOUND', `run ${runId} has no period`)
  const periodStart = new Date(period[0].period_start)
  const settlementOpts: SettlementOptions = extra.settlement ?? { encashmentDivisor: 30, noticeDivisor: 30 }
  const fiscalYear = fiscalYearOf(periodStart)
  // From the PERIOD, never the clock: September processed in October is September.
  const monthsRemaining = monthsRemainingInFY(periodStart)

  for (const row of rows) {
    // Chapter VI-A is resolved HERE, once, into a value. A caller may pass its own
    // figure (tests, a corrected revision); otherwise the verified declaration decides.
    let r = row
    if (r.chapterViaPaise === undefined) {
      const c = (code: string) => r.monthlyComponents[code] ?? r.monthlyComponents[code.toUpperCase()] ?? 0
      const resolved = await allowanceFor(tx, {
        employeeId: r.employeeId, fiscalYear,
        salary: { basicAnnualPaise: (c('basic') + c('da')) * 12, hraAnnualPaise: c('hra') * 12 },
      })
      r = { ...r, chapterViaPaise: resolved.allowance.totalPaise, taxRegime: r.taxRegime ?? resolved.regime }
    }
    if (r.ytdTaxablePaise === undefined || r.ytdTdsPaise === undefined) {
      const ytd = await yearToDate(tx, r.employeeId, periodStart)
      r = { ...r, ytdTaxablePaise: r.ytdTaxablePaise ?? ytd.taxablePaise, ytdTdsPaise: r.ytdTdsPaise ?? ytd.tdsPaise }
    }
    // A leaver's final run: the settlement is resolved HERE, once, and its
    // lines join the row. The caller's day counts stand — attendance knows
    // how many days were worked — but the run knows the person left.
    const exit = await settlementForFreeze(tx, {
      employeeId: r.employeeId, runId, periodStart: period[0].period_start, periodEnd: period[0].period_end,
      opts: settlementOpts,
    })
    if (exit) {
      r = {
        ...r,
        adhoc: [...(r.adhoc ?? []), ...exit.settlement.adhoc],
        exitedMidPeriod: r.exitedMidPeriod || exit.separation.last_working_day < period[0].period_end,
      }
    }
    await tx.query(
      `INSERT INTO payroll_inputs
         (tenant_id, run_id, employee_id, calendar_days, payable_days, lop_days,
          paid_leave_days, ot_minutes, monthly_components, annual_ctc_paise, state_code,
          pf_applicable, esi_applicable, tax_regime, adhoc, joined_mid_period, exited_mid_period,
          chapter_via_paise, ytd_taxable_paise, ytd_tds_paise, months_remaining)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19,$20,$21)`,
      [tid, runId, r.employeeId, r.calendarDays, r.payableDays, r.lopDays,
       r.paidLeaveDays ?? 0, r.otMinutes ?? 0,
       JSON.stringify(r.monthlyComponents), String(r.annualCtcPaise), r.stateCode,
       r.pfApplicable ?? true, r.esiApplicable ?? false, r.taxRegime ?? 'new',
       JSON.stringify(r.adhoc ?? []), r.joinedMidPeriod ?? false, r.exitedMidPeriod ?? false,
       String(r.chapterViaPaise ?? 0), String(r.ytdTaxablePaise ?? 0), String(r.ytdTdsPaise ?? 0),
       monthsRemaining],
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

/**
 * What this employee has already been paid and taxed this fiscal year.
 *
 * LOCKED runs only — a calculated-but-unlocked run can still change. A run
 * that a later revision supersedes is excluded, or a corrected month would be
 * counted twice. Taxable = gross minus the employee's own PF, which is what the
 * engine hands the TDS hook each month, so the two agree by construction.
 */
export async function yearToDate(
  tx: PoolClient,
  employeeId: string,
  periodStart: Date,
): Promise<{ taxablePaise: bigint; tdsPaise: bigint; runs: number }> {
  const fy = fiscalYearOf(periodStart)
  const fyStart = `${fy.slice(0, 4)}-04-01`
  const { rows } = await tx.query<{ gross: string; pf: string; tds: string; runs: string }>(
    `WITH prior AS (
       SELECT r.id
         FROM payroll_runs r
         JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id)
        WHERE r.status = 'locked'
          AND p.period_start >= $2::date AND p.period_start < $3::date
          AND NOT EXISTS (SELECT 1 FROM payroll_runs n
                           WHERE n.tenant_id = r.tenant_id AND n.supersedes_run_id = r.id
                             AND n.status = 'locked')
     ),
     lines AS (
       SELECT component_code, sum(amount_paise) AS amt
         FROM payroll_lines
        WHERE run_id IN (SELECT id FROM prior) AND employee_id = $1
        GROUP BY component_code
     )
     SELECT coalesce((SELECT sum(gross_paise) FROM payslips
                       WHERE run_id IN (SELECT id FROM prior) AND employee_id = $1), 0)::text AS gross,
            coalesce((SELECT amt FROM lines WHERE component_code = 'PF_EE'), 0)::text AS pf,
            coalesce((SELECT amt FROM lines WHERE component_code = 'TDS'), 0)::text AS tds,
            (SELECT count(*) FROM payslips
              WHERE run_id IN (SELECT id FROM prior) AND employee_id = $1)::text AS runs`,
    [employeeId, fyStart, periodStart.toISOString().slice(0, 10)],
  )
  const r = rows[0]!
  return { taxablePaise: BigInt(r.gross) - BigInt(r.pf), tdsPaise: BigInt(r.tds), runs: Number(r.runs) }
}

/** Only before calculation, and only from inputs_frozen. Audited by the caller. */
export async function unfreezeInputs(tx: PoolClient, runId: string): Promise<void> {
  const tid = await tenantId(tx)
  const run = await getRun(tx, runId)
  if (run.status !== 'inputs_frozen') {
    throw new PayrollError('CANNOT_UNFREEZE', `cannot unfreeze a run in status ${run.status}`)
  }
  await tx.query('DELETE FROM payroll_inputs WHERE tenant_id = $1 AND run_id = $2', [tid, runId])
  await releaseSettlements(tx, runId)
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
  // Leavers paid in this run have now left.
  await finalizeSettlements(tx, runId)
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
    adhoc: { code: string; amountPaise: number; taxable?: boolean; type?: 'earning' | 'deduction' }[]
    joined_mid_period: boolean; exited_mid_period: boolean; chapter_via_paise: string
    ytd_taxable_paise: string; ytd_tds_paise: string; months_remaining: number
  }>(
    `SELECT employee_id, calendar_days::text, payable_days::text, lop_days::text,
            monthly_components, state_code, pf_applicable, esi_applicable, tax_regime,
            adhoc, joined_mid_period, exited_mid_period, chapter_via_paise::text,
            ytd_taxable_paise::text, ytd_tds_paise::text, months_remaining
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
    chapterViaPaise: BigInt(r.chapter_via_paise ?? '0'),
    ytdTaxablePaise: BigInt(r.ytd_taxable_paise ?? '0'),
    ytdTdsPaise: BigInt(r.ytd_tds_paise ?? '0'),
    monthsRemaining: r.months_remaining ?? 12,
  }))
}
