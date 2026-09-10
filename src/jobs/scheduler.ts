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
import { JOBS, type JobName, type JobResult } from './index.ts'
import { closePools } from '../db/pool.ts'
import { controlDb } from '../control-plane/index.ts'
import { installProcessGuards } from '../http/process-guards.ts'

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

  // Operational hygiene.
  { job: 'helpdesk.sla', everyMs: 15 * MINUTE },

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
    log({
      level: result.errors.length ? 'warn' : 'info',
      msg: 'job finished', job,
      tenants: result.tenants, affected: result.affected,
      errors: result.errors.length, ms: Date.now() - started,
    })
    return result
  } catch (err) {
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

  for (const entry of schedule) {
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

  log({ level: 'info', msg: 'scheduler started', jobs: schedule.map((s) => s.job) })
  return () => {
    for (const timer of timers) clearInterval(timer)
    log({ level: 'info', msg: 'scheduler stopped' })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  installProcessGuards()
  const stop = startScheduler()

  const shutdown = async (signal: string): Promise<void> => {
    log({ level: 'info', msg: 'shutting down', signal })
    stop()
    await closePools().catch(() => {})
    await controlDb.end().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}
