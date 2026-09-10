/**
 * The scheduler.
 *
 * Nothing here touches the database: the jobs have their own suites, and what
 * needs proving is the loop around them — that a failure does not stop the
 * rest, that a slow job does not overlap itself, and that the calendar checks
 * fire on the day they claim.
 */
import { describe, it, expect, vi } from 'vitest'
import { SCHEDULE, startScheduler } from '../src/jobs/scheduler.ts'
import { JOBS } from '../src/jobs/index.ts'

describe('the schedule', () => {
  it('names only jobs that exist', () => {
    for (const entry of SCHEDULE) {
      expect(Object.keys(JOBS)).toContain(entry.job)
    }
  })

  it('covers the jobs a deployment cannot do without', () => {
    const scheduled = SCHEDULE.map((s) => s.job)
    // Queued mail that nothing drains is the failure this file exists to stop.
    expect(scheduled).toContain('mail.outbox')
    expect(scheduled).toContain('mail.sync')
    expect(scheduled).toContain('notifications.email')
    expect(scheduled).toContain('audit.seal')
  })

  it('schedules mail more often than housekeeping', () => {
    const of = (job: string) => SCHEDULE.find((s) => s.job === job)!.everyMs
    expect(of('mail.outbox')).toBeLessThan(of('helpdesk.sla'))
    expect(of('helpdesk.sla')).toBeLessThan(of('data.retention'))
  })
})

describe('the calendar checks', () => {
  const dueFor = (job: string) => SCHEDULE.find((s) => s.job === job)!.due!

  it('seals the audit log once a day, in the small hours', () => {
    const due = dueFor('audit.seal')
    expect(due(new Date('2026-09-10T01:30:00'))).toBe(true)
    expect(due(new Date('2026-09-10T13:30:00'))).toBe(false)
  })

  it('accrues leave on the last day of the month and no other', () => {
    const due = dueFor('leave.accrual')
    expect(due(new Date('2026-09-30T03:10:00'))).toBe(true)
    expect(due(new Date('2026-09-29T03:10:00'))).toBe(false)
    expect(due(new Date('2026-02-28T03:10:00'))).toBe(true)   // short month
    expect(due(new Date('2026-09-30T14:00:00'))).toBe(false)  // wrong hour
  })
})

describe('the loop', () => {
  it('skips a tick while the previous run is still going', async () => {
    vi.useFakeTimers()
    let started = 0
    const release: { fn: (() => void) | null } = { fn: null }

    const slow = async (): Promise<never> => {
      started++
      await new Promise<void>((resolve) => { release.fn = resolve })
      return undefined as never
    }
    const original = JOBS['helpdesk.sla']
    ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = slow

    const stop = startScheduler([{ job: 'helpdesk.sla', everyMs: 1000 }])
    try {
      await vi.advanceTimersByTimeAsync(9_000)   // first staggered run
      expect(started).toBe(1)

      await vi.advanceTimersByTimeAsync(5_000)   // five more ticks, all skipped
      expect(started).toBe(1)

      release.fn?.()
      await vi.advanceTimersByTimeAsync(1_500)   // free again: one more run
      expect(started).toBe(2)
    } finally {
      stop()
      ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = original
      vi.useRealTimers()
    }
  })

  it('keeps running after a job throws', async () => {
    vi.useFakeTimers()
    let calls = 0
    const failing = async (): Promise<never> => {
      calls++
      throw new Error('the database went away')
    }
    const original = JOBS['helpdesk.sla']
    ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = failing

    const stop = startScheduler([{ job: 'helpdesk.sla', everyMs: 1000 }])
    try {
      await vi.advanceTimersByTimeAsync(9_000)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(calls).toBeGreaterThan(1)
    } finally {
      stop()
      ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = original
      vi.useRealTimers()
    }
  })

  it('stops when it is told to', async () => {
    vi.useFakeTimers()
    let calls = 0
    const original = JOBS['helpdesk.sla']
    ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = async () => {
      calls++
      return undefined as never
    }

    const stop = startScheduler([{ job: 'helpdesk.sla', everyMs: 1000 }])
    await vi.advanceTimersByTimeAsync(9_000)
    const afterStart = calls
    stop()
    await vi.advanceTimersByTimeAsync(10_000)

    expect(calls).toBe(afterStart)
    ;(JOBS as Record<string, unknown>)['helpdesk.sla'] = original
    vi.useRealTimers()
  })
})
