import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  accrueMonthly, appendEntry, balance, consume, creditCompOff,
  reverse, rollover, LeaveError,
} from '../src/leave/ledger.ts'

let A: Tenant
let B: Tenant
let elA: string
let elB: string

const CYCLE = 2026

async function seedLeaveType(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO leave_types (tenant_id, code, name) VALUES ($1, 'EL', 'Earned Leave')
       RETURNING id`,
      [tenantId],
    )
    return rows[0]!.id
  })
}

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  elA = await seedLeaveType(A.id)
  elB = await seedLeaveType(B.id)
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

const bal = (t: Tenant, type: string, cycle = CYCLE) =>
  withTenant(t.id, (tx) => balance(tx, t.employeeId, type, cycle))

describe('balance is derived from entries', () => {
  it('starts at zero with no entries', async () => {
    const b = await bal(A, elA)
    expect(b.available).toBe(0)
  })

  it('sums opening, accrual and consumption', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 5, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
      for (const m of ['01', '02', '03']) {
        await accrueMonthly(tx, {
          employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
          period: `2026-${m}`, units: 1.5, effectiveDate: `2026-${m}-28`,
        })
      }
      await consume(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
        days: 2, effectiveDate: '2026-03-10', requestId: crypto.randomUUID(),
      })
    })

    const b = await bal(A, elA)
    expect(b.opening).toBe(5)
    expect(b.accrued).toBe(4.5)
    expect(b.consumed).toBe(2)
    expect(b.available).toBe(7.5)
  })

  it('reports a balance as of a past date', async () => {
    await withTenant(A.id, async (tx) => {
      await accrueMonthly(tx, { employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE, period: '2026-01', units: 1.5, effectiveDate: '2026-01-31' })
      await accrueMonthly(tx, { employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE, period: '2026-02', units: 1.5, effectiveDate: '2026-02-28' })
    })
    const jan = await withTenant(A.id, (tx) => balance(tx, A.employeeId, elA, CYCLE, '2026-01-31'))
    const feb = await withTenant(A.id, (tx) => balance(tx, A.employeeId, elA, CYCLE, '2026-02-28'))
    expect(jan.available).toBe(1.5)
    expect(feb.available).toBe(3)
  })
})

describe('accrual is idempotent', () => {
  it('re-running the same period does not double-credit', async () => {
    const results: boolean[] = []
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 4; i++) {
        results.push(await accrueMonthly(tx, {
          employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
          period: '2026-04', units: 1.5, effectiveDate: '2026-04-30',
        }))
      }
    })
    expect(results).toEqual([true, false, false, false])
    expect((await bal(A, elA)).available).toBe(1.5)
  })

  it('different periods each credit once', async () => {
    await withTenant(A.id, async (tx) => {
      for (const m of ['04', '05', '06']) {
        await accrueMonthly(tx, {
          employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
          period: `2026-${m}`, units: 1.5, effectiveDate: `2026-${m}-28`,
        })
      }
    })
    expect((await bal(A, elA)).available).toBe(4.5)
  })
})

describe('consumption and cancellation', () => {
  it('refuses to exceed the balance by default', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 2, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
    })
    const err = await withTenant(A.id, async (tx) =>
      consume(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
        days: 3, effectiveDate: '2026-05-01', requestId: crypto.randomUUID(),
      }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(LeaveError)
    expect((err as LeaveError).code).toBe('INSUFFICIENT_BALANCE')
  })

  it('permits going negative when the policy allows it', async () => {
    await withTenant(A.id, async (tx) => {
      await consume(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
        days: 3, effectiveDate: '2026-05-01', requestId: crypto.randomUUID(),
        allowNegative: true,
      })
    })
    expect((await bal(A, elA)).available).toBe(-3)
  })

  it('cancelling writes a reversal and keeps the consumption', async () => {
    const requestId = crypto.randomUUID()
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 10, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
      await consume(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
        days: 3, effectiveDate: '2026-06-01', requestId,
      })
      await reverse(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE,
        days: 3, effectiveDate: '2026-06-02', requestId,
      })
    })

    expect((await bal(A, elA)).available).toBe(10)
    const kinds = await withTenant(A.id, async (tx) =>
      (await tx.query(`SELECT entry_type FROM leave_ledger ORDER BY id`)).rows.map((r) => r.entry_type),
    )
    expect(kinds).toEqual(['opening', 'consumption', 'reversal'])
  })

  it('the same request cannot be consumed twice', async () => {
    const requestId = crypto.randomUUID()
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 10, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
      await consume(tx, { employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE, days: 2, effectiveDate: '2026-06-01', requestId })
      await consume(tx, { employeeId: A.employeeId, leaveTypeId: elA, cycleYear: CYCLE, days: 2, effectiveDate: '2026-06-01', requestId })
    })
    expect((await bal(A, elA)).available).toBe(8)
  })
})

describe('the annual rollover is visible, not a silent reset', () => {
  it('carries forward up to the cap and lapses the rest, as entries', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 22, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
    })

    const result = await withTenant(A.id, (tx) =>
      rollover(tx, {
        employeeId: A.employeeId, leaveTypeId: elA,
        fromCycle: CYCLE, toCycle: CYCLE + 1, carryForwardLimit: 15,
        cycleEndDate: '2026-12-31', nextCycleStartDate: '2027-01-01',
      }),
    )
    expect(result).toEqual({ carriedForward: 15, lapsed: 7 })

    expect((await bal(A, elA, CYCLE)).available).toBe(0)
    expect((await bal(A, elA, CYCLE + 1)).available).toBe(15)

    const entries = await withTenant(A.id, async (tx) =>
      (await tx.query(`SELECT entry_type, delta_days::float8 AS d FROM leave_ledger ORDER BY id`)).rows,
    )
    // A transfer is double-entry: it leaves the closed cycle and enters the new one.
    expect(entries).toEqual([
      { entry_type: 'opening', d: 22 },
      { entry_type: 'lapse', d: -7 },
      { entry_type: 'carry_forward', d: -15 },
      { entry_type: 'carry_forward', d: 15 },
    ])
  })

  it('re-running the rollover changes nothing', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 22, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
    })
    const args = {
      employeeId: A.employeeId, leaveTypeId: elA,
      fromCycle: CYCLE, toCycle: CYCLE + 1, carryForwardLimit: 15,
      cycleEndDate: '2026-12-31', nextCycleStartDate: '2027-01-01',
    }
    await withTenant(A.id, (tx) => rollover(tx, args))
    await withTenant(A.id, (tx) => rollover(tx, args))

    expect((await bal(A, elA, CYCLE + 1)).available).toBe(15)
    const n = await withTenant(A.id, async (tx) =>
      Number((await tx.query('SELECT count(*)::int AS n FROM leave_ledger')).rows[0].n),
    )
    expect(n).toBe(4)
  })
})

describe('comp-off', () => {
  it('mints one credit per worked date, however many times it runs', async () => {
    const results: boolean[] = []
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 3; i++) {
        results.push(await creditCompOff(tx, {
          employeeId: A.employeeId, workDate: '2026-09-06', expiresOn: '2026-12-05',
        }))
      }
    })
    expect(results).toEqual([true, false, false])
  })
})

describe('the ledger is append-only and isolated', () => {
  it('cannot be updated or deleted by the app role', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 5, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
    })
    await expect(
      withTenant(A.id, async (tx) => tx.query('UPDATE leave_ledger SET delta_days = 999')),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM leave_ledger')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('one company ledger is invisible to another', async () => {
    await withTenant(A.id, async (tx) => {
      await appendEntry(tx, {
        employeeId: A.employeeId, leaveTypeId: elA, entryType: 'opening',
        deltaDays: 5, effectiveDate: '2026-01-01', cycleYear: CYCLE,
      })
    })
    const rows = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT * FROM leave_ledger')).rows,
    )
    expect(rows).toHaveLength(0)
    expect((await bal(B, elB)).available).toBe(0)
  })

  it('an idempotency key from one tenant does not block another', async () => {
    const shared = 'accrual:shared-key'
    const okA = await withTenant(A.id, (tx) => appendEntry(tx, {
      employeeId: A.employeeId, leaveTypeId: elA, entryType: 'accrual',
      deltaDays: 1, effectiveDate: '2026-01-31', cycleYear: CYCLE, idempotencyKey: shared,
    }))
    const okB = await withTenant(B.id, (tx) => appendEntry(tx, {
      employeeId: B.employeeId, leaveTypeId: elB, entryType: 'accrual',
      deltaDays: 1, effectiveDate: '2026-01-31', cycleYear: CYCLE, idempotencyKey: shared,
    }))
    expect(okA).toBe(true)
    expect(okB).toBe(true)
  })
})
