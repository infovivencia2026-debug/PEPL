/**
 * Scheduled jobs.
 *
 * Every job here is idempotent and re-runnable: a scheduler that fires twice, a
 * crash mid-run, or a manual re-trigger must not double-credit leave, double-mint
 * a comp-off or double-notify. That property is enforced in the domain modules
 * (idempotency keys, unique indexes), not by hoping the scheduler behaves.
 *
 * Each job iterates tenants and opens ONE TRANSACTION PER TENANT — never one
 * spanning several, which would both hold locks too long and blur the isolation
 * boundary the whole system rests on.
 */
import { controlDb } from '../control-plane/index.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { accrueMonthly, rollover } from '../leave/ledger.ts'
import { evaluateBreaches } from '../work/helpdesk.ts'
import { resolveConfig } from '../config/resolver.ts'
import { emit } from '../audit/index.ts'

export interface JobResult {
  job: string
  tenants: number
  affected: number
  errors: { tenantId: string; message: string }[]
  durationMs: number
}

async function activeTenants(): Promise<string[]> {
  const { rows } = await controlDb.query<{ id: string }>(
    `SELECT t.id FROM tenants t
       JOIN tenant_entitlements e ON e.tenant_id = t.id
      WHERE t.status = 'active' AND e.status IN ('trialing','active','past_due')`,
  )
  return rows.map((r) => r.id)
}

/** Runs one job across every active tenant, isolating failures per tenant. */
async function perTenant(
  job: string,
  run: (tenantId: string) => Promise<number>,
): Promise<JobResult> {
  const started = Date.now()
  const tenants = await activeTenants()
  const errors: { tenantId: string; message: string }[] = []
  let affected = 0

  for (const tenantId of tenants) {
    try {
      affected += await run(tenantId)
    } catch (err) {
      // One tenant's bad data must not stop the job for everyone else.
      errors.push({ tenantId, message: (err as Error).message })
      console.error(`[${job}] tenant ${tenantId} failed:`, (err as Error).message)
    }
  }

  return { job, tenants: tenants.length, affected, errors, durationMs: Date.now() - started }
}

/**
 * Monthly leave accrual. Keyed on (employee, type, cycle, period), so running it
 * twice in a month credits once.
 */
export async function runLeaveAccrual(period?: string): Promise<JobResult> {
  const month = period ?? new Date().toISOString().slice(0, 7)
  const [year, mm] = month.split('-')
  const lastDay = new Date(Number(year), Number(mm), 0).getDate()
  const effectiveDate = `${month}-${String(lastDay).padStart(2, '0')}`

  return perTenant('leave.accrual', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('leave.enabled')) return 0

      const cycleStartMonth = cfg.get<number>('leave.cycle_start_month')
      const cycleYear = Number(mm) >= cycleStartMonth ? Number(year) : Number(year) - 1

      const { rows: policies } = await tx.query<{
        leave_type_id: string; accrual_units_per_period: string; accrual_method: string
      }>(
        `SELECT DISTINCT ON (leave_type_id)
                leave_type_id, accrual_units_per_period::text, accrual_method
           FROM leave_policies
          WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
          ORDER BY leave_type_id, version DESC`,
        [effectiveDate])

      const { rows: employees } = await tx.query<{ id: string }>(
        `SELECT id FROM employees WHERE status IN ('active','probation','notice')`)

      let credited = 0
      for (const p of policies) {
        if (p.accrual_method !== 'monthly') continue
        const units = Number(p.accrual_units_per_period)
        if (units <= 0) continue
        for (const e of employees) {
          const wrote = await accrueMonthly(tx, {
            employeeId: e.id, leaveTypeId: p.leave_type_id,
            cycleYear, period: month, units, effectiveDate,
          })
          if (wrote) credited++
        }
      }
      return credited
    }))
}

/**
 * Leave-year rollover. Writes carry-forward and lapse ENTRIES rather than
 * resetting a counter, so the year end is visible and a failure is detectable
 * instead of silently carrying stale balances into January.
 */
export async function runLeaveRollover(fromCycle: number): Promise<JobResult> {
  return perTenant('leave.rollover', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('leave.enabled')) return 0

      const startMonth = cfg.get<number>('leave.cycle_start_month')
      const cycleEnd = startMonth === 1
        ? `${fromCycle}-12-31`
        : `${fromCycle + 1}-${String(startMonth - 1).padStart(2, '0')}-28`
      const nextStart = startMonth === 1
        ? `${fromCycle + 1}-01-01`
        : `${fromCycle + 1}-${String(startMonth).padStart(2, '0')}-01`

      const { rows: policies } = await tx.query<{ leave_type_id: string; carry_forward_limit: string }>(
        `SELECT DISTINCT ON (leave_type_id) leave_type_id, carry_forward_limit::text
           FROM leave_policies ORDER BY leave_type_id, version DESC`)
      const { rows: employees } = await tx.query<{ id: string }>(
        `SELECT id FROM employees WHERE status <> 'exited'`)

      let processed = 0
      for (const p of policies) {
        for (const e of employees) {
          await rollover(tx, {
            employeeId: e.id, leaveTypeId: p.leave_type_id,
            fromCycle, toCycle: fromCycle + 1,
            carryForwardLimit: Number(p.carry_forward_limit),
            cycleEndDate: cycleEnd, nextCycleStartDate: nextStart,
          })
          processed++
        }
      }
      return processed
    }))
}

/** Marks SLA breaches. Re-running marks nothing new. */
export async function runSlaBreaches(): Promise<JobResult> {
  return perTenant('helpdesk.sla', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('helpdesk.enabled')) return 0
      return evaluateBreaches(tx)
    }))
}

/**
 * Retention purge. Deletes only what the policy allows and records that it ran —
 * a purge nobody can see is indistinguishable from data loss.
 */
export async function runRetentionPurge(): Promise<JobResult> {
  return perTenant('data.retention', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      // Attendance selfies and raw coordinates age out first: they are the
      // highest-volume tier-3 data and the least useful once verified.
      const { rowCount } = await tx.query(
        `UPDATE attendance_punches
            SET geo_lat = NULL, geo_lng = NULL
          WHERE local_date < CURRENT_DATE - 180
            AND (geo_lat IS NOT NULL OR geo_lng IS NOT NULL)`)

      if (rowCount && rowCount > 0) {
        await emit(tx, {
          action: 'data.retention.purged',
          entityType: 'attendance', actorType: 'system',
          metadata: { purged: rowCount, kind: 'punch_coordinates', olderThanDays: 180 },
        }).catch(() => { /* the purge itself must not fail on an audit hiccup */ })
      }
      return rowCount ?? 0
    }))
}

/** Seals each tenant's audit chain so a later break is provable. */
export async function runAuditSeal(): Promise<JobResult> {
  return perTenant('audit.seal', async (tenantId) => {
    const { rows } = await controlDb.query<{ id: string; row_hash: Buffer }>(
      `SELECT id, row_hash FROM audit_events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 1`,
      [tenantId])
    const tip = rows[0]
    if (!tip) return 0
    await controlDb.query(
      `INSERT INTO control_plane.audit_seals (tenant_id, sealed_date, last_event_id, tip_hash)
       VALUES ($1, CURRENT_DATE, $2, $3)
       ON CONFLICT (tenant_id, sealed_date) DO UPDATE
         SET last_event_id = EXCLUDED.last_event_id, tip_hash = EXCLUDED.tip_hash, sealed_at = now()`,
      [tenantId, tip.id, tip.row_hash])
    return 1
  })
}

export const JOBS = {
  'leave.accrual': () => runLeaveAccrual(),
  'helpdesk.sla': runSlaBreaches,
  'data.retention': runRetentionPurge,
  'audit.seal': runAuditSeal,
} as const

export type JobName = keyof typeof JOBS
