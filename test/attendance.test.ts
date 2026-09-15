import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  applyBulkCorrection, applyCorrection, recomputeDay, recordPunch,
  setPeriodStatus, AttendanceError,
} from '../src/attendance/index.ts'

let A: Tenant
let B: Tenant
let sepPeriod: string
let octPeriod: string

const SEP_DAY = '2026-09-14'
const OCT_DAY = '2026-10-14'

async function seedPeriods(tenantId: string): Promise<{ sep: string; oct: string }> {
  return withTenant(tenantId, async (tx) => {
    const mk = async (start: string, end: string): Promise<string> => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO attendance_periods (tenant_id, period_start, period_end)
         VALUES ($1, $2, $3) RETURNING id`,
        [tenantId, start, end],
      )
      return rows[0]!.id
    }
    return { sep: await mk('2026-09-01', '2026-09-30'), oct: await mk('2026-10-01', '2026-10-31') }
  })
}

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  const p = await seedPeriods(A.id)
  sepPeriod = p.sep
  octPeriod = p.oct
})

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const day = (t: Tenant, d: string) =>
  withTenant(t.id, async (tx) =>
    (await tx.query(
      `SELECT status, day_fraction::float8 AS frac, is_remote, is_field_duty,
              is_regularized, worked_minutes, marked_reason
         FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`,
      [t.employeeId, d],
    )).rows[0],
  )

describe('punch capture', () => {
  it('derives a present day with worked minutes', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'mobile',
      })
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T18:30:00Z`, localDate: SEP_DAY,
        direction: 'out', source: 'mobile',
      })
      await recomputeDay(tx, A.employeeId, SEP_DAY)
    })
    const d = await day(A, SEP_DAY)
    expect(d.status).toBe('present')
    expect(d.worked_minutes).toBe(540)
    expect(d.frac).toBe(1)
  })

  it('is idempotent for a retried offline punch', async () => {
    const results: boolean[] = []
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 3; i++) {
        results.push(await recordPunch(tx, {
          employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
          direction: 'in', source: 'mobile', clientPunchId: 'offline-queue-1',
        }))
      }
    })
    expect(results).toEqual([true, false, false])
  })

  it('recompute is idempotent', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'web',
      })
      await recomputeDay(tx, A.employeeId, SEP_DAY)
      await recomputeDay(tx, A.employeeId, SEP_DAY)
      await recomputeDay(tx, A.employeeId, SEP_DAY)
    })
    const n = await withTenant(A.id, async (tx) =>
      Number((await tx.query('SELECT count(*)::int AS n FROM daily_attendance')).rows[0].n),
    )
    expect(n).toBe(1)
  })

  it('raw punches cannot be edited or deleted', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'mobile',
      })
    })
    await expect(
      withTenant(A.id, async (tx) => tx.query(`UPDATE attendance_punches SET direction = 'out'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM attendance_punches')),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('half day is explicit, and remote is an attribute not a status', () => {
  it('a manager-marked half day sets the fraction and records who and why', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'web',
      })
      await recomputeDay(tx, A.employeeId, SEP_DAY)
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_half_day',
        reason: 'left after lunch for a hospital visit',
      })
    })
    const d = await day(A, SEP_DAY)
    expect(d.frac).toBe(0.5)
    expect(d.status).toBe('present')
    expect(d.marked_reason).toMatch(/hospital/)
    expect(d.is_regularized).toBe(true)
  })

  it('a day can be BOTH remote and half-day', async () => {
    await withTenant(A.id, async (tx) => {
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_remote', reason: 'wfh approved',
      })
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_half_day', reason: 'half day',
      })
    })
    const d = await day(A, SEP_DAY)
    expect(d.is_remote).toBe(true)
    expect(d.frac).toBe(0.5)
    expect(d.status).toBe('present')
  })

  it('a half-day leave marks the day as half, not whole', async () => {
    // Payroll reads day_fraction, so a half-day leave that recorded 1.00 would
    // silently pay a full day. This path arrived with the UI work untested.
    await withTenant(A.id, async (tx) => {
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_leave',
        after: { dayFraction: 0.5 }, reason: 'half day of casual leave',
      })
    })
    const d = await day(A, SEP_DAY)
    expect(d.status).toBe('on_leave')
    expect(d.frac).toBe(0.5)
  })

  it('a full-day leave stays a whole day', async () => {
    await withTenant(A.id, async (tx) => {
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_leave',
        reason: 'full day of casual leave',
      })
    })
    const d = await day(A, SEP_DAY)
    expect(d.status).toBe('on_leave')
    expect(d.frac).toBe(1)
  })

  it('remote is always revocable', async () => {
    await withTenant(A.id, async (tx) => {
      await applyCorrection(tx, { employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_remote', reason: 'wfh' })
      await applyCorrection(tx, { employeeId: A.employeeId, workDate: SEP_DAY, action: 'revoke_remote', reason: 'marked in error' })
    })
    expect((await day(A, SEP_DAY)).is_remote).toBe(false)
  })
})

describe('the period state decides what an edit can do', () => {
  it('OPEN period: the correction applies immediately', async () => {
    const r = await withTenant(A.id, (tx) =>
      applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present',
        reason: 'biometric device was down',
      }),
    )
    expect(r).toMatchObject({ applied: true, periodStatus: 'open' })
    expect((await day(A, SEP_DAY)).status).toBe('present')
  })

  it('CLOSED period: refused unless the caller may reopen', async () => {
    await withTenant(A.id, (tx) => setPeriodStatus(tx, sepPeriod, 'closed'))

    const err = await withTenant(A.id, async (tx) =>
      applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present', reason: 'late fix',
      }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(AttendanceError)
    expect((err as AttendanceError).code).toBe('PERIOD_CLOSED')

    const ok = await withTenant(A.id, (tx) =>
      applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present',
        reason: 'late fix, period reopened by HR', allowClosedPeriod: true,
      }),
    )
    expect(ok.applied).toBe(true)
  })

  it('FROZEN period: the past is never rewritten; the effect carries forward', async () => {
    await withTenant(A.id, async (tx) => {
      await applyCorrection(tx, { employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present', reason: 'ok' })
      await setPeriodStatus(tx, sepPeriod, 'frozen')
    })
    const before = await day(A, SEP_DAY)

    const r = await withTenant(A.id, (tx) =>
      applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_absent',
        reason: 'discovered after payroll froze',
      }),
    )
    expect(r.applied).toBe(false)
    expect(r.periodStatus).toBe('frozen')
    expect(r.deferredToPeriodId).toBe(octPeriod)

    // The frozen day is untouched — the payroll run stays reproducible.
    expect((await day(A, SEP_DAY)).status).toBe(before.status)

    // But the correction is recorded, not lost.
    const deferred = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT action, reason, deferred_to_period_id FROM attendance_corrections
          WHERE deferred_to_period_id IS NOT NULL`)).rows,
    )
    expect(deferred).toHaveLength(1)
    expect(deferred[0].action).toBe('mark_absent')
  })

  it('a correction always needs a reason', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        applyCorrection(tx, {
          employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present', reason: '   ',
        }),
      ),
    ).rejects.toThrow(/must carry a reason/)
  })
})

describe('bulk correction', () => {
  it('marks a whole team present with one reason and one row each', async () => {
    const second = await withTenant(A.id, async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
         VALUES ($1, 'A-002', 'Priya', DATE '2026-01-01') RETURNING id`,
        [A.id],
      )
      return rows[0]!.id
    })

    const results = await withTenant(A.id, (tx) =>
      applyBulkCorrection(tx, [A.employeeId, second], {
        workDate: SEP_DAY, action: 'mark_present',
        reason: 'biometric device offline on the 14th',
      }),
    )
    expect(results.every((r) => r.applied)).toBe(true)

    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT employee_id FROM attendance_corrections WHERE work_date = $1`, [SEP_DAY])).rows,
    )
    expect(rows).toHaveLength(2)
  })
})

describe('the correction trail is immutable and isolated', () => {
  it('corrections cannot be updated or deleted', async () => {
    await withTenant(A.id, (tx) =>
      applyCorrection(tx, { employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_present', reason: 'x' }),
    )
    await expect(
      withTenant(A.id, async (tx) => tx.query(`UPDATE attendance_corrections SET reason = 'rewritten'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM attendance_corrections')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('a day can be replayed to show what it was before the correction', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'mobile',
      })
      await recomputeDay(tx, A.employeeId, SEP_DAY)
      await applyCorrection(tx, {
        employeeId: A.employeeId, workDate: SEP_DAY, action: 'mark_absent',
        reason: 'punched in then went home',
      })
    })
    const trail = await withTenant(A.id, async (tx) =>
      (await tx.query(`SELECT before, after, reason FROM attendance_corrections`)).rows[0],
    )
    expect(trail.before.status).toBe('present')
    expect(trail.reason).toMatch(/went home/)
    expect((await day(A, SEP_DAY)).status).toBe('absent')
  })

  it('another tenant sees no attendance data', async () => {
    await withTenant(A.id, async (tx) => {
      await recordPunch(tx, {
        employeeId: A.employeeId, punchedAt: `${SEP_DAY}T09:30:00Z`, localDate: SEP_DAY,
        direction: 'in', source: 'mobile',
      })
      await recomputeDay(tx, A.employeeId, SEP_DAY)
    })
    const rows = await withTenant(B.id, async (tx) => ({
      punches: (await tx.query('SELECT * FROM attendance_punches')).rows.length,
      days: (await tx.query('SELECT * FROM daily_attendance')).rows.length,
      periods: (await tx.query('SELECT * FROM attendance_periods')).rows.length,
    }))
    expect(rows).toEqual({ punches: 0, days: 0, periods: 0 })
  })
})
