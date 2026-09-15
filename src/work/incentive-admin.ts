/**
 * Incentive administration: the plans, the targets, the periods, the sales.
 *
 * The engine in incentives.ts has existed since the module was written and
 * nothing could feed it except a seed. A plan gets in here with its config
 * checked against the calc type; a new version closes the old one the day
 * before, never backdated below a calculated period; targets are set per
 * person per period, in bulk; sales arrive idempotently by external ref.
 */
import type { PoolClient } from 'pg'
import { IncentiveError, computeIncentive, type PlanConfig } from './incentives.ts'

export type CalcType = 'slab' | 'percent_of_metric' | 'flat_on_target' | 'per_unit'
const CALC_TYPES: CalcType[] = ['slab', 'percent_of_metric', 'flat_on_target', 'per_unit']

export interface Plan {
  id: string
  name: string
  version: number
  metric: string
  calc_type: CalcType
  config: PlanConfig
  proration_rule: string
  clawback_enabled: boolean
  effective_from: string
  effective_to: string | null
}

const P_COLS = 'id, name, version, metric, calc_type, config, proration_rule, clawback_enabled, effective_from::text, effective_to::text'

/** The config must make sense for the calc type, and the slabs must tile without gaps or overlap. */
export function validatePlanConfig(calcType: CalcType, config: PlanConfig): PlanConfig {
  if (!CALC_TYPES.includes(calcType)) throw new IncentiveError('VALIDATION_FAILED', `calcType must be one of ${CALC_TYPES.join(', ')}`)
  const num = (v: unknown, name: string, opts: { min?: number; int?: boolean } = {}): number | undefined => {
    if (v === undefined || v === null) return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n < (opts.min ?? 0) || (opts.int && !Number.isInteger(n))) throw new IncentiveError('VALIDATION_FAILED', `${name} is invalid`)
    return n
  }
  const out: PlanConfig = {}
  out.capPaise = num(config.capPaise, 'capPaise', { int: true })
  out.floorAchievementPct = num(config.floorAchievementPct, 'floorAchievementPct')
  switch (calcType) {
    case 'slab': {
      const slabs = config.slabs ?? []
      if (!Array.isArray(slabs) || !slabs.length) throw new IncentiveError('VALIDATION_FAILED', 'a slab plan needs at least one slab')
      const sorted = [...slabs].sort((a, b) => a.fromPct - b.fromPct)
      let prev = -1
      out.slabs = sorted.map((s) => {
        const from = num(s.fromPct, 'slab.fromPct')!, to = num(s.toPct, 'slab.toPct')
        if (from < 0 || (to !== undefined && to <= from)) throw new IncentiveError('VALIDATION_FAILED', `slab ${from}–${to ?? '∞'} is malformed`)
        if (prev >= 0 && from !== prev) throw new IncentiveError('VALIDATION_FAILED', `slabs must tile: one ends at ${prev}%, the next starts at ${from}%`)
        prev = to ?? Number.POSITIVE_INFINITY
        const rate = num(s.ratePct, 'slab.ratePct'), flat = num(s.flatPaise, 'slab.flatPaise', { int: true })
        if ((rate === undefined) === (flat === undefined)) throw new IncentiveError('VALIDATION_FAILED', `slab ${from}%: give ratePct (a fraction, 0.02 = 2%) or flatPaise, not both`)
        if (rate !== undefined && rate > 1) throw new IncentiveError('VALIDATION_FAILED', `slab ${from}%: ratePct is a fraction; 0.02 means 2%`)
        return { fromPct: from, toPct: to, ratePct: rate, flatPaise: flat }
      })
      break
    }
    case 'percent_of_metric':
      out.ratePct = num(config.ratePct, 'ratePct')
      if (out.ratePct === undefined || out.ratePct > 1) throw new IncentiveError('VALIDATION_FAILED', 'ratePct is a fraction between 0 and 1 (0.02 = 2%)')
      break
    case 'flat_on_target':
      out.flatPaise = num(config.flatPaise, 'flatPaise', { int: true })
      if (out.flatPaise === undefined) throw new IncentiveError('VALIDATION_FAILED', 'flatPaise is required')
      break
    case 'per_unit':
      out.perUnitPaise = num(config.perUnitPaise, 'perUnitPaise', { int: true })
      if (out.perUnitPaise === undefined) throw new IncentiveError('VALIDATION_FAILED', 'perUnitPaise is required')
      break
  }
  // Smoke run: a plan that cannot price a 120% achievement on a 1L target is malformed.
  computeIncentive({ calcType, config: out, targetValue: 100_000_00, achievedValue: 120_000_00, prorationFactor: 1 })
  return out
}

export async function listPlans(tx: PoolClient, opts: { asOf?: string; includeClosed?: boolean } = {}): Promise<Plan[]> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const { rows } = await tx.query<Plan>(
    `SELECT ${P_COLS} FROM incentive_plans
      WHERE $2 OR (effective_from <= $1::date AND (effective_to IS NULL OR effective_to >= $1::date))
      ORDER BY name, version DESC`, [asOf, opts.includeClosed ?? false])
  return rows
}

/**
 * Creates version 1, or the next version of a named plan. The previous version
 * closes the day before; a version cannot start inside a period that has
 * already been calculated, because the payout it decided is on record.
 */
export async function publishPlan(
  tx: PoolClient,
  i: { name: string; metric?: string; calcType: CalcType; config: PlanConfig; prorationRule?: string; clawbackEnabled?: boolean; effectiveFrom: string },
  opts: { today?: string } = {},
): Promise<Plan> {
  const name = i.name.trim()
  if (!name || name.length > 120) throw new IncentiveError('VALIDATION_FAILED', 'name is 1–120 characters')
  const config = validatePlanConfig(i.calcType, i.config)
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  if (i.effectiveFrom < today) throw new IncentiveError('PLAN_NOT_BACKDATABLE', 'a plan version starts today or later; the past has been paid')
  const calculated = await tx.query(
    `SELECT 1 FROM incentive_periods WHERE status <> 'open' AND period_end >= $1::date LIMIT 1`, [i.effectiveFrom])
  if (calculated.rowCount) throw new IncentiveError('PLAN_NOT_BACKDATABLE', 'a period covering that date has already been calculated')

  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { rows: prev } = await tx.query<{ id: string; version: number; effective_from: string }>(
    `SELECT id, version, effective_from::text FROM incentive_plans WHERE name = $1 ORDER BY version DESC LIMIT 1`, [name])
  let version = 1
  if (prev[0]) {
    if (prev[0].effective_from >= i.effectiveFrom) throw new IncentiveError('PLAN_NOT_BACKDATABLE', `version ${prev[0].version} already starts on ${prev[0].effective_from}`)
    await tx.query(`UPDATE incentive_plans SET effective_to = $2::date - 1 WHERE id = $1`, [prev[0].id, i.effectiveFrom])
    version = prev[0].version + 1
  }
  const { rows } = await tx.query<Plan>(
    `INSERT INTO incentive_plans (tenant_id, name, version, metric, calc_type, config, proration_rule, clawback_enabled, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9) RETURNING ${P_COLS}`,
    [tid, name, version, i.metric ?? 'sales_value', i.calcType, JSON.stringify(config), i.prorationRule ?? 'by_payable_days', i.clawbackEnabled ?? false, i.effectiveFrom])
  return rows[0]!
}

/** Ends a plan: no version after this. Targets already set under it stand. */
export async function retirePlan(tx: PoolClient, name: string, lastDay: string): Promise<Plan> {
  const { rows } = await tx.query<Plan>(
    `UPDATE incentive_plans SET effective_to = $2::date WHERE name = $1 AND effective_to IS NULL RETURNING ${P_COLS}`, [name.trim(), lastDay])
  if (!rows[0]) throw new IncentiveError('NOT_FOUND', 'no open version of that plan')
  return rows[0]
}

export async function createPeriod(tx: PoolClient, i: { label: string; periodStart: string; periodEnd: string }): Promise<{ id: string }> {
  if (i.periodEnd < i.periodStart) throw new IncentiveError('VALIDATION_FAILED', 'periodEnd is before periodStart')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if ((await tx.query(`SELECT 1 FROM incentive_periods WHERE label = $1`, [i.label])).rowCount) throw new IncentiveError('PERIOD_EXISTS', `period ${i.label} already exists`)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO incentive_periods (tenant_id, label, period_start, period_end) VALUES ($1,$2,$3,$4) RETURNING id`,
    [tid, i.label.trim(), i.periodStart, i.periodEnd])
  return rows[0]!
}

export interface TargetInput { employeeId: string; planId: string; targetValue: number; weight?: number }

/** Sets targets for a period in bulk; an existing (employee, plan) target is replaced. Only while the period is open. */
export async function setTargets(tx: PoolClient, periodId: string, targets: TargetInput[], actorUserId?: string): Promise<{ set: number }> {
  const p = await tx.query<{ status: string; period_start: string }>(`SELECT status, period_start::text FROM incentive_periods WHERE id = $1`, [periodId])
  if (!p.rows[0]) throw new IncentiveError('NOT_FOUND', 'no such period')
  if (p.rows[0].status !== 'open') throw new IncentiveError('PERIOD_CLOSED', 'targets are set while the period is open')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  let set = 0
  for (const t of targets) {
    if (!(t.targetValue > 0)) throw new IncentiveError('VALIDATION_FAILED', 'targetValue must be positive')
    const plan = await tx.query(
      `SELECT 1 FROM incentive_plans WHERE id = $1 AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)`,
      [t.planId, p.rows[0].period_start])
    if (!plan.rowCount) throw new IncentiveError('PLAN_NOT_IN_FORCE', 'that plan version is not in force at the start of the period')
    await tx.query(
      `INSERT INTO incentive_targets (tenant_id, employee_id, plan_id, period_id, target_value, weight, set_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, employee_id, plan_id, period_id) DO UPDATE
         SET target_value = EXCLUDED.target_value, weight = EXCLUDED.weight, set_by_user_id = EXCLUDED.set_by_user_id`,
      [tid, t.employeeId, t.planId, periodId, t.targetValue, t.weight ?? 100, actorUserId ?? null])
    set++
  }
  return { set }
}

export async function listTargets(tx: PoolClient, periodId: string): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT t.id, t.employee_id, e.employee_number, e.first_name, e.last_name, t.plan_id, p.name AS plan_name, p.version,
            t.target_value::text, t.weight::text
       FROM incentive_targets t
       JOIN employees e ON (e.tenant_id, e.id) = (t.tenant_id, t.employee_id)
       JOIN incentive_plans p ON (p.tenant_id, p.id) = (t.tenant_id, t.plan_id)
      WHERE t.period_id = $1 ORDER BY e.employee_number, p.name`, [periodId])
  return rows
}

export interface SaleInput { employeeId: string; occurredOn: string; valuePaise: number; quantity?: number; externalRef?: string }

/** Records achievement, idempotent by (source, externalRef). Only while the period is open. */
export async function recordSales(tx: PoolClient, periodId: string, sales: SaleInput[], source = 'manual'): Promise<{ recorded: number; duplicates: number }> {
  const p = await tx.query<{ status: string; period_start: string; period_end: string }>(
    `SELECT status, period_start::text, period_end::text FROM incentive_periods WHERE id = $1`, [periodId])
  if (!p.rows[0]) throw new IncentiveError('NOT_FOUND', 'no such period')
  if (p.rows[0].status !== 'open') throw new IncentiveError('PERIOD_CLOSED', 'the period is closed; a late sale goes into the next one or a clawback')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  let recorded = 0, duplicates = 0
  for (const s of sales) {
    if (!Number.isSafeInteger(s.valuePaise)) throw new IncentiveError('VALIDATION_FAILED', 'valuePaise must be an integer')
    if (s.occurredOn < p.rows[0].period_start || s.occurredOn > p.rows[0].period_end) throw new IncentiveError('VALIDATION_FAILED', `${s.occurredOn} is outside the period`)
    const r = await tx.query(
      `INSERT INTO sales_records (tenant_id, employee_id, period_id, occurred_on, value_paise, quantity, source, external_ref)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (tenant_id, source, external_ref) WHERE external_ref IS NOT NULL DO NOTHING`,
      [tid, s.employeeId, periodId, s.occurredOn, s.valuePaise, s.quantity ?? null, source, s.externalRef ?? null])
    if (r.rowCount) recorded++; else duplicates++
  }
  return { recorded, duplicates }
}
