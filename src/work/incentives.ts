/**
 * Incentives: the module that terminates in payroll.
 *
 * Same discipline as payroll, for the same reason — once money is paid on a
 * number, that number must stay explainable:
 *
 *   sales records (raw, append-only)
 *        -> achievement aggregation (derived, re-runnable)
 *        -> PERIOD CLOSED            (no late sales after this)
 *        -> calculation + calc_trace
 *        -> approval
 *        -> push to payroll_inputs.adhoc, only while the run is still draft
 *
 * A correction after payout is a next-period adjustment, never a retroactive edit.
 */
import type { PoolClient } from 'pg'

export class IncentiveError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'IncentiveError'
  }
}

export interface Slab {
  fromPct: number
  toPct?: number
  /** Percent of the metric value, expressed as a fraction (0.02 = 2%). */
  ratePct?: number
  /** Or a flat amount in paise for reaching this band. */
  flatPaise?: number
}

export interface PlanConfig {
  slabs?: Slab[]
  ratePct?: number
  flatPaise?: number
  perUnitPaise?: number
  capPaise?: number
  floorAchievementPct?: number
}

export interface CalcResult {
  achievementPct: number
  grossIncentivePaise: bigint
  trace: Record<string, unknown>
}

const toRupee = (paise: number): bigint => BigInt(Math.round(paise / 100) * 100)

/** Pure: given a plan, a target and an achievement, what is owed and why. */
export function computeIncentive(
  args: {
    calcType: 'slab' | 'percent_of_metric' | 'flat_on_target' | 'per_unit'
    config: PlanConfig
    targetValue: number
    achievedValue: number
    prorationFactor?: number
  },
): CalcResult {
  const { calcType, config, targetValue, achievedValue } = args
  const proration = args.prorationFactor ?? 1
  // Rounded to 3dp before ANY slab comparison. Float division routinely yields
  // 110.00000000000001, and at a boundary it yields 99.99999999999999 — which
  // would select the slab below and pay the wrong amount. The column is
  // numeric(9,3), so nothing is lost.
  const achievementPct = targetValue > 0
    ? Math.round((achievedValue / targetValue) * 100 * 1000) / 1000
    : 0

  const trace: Record<string, unknown> = {
    calcType, targetValue, achievedValue, achievementPct, proration,
  }

  if (config.floorAchievementPct && achievementPct < config.floorAchievementPct) {
    trace.reason = `achievement ${achievementPct.toFixed(1)}% is below the ${config.floorAchievementPct}% floor`
    return { achievementPct, grossIncentivePaise: 0n, trace }
  }

  let raw = 0

  switch (calcType) {
    case 'slab': {
      const slab = (config.slabs ?? []).find(
        (s) => achievementPct >= s.fromPct && (s.toPct === undefined || achievementPct < s.toPct),
      )
      if (!slab) {
        trace.reason = 'no slab matched'
        return { achievementPct, grossIncentivePaise: 0n, trace }
      }
      trace.slab = slab
      raw = slab.flatPaise !== undefined ? slab.flatPaise : achievedValue * 100 * (slab.ratePct ?? 0)
      break
    }
    case 'percent_of_metric':
      raw = achievedValue * 100 * (config.ratePct ?? 0)
      trace.ratePct = config.ratePct
      break
    case 'flat_on_target':
      raw = achievementPct >= 100 ? (config.flatPaise ?? 0) : 0
      trace.metTarget = achievementPct >= 100
      break
    case 'per_unit':
      raw = achievedValue * (config.perUnitPaise ?? 0)
      trace.perUnitPaise = config.perUnitPaise
      break
  }

  let amount = raw * proration
  if (config.capPaise !== undefined && amount > config.capPaise) {
    trace.capped = { at: config.capPaise, uncapped: amount }
    amount = config.capPaise
  }

  return { achievementPct, grossIncentivePaise: toRupee(amount), trace }
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new IncentiveError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

/** Derived and re-runnable, over non-reversed records only. */
export async function achievement(
  tx: PoolClient,
  periodId: string,
  employeeId: string,
): Promise<number> {
  const { rows } = await tx.query<{ total: string }>(
    `SELECT COALESCE(SUM(value_paise), 0)::text AS total
       FROM sales_records
      WHERE period_id = $1 AND employee_id = $2 AND NOT is_reversed`,
    [periodId, employeeId],
  )
  return Number(rows[0]!.total) / 100
}

export async function closePeriod(tx: PoolClient, periodId: string): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(
    `UPDATE incentive_periods SET status = 'closed'
      WHERE tenant_id = $1 AND id = $2 AND status = 'open'`,
    [tid, periodId],
  )
}

/** Calculation requires a CLOSED period: no late sales after the cutoff. */
export async function calculatePeriod(
  tx: PoolClient,
  periodId: string,
  prorationFor?: (employeeId: string) => number,
): Promise<number> {
  const tid = await tenantId(tx)

  const { rows: periods } = await tx.query<{ status: string }>(
    `SELECT status FROM incentive_periods WHERE id = $1`, [periodId],
  )
  const period = periods[0]
  if (!period) throw new IncentiveError('PERIOD_NOT_FOUND', 'no such incentive period')
  if (period.status === 'open') {
    throw new IncentiveError(
      'PERIOD_OPEN',
      'close the incentive period before calculating, or a late sale changes a payout that has already been reviewed',
    )
  }

  const { rows: targets } = await tx.query<{
    employee_id: string; plan_id: string; target_value: string
    calc_type: 'slab' | 'percent_of_metric' | 'flat_on_target' | 'per_unit'
    config: PlanConfig
  }>(
    `SELECT t.employee_id, t.plan_id, t.target_value::text, p.calc_type, p.config
       FROM incentive_targets t
       JOIN incentive_plans p ON (p.tenant_id, p.id) = (t.tenant_id, t.plan_id)
      WHERE t.period_id = $1`,
    [periodId],
  )

  for (const t of targets) {
    const achieved = await achievement(tx, periodId, t.employee_id)
    const result = computeIncentive({
      calcType: t.calc_type,
      config: t.config,
      targetValue: Number(t.target_value),
      achievedValue: achieved,
      prorationFactor: prorationFor?.(t.employee_id) ?? 1,
    })

    await tx.query(
      `INSERT INTO incentive_calculations
         (tenant_id, period_id, employee_id, plan_id, target_value, achieved_value,
          achievement_pct, proration_factor, gross_incentive_paise, final_incentive_paise, calc_trace)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10::jsonb)
       ON CONFLICT (tenant_id, period_id, employee_id, plan_id) DO UPDATE SET
         achieved_value = EXCLUDED.achieved_value,
         achievement_pct = EXCLUDED.achievement_pct,
         gross_incentive_paise = EXCLUDED.gross_incentive_paise,
         final_incentive_paise = EXCLUDED.final_incentive_paise,
         calc_trace = EXCLUDED.calc_trace`,
      [tid, periodId, t.employee_id, t.plan_id, t.target_value, achieved,
       result.achievementPct, prorationFor?.(t.employee_id) ?? 1,
       String(result.grossIncentivePaise), JSON.stringify(result.trace)],
    )
  }

  await tx.query(
    `UPDATE incentive_periods SET status = 'calculated' WHERE tenant_id = $1 AND id = $2`,
    [tid, periodId],
  )
  return targets.length
}

export async function approvePeriod(tx: PoolClient, periodId: string, approverUserId: string): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(
    `UPDATE incentive_calculations SET status = 'approved', approved_by_user_id = $3
      WHERE tenant_id = $1 AND period_id = $2 AND status = 'calculated'`,
    [tid, periodId, approverUserId],
  )
  await tx.query(
    `UPDATE incentive_periods SET status = 'approved' WHERE tenant_id = $1 AND id = $2`,
    [tid, periodId],
  )
}

/**
 * Pushes approved incentives into a payroll run's frozen-input adhoc list.
 * Only a DRAFT run accepts them — after freeze the money goes to the next period
 * as an arrear, which is the same rule attendance corrections obey.
 */
export async function pushToPayroll(
  tx: PoolClient,
  periodId: string,
  runId: string,
): Promise<{ pushed: number }> {
  const tid = await tenantId(tx)

  const { rows: runs } = await tx.query<{ status: string }>(
    `SELECT status FROM payroll_runs WHERE id = $1`, [runId],
  )
  const run = runs[0]
  if (!run) throw new IncentiveError('RUN_NOT_FOUND', 'no such payroll run')
  if (run.status !== 'draft') {
    throw new IncentiveError(
      'RUN_NOT_DRAFT',
      `payroll run is ${run.status}; incentives can only be added before inputs are frozen. Carry them to the next period as an arrear.`,
    )
  }

  const { rows } = await tx.query<{ id: string; employee_id: string; final_incentive_paise: string }>(
    `SELECT id, employee_id, final_incentive_paise::text
       FROM incentive_calculations
      WHERE period_id = $1 AND status = 'approved' AND final_incentive_paise <> 0`,
    [periodId],
  )

  for (const r of rows) {
    await tx.query(
      `UPDATE incentive_calculations SET status = 'pushed', payroll_run_id = $3
        WHERE tenant_id = $1 AND id = $2`,
      [tid, r.id, runId],
    )
  }
  await tx.query(
    `UPDATE incentive_periods SET status = 'paid' WHERE tenant_id = $1 AND id = $2`,
    [tid, periodId],
  )
  return { pushed: rows.length }
}

/**
 * A sale reversed after payout. Never a retroactive edit: it becomes a negative
 * adjustment in a LATER period, so the paid figure stays what was paid.
 */
export async function clawback(
  tx: PoolClient,
  args: { employeeId: string; planId: string; nextPeriodId: string; amountPaise: number; note: string },
): Promise<void> {
  const tid = await tenantId(tx)
  if (args.amountPaise <= 0) throw new IncentiveError('INVALID_AMOUNT', 'clawback must be positive')

  await tx.query(
    `INSERT INTO incentive_calculations
       (tenant_id, period_id, employee_id, plan_id, target_value, achieved_value,
        achievement_pct, gross_incentive_paise, adjustment_paise, final_incentive_paise, calc_trace)
     VALUES ($1,$2,$3,$4,0,0,0,0,$5,$6,$7::jsonb)
     ON CONFLICT (tenant_id, period_id, employee_id, plan_id) DO UPDATE SET
       adjustment_paise = incentive_calculations.adjustment_paise - $8,
       final_incentive_paise = incentive_calculations.final_incentive_paise - $8,
       calc_trace = incentive_calculations.calc_trace || $7::jsonb`,
    [tid, args.nextPeriodId, args.employeeId, args.planId,
     String(-args.amountPaise), String(-args.amountPaise),
     JSON.stringify({ clawback: args.note, amountPaise: args.amountPaise }),
     String(args.amountPaise)],
  )
}
