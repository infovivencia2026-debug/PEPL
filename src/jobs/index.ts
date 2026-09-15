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
import { controlDb, projectEntitlements } from '../control-plane/index.ts'
import { PgRateLimiter } from '../http/rate-limit-pg.ts'
import type { PoolClient } from 'pg'
import { withTenant } from '../db/tenant-tx.ts'
import { accrueMonthly, rollover } from '../leave/ledger.ts'
import { evaluateBreaches } from '../work/helpdesk.ts'
import { resolveConfig } from '../config/resolver.ts'
import { emit } from '../audit/index.ts'
import { runOutbox } from '../mail/outbox.ts'
import { deliverEmails } from '../comms/delivery.ts'
import { deliverPush } from '../comms/push.ts'
import { escalateStale } from '../approvals/policy.ts'
import { distributeRun, pendingRuns } from '../payroll/distribute.ts'
import { generateVapidKeys, vapidFromEnv } from '../comms/web-push.ts'
import { purgeOldMessages } from '../comms/chat.ts'
import { syncTenant } from '../mail/sync.ts'

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
/** Coordinates older than 180 days are blanked; the punch itself is evidence and stays. */
export async function purgeOldCoordinates(tx: PoolClient, olderThanDays = 180): Promise<number> {
  const r = await tx.query(
    `UPDATE attendance_punches SET geo_lat = NULL, geo_lng = NULL
      WHERE local_date < CURRENT_DATE - $1::int AND (geo_lat IS NOT NULL OR geo_lng IS NOT NULL)`, [olderThanDays])
  return r.rowCount ?? 0
}

export async function runRetentionPurge(): Promise<JobResult> {
  // Rate-limit counters are global, not per tenant; one sweep per pass.
  await PgRateLimiter.sweep().catch(() => { /* an UNLOGGED counter table is not worth failing the job over */ })
  return perTenant('data.retention', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      // Attendance selfies and raw coordinates age out first: they are the
      // highest-volume tier-3 data and the least useful once verified.
      const rowCount = await purgeOldCoordinates(tx)

      // Chat history, if this company set a retention window. Zero keeps
      // everything, which is the default.
      const cfg = await resolveConfig(tx, tenantId)
      const retentionDays = cfg.isEnabled('chat.enabled')
        ? cfg.get<number>('chat.history_retention_days')
        : 0
      const purgedMessages = await purgeOldMessages(tx, retentionDays)
      if (purgedMessages > 0) {
        await emit(tx, {
          action: 'data.retention.purged',
          entityType: 'chat', actorType: 'system',
          metadata: { purged: purgedMessages, kind: 'chat_messages', olderThanDays: retentionDays },
        }).catch(() => { /* the purge itself must not fail on an audit hiccup */ })
      }

      if (rowCount && rowCount > 0) {
        await emit(tx, {
          action: 'data.retention.purged',
          entityType: 'attendance', actorType: 'system',
          metadata: { purged: rowCount, kind: 'punch_coordinates', olderThanDays: 180 },
        }).catch(() => { /* the purge itself must not fail on an audit hiccup */ })
      }
      return (rowCount ?? 0) + purgedMessages
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

/**
 * Drains queued outbound mail.
 *
 * Runs per tenant like every other job, so one company with an unreachable
 * mail server cannot hold up delivery for the rest. The encryption key comes
 * from the environment: without it the job does nothing rather than failing
 * loudly on every tenant, because a missing key is a deployment problem, not a
 * per-tenant one.
 */
export async function runMailOutbox(): Promise<JobResult> {
  const master = process.env.PEPL_MAIL_KEY
  if (!master) {
    return { job: 'mail.outbox', tenants: 0, affected: 0, durationMs: 0,
      errors: [{ tenantId: '-', message: 'PEPL_MAIL_KEY is not set; outbound mail is not being sent' }] }
  }
  return perTenant('mail.outbox', async (tenantId) => {
    const cfg = await withTenant(tenantId, (tx) => resolveConfig(tx, tenantId))
    if (!cfg.isEnabled('mail.enabled')) return 0
    const result = await runOutbox(tenantId, { master })
    return result.sent
  })
}

/**
 * Emails notifications for companies that asked for it.
 *
 * The message is queued through the ordinary outbox rather than sent inline,
 * so it inherits that retry and backoff instead of growing a second delivery
 * path that fails differently.
 */
export async function runNotificationEmail(): Promise<JobResult> {
  return perTenant('notifications.email', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('notifications.enabled')) return 0
      if (!cfg.get<boolean>('notifications.email_enabled')) return 0

      const { rows } = await tx.query<{ display_name: string }>(
        `SELECT display_name FROM tenants WHERE id = $1`, [tenantId])

      const result = await deliverEmails(tx, {
        senderEmail: cfg.get<string>('notifications.sender_email') || null,
        companyName: rows[0]?.display_name ?? 'Your company',
      })
      return result.sent
    }))
}

/**
 * Pulls new mail into the local cache.
 *
 * Envelopes only unless the company switched on mail.store_bodies — the
 * default is that PEPL holds enough to render a list and nothing more.
 */
export async function runMailSync(): Promise<JobResult> {
  const master = process.env.PEPL_MAIL_KEY
  if (!master) {
    return { job: 'mail.sync', tenants: 0, affected: 0, durationMs: 0,
      errors: [{ tenantId: '-', message: 'PEPL_MAIL_KEY is not set; mailboxes cannot be synced' }] }
  }
  return perTenant('mail.sync', async (tenantId) => {
    const cfg = await withTenant(tenantId, (tx) => resolveConfig(tx, tenantId))
    if (!cfg.isEnabled('mail.enabled')) return 0
    const results = await syncTenant(tenantId, {
      master,
      storeBodies: cfg.get<boolean>('mail.store_bodies'),
    })
    return results.reduce((n, r) => n + r.messagesAdded, 0)
  })
}

/**
 * Re-derives every tenant's entitlements from its plan.
 *
 * tenant_entitlements is a PROJECTION of plan + subscription + add-ons, and
 * nothing re-projects on its own. When the catalogue changes — a feature added
 * to a tier, a price change — existing customers keep the old projection until
 * this runs. It cannot be done in a migration: tenant_entitlements is under
 * FORCE ROW LEVEL SECURITY, so an UPDATE from the migration role with no tenant
 * context matches zero rows and reports success.
 */
export async function runReprojectEntitlements(): Promise<JobResult> {
  const started = Date.now()
  const { rows } = await controlDb.query<{ id: string }>(
    `SELECT id FROM tenants WHERE status = 'active'`)
  const errors: { tenantId: string; message: string }[] = []
  let affected = 0

  for (const tenant of rows) {
    try {
      // The superuser control connection, deliberately: this is a control-plane
      // write, and the app role is explicitly denied it.
      await projectEntitlements(controlDb, tenant.id)
      affected++
    } catch (err) {
      errors.push({ tenantId: tenant.id, message: (err as Error).message })
    }
  }
  return { job: 'control.reproject_entitlements', tenants: rows.length, affected, errors, durationMs: Date.now() - started }
}

/**
 * Web Push for companies that switched it on. Nothing to do without VAPID keys
 * in the environment — and that is reported, not swallowed.
 */
export async function runNotificationPush(): Promise<JobResult> {
  const keys = vapidFromEnv()
  if (!keys) {
    return { job: 'notifications.push', tenants: 0, affected: 0, durationMs: 0,
      errors: [{ tenantId: '-', message: 'PEPL_VAPID_* is not set; run `npm run job push.keygen` and set the keys' }] }
  }
  return perTenant('notifications.push', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('notifications.enabled')) return 0
      if (!cfg.get<boolean>('notifications.push_enabled')) return 0
      const r = await deliverPush(tx, keys)
      for (const e of r.errors) console.error(`[notifications.push] ${tenantId}: ${e}`)
      return r.sent
    }))
}

/** Prints a fresh VAPID keypair. Run once per deployment; put the output in the environment. */
export async function runPushKeygen(): Promise<JobResult> {
  const k = generateVapidKeys()
  console.log(`PEPL_VAPID_PUBLIC_KEY=${k.publicKey}`)
  console.log(`PEPL_VAPID_PRIVATE_KEY=${k.privateKey}`)
  console.log('PEPL_VAPID_SUBJECT=mailto:ops@yourcompany.example')
  return { job: 'push.keygen', tenants: 0, affected: 1, errors: [], durationMs: 0 }
}

/** Skips steps pending past the company's limit so requests reach the next approver. */
export async function runApprovalEscalation(): Promise<JobResult> {
  return perTenant('approvals.escalate', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      return escalateStale(tx, cfg.get<number>('approvals.escalate_after_days'))
    }))
}

/**
 * Emails the payslips of every locked run that still has undelivered ones.
 * Idempotent per payslip, so a crashed pass resumes rather than resends.
 */
export async function runPayslipDistribution(): Promise<JobResult> {
  return perTenant('payroll.payslips', async (tenantId) =>
    withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      if (!cfg.isEnabled('payroll.enabled')) return 0
      if (!cfg.get<boolean>('payroll.email_payslips')) return 0
      let sent = 0
      for (const run of await pendingRuns(tx)) {
        const r = await distributeRun(tx, { runId: run.run_id, periodLabel: run.label })
        sent += r.sent
        for (const f of r.failed) console.error(`[payroll.payslips] ${tenantId} ${f.employeeNumber}: ${f.error}`)
      }
      return sent
    }))
}

export const JOBS = {
  'leave.accrual': () => runLeaveAccrual(),
  'helpdesk.sla': runSlaBreaches,
  'data.retention': runRetentionPurge,
  'audit.seal': runAuditSeal,
  'mail.outbox': runMailOutbox,
  'mail.sync': runMailSync,
  'control.reproject_entitlements': runReprojectEntitlements,
  'notifications.email': runNotificationEmail,
  'notifications.push': runNotificationPush,
  'payroll.payslips': runPayslipDistribution,
  'push.keygen': runPushKeygen,
  'approvals.escalate': runApprovalEscalation,
} as const

export type JobName = keyof typeof JOBS
