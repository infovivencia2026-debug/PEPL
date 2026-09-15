/**
 * The scheduler.
 *
 * `npm run job <name>` has always existed and something was assumed to call it.
 * Nothing did, which meant queued mail sat forever in any real deployment. This
 * is that something: one long-lived process, interval-driven, no cron entry to
 * forget on the next server.
 *
 * Intervals rather than cron expressions, deliberately. Every job here is
 * idempotent, so "roughly every five minutes" is a complete specification and
 * needs no timezone reasoning, no catch-up semantics and no dependency. The two
 * calendar jobs that genuinely care what day it is check that themselves.
 *
 *   npm run scheduler
 */
import { pathToFileURL } from 'node:url'
import { jobDuration, jobRuns } from '../lib/metrics.ts'
import { JOBS, type JobName, type JobResult } from './index.ts'
import { closePools } from '../db/pool.ts'
import { controlDb } from '../control-plane/index.ts'
import { startIdleWatchers } from '../mail/idle.ts'
import { vapidFromEnv } from '../comms/web-push.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { resolveConfig } from '../config/resolver.ts'
import { installProcessGuards } from '../http/process-guards.ts'
import { startRelay } from '../realtime/relay.ts'
import { appPool } from '../db/pool.ts'

interface Schedule {
  job: JobName
  everyMs: number
  /** Skipped unless this returns true — for the jobs that care about the date. */
  due?: (now: Date) => boolean
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

export const SCHEDULE: Schedule[] = [
  // Mail is the latency-sensitive one: a person watching for a reply notices
  // five minutes and does not notice one.
  { job: 'mail.outbox', everyMs: 2 * MINUTE },
  { job: 'mail.sync', everyMs: 5 * MINUTE },
  { job: 'notifications.email', everyMs: 5 * MINUTE },
  // Payslips go out within a quarter hour of a run being locked.
  { job: 'payroll.payslips', everyMs: 15 * MINUTE },
  // Push is what people expect to buzz within a minute of the event.
  { job: 'notifications.push', everyMs: MINUTE },

  // Operational hygiene.
  { job: 'helpdesk.sla', everyMs: 15 * MINUTE },
  { job: 'approvals.escalate', everyMs: HOUR },

  // Daily work, checked hourly so a restart cannot miss the window.
  { job: 'audit.seal', everyMs: HOUR, due: (now) => now.getHours() === 1 },
  { job: 'data.retention', everyMs: HOUR, due: (now) => now.getHours() === 2 },

  // Leave accrual runs on the last day of the month. The job itself is keyed on
  // (employee, type, cycle, period), so a second run credits nothing twice —
  // the date check is about not doing pointless work, not about correctness.
  {
    job: 'leave.accrual',
    everyMs: HOUR,
    due: (now) => {
      const tomorrow = new Date(now)
      tomorrow.setDate(now.getDate() + 1)
      return now.getHours() === 3 && tomorrow.getMonth() !== now.getMonth()
    },
  },
]

function log(entry: Record<string, unknown>): void {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }))
}

/**
 * Runs one job, never throwing.
 *
 * A scheduler that dies on a job failure stops every other job too, which is
 * how one broken tenant silently ends payroll reminders for all of them.
 */
export async function runOnce(job: JobName): Promise<JobResult | null> {
  const started = Date.now()
  try {
    const result = await JOBS[job]()
    jobRuns.inc({ job, outcome: result.errors.length ? 'errors' : 'ok' })
    jobDuration.observe({ job }, (Date.now() - started) / 1000)
    log({
      level: result.errors.length ? 'warn' : 'info',
      msg: 'job finished', job,
      tenants: result.tenants, affected: result.affected,
      errors: result.errors.length, ms: Date.now() - started,
    })
    return result
  } catch (err) {
    jobRuns.inc({ job, outcome: 'failed' })
    log({ level: 'error', msg: 'job failed', job, err: (err as Error).message })
    return null
  }
}

/**
 * Starts the loop and returns a stop function.
 *
 * A job never overlaps itself: if a pass is still running when the next tick
 * arrives the tick is skipped, because two concurrent syncs of the same mailbox
 * is exactly the situation the idempotency keys exist to survive rather than a
 * situation worth creating.
 */
export function startScheduler(schedule: Schedule[] = SCHEDULE): () => void {
  const timers: NodeJS.Timeout[] = []
  const running = new Set<JobName>()

  // Push without VAPID keys would report the same missing-key error every
  // minute. Say it once here and leave the job out; `npm run job` still runs it.
  const pushReady = (() => { try { return vapidFromEnv() !== null } catch { return false } })()
  if (!pushReady) log({ level: 'info', msg: 'push off (PEPL_VAPID_* not set); run npm run job push.keygen' })

  for (const entry of schedule) {
    if (entry.job === 'notifications.push' && !pushReady) continue
    const tick = async (): Promise<void> => {
      if (running.has(entry.job)) {
        log({ level: 'warn', msg: 'job still running, tick skipped', job: entry.job })
        return
      }
      if (entry.due && !entry.due(new Date())) return
      running.add(entry.job)
      try {
        await runOnce(entry.job)
      } finally {
        running.delete(entry.job)
      }
    }

    // Stagger the first run so a restart does not fire every job at once.
    const timer = setInterval(tick, entry.everyMs)
    timers.push(timer)
    setTimeout(() => void tick(), 5_000 + timers.length * 3_000)
  }

  log({ level: 'info', msg: 'scheduler started',
    jobs: schedule.filter((s) => s.job !== 'notifications.push' || pushReady).map((s) => s.job) })
  return () => {
    for (const timer of timers) clearInterval(timer)
    log({ level: 'info', msg: 'scheduler stopped' })
  }
}

/**
 * IMAP IDLE runs in the scheduler process alongside the poll. Without
 * PEPL_MAIL_KEY there is nothing to decrypt, so nothing to watch; the poll job
 * already reports that. PEPL_MAIL_IDLE_MAX caps the sockets (default 50; 0 off).
 */
export function startIdle(): { stop: () => Promise<void> } | null {
  const master = process.env.PEPL_MAIL_KEY
  const max = Number(process.env.PEPL_MAIL_IDLE_MAX ?? 50)
  if (!master || !Number.isFinite(max) || max <= 0) return null
  return startIdleWatchers({
    master,
    maxConnections: max,
    tenants: async () => {
      const { rows } = await controlDb.query<{ id: string }>(
        `SELECT t.id FROM tenants t JOIN tenant_entitlements e ON e.tenant_id = t.id
          WHERE t.status = 'active' AND e.status IN ('trialing','active','past_due')`)
      const out: string[] = []
      for (const r of rows) {
        const cfg = await withTenant(r.id, (tx) => resolveConfig(tx, r.id))
        if (cfg.isEnabled('mail.enabled')) out.push(r.id)
      }
      return out
    },
    storeBodies: async (tenantId) => {
      const cfg = await withTenant(tenantId, (tx) => resolveConfig(tx, tenantId))
      return cfg.get<boolean>('mail.store_bodies')
    },
    log,
  })
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  installProcessGuards()
  const stop = startScheduler()
  const idle = startIdle()
  // Events a job publishes (mail sync, escalations) must reach the API instances' browsers.
  const relay = startRelay(appPool)
  log({ level: 'info', msg: idle ? 'imap idle watchers started' : 'imap idle off (no PEPL_MAIL_KEY or PEPL_MAIL_IDLE_MAX=0)' })

  const shutdown = async (signal: string): Promise<void> => {
    log({ level: 'info', msg: 'shutting down', signal })
    stop()
    await idle?.stop().catch(() => {})
    await relay.stop().catch(() => {})
    await closePools().catch(() => {})
    await controlDb.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
