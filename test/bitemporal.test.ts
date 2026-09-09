import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  changeAssignment, correctAssignment,
  changeCompensation, correctCompensation,
  profileAt, HistoryError,
} from '../src/people/history.ts'

let A: Tenant
let B: Tenant

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeEach(async () => {
  // Reseed so each test starts from the single assignment the fixture creates.
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const L = (rupees: number): bigint => BigInt(rupees) * 100n

describe('a CHANGE progresses the timeline', () => {
  it('closes the prior row and opens a new one', async () => {
    await withTenant(A.id, async (tx) => {
      await changeAssignment(tx, {
        employeeId: A.employeeId,
        department: 'Engineering',
        designation: 'Lead Developer',
        effectiveFrom: '2026-10-01',
        reason: 'promotion',
      })
    })

    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT designation, effective_from::text AS f, effective_to::text AS t
           FROM employee_assignments WHERE superseded_at IS NULL ORDER BY effective_from`,
      )).rows,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ designation: 'Senior Developer', f: '2026-01-01', t: '2026-10-01' })
    expect(rows[1]).toMatchObject({ designation: 'Lead Developer', f: '2026-10-01', t: null })
  })

  it('answers what was true on a past date', async () => {
    await withTenant(A.id, async (tx) => {
      await changeAssignment(tx, {
        employeeId: A.employeeId,
        department: 'Engineering',
        designation: 'Lead Developer',
        effectiveFrom: '2026-10-01',
        reason: 'promotion',
      })
    })

    const sep = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-09-30'))
    const oct = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-10-01'))
    expect(sep?.designation).toBe('Senior Developer')
    expect(oct?.designation).toBe('Lead Developer')
  })

  it('refuses a change dated before the current row starts', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        changeAssignment(tx, {
          employeeId: A.employeeId,
          department: 'Engineering',
          designation: 'Backdated',
          effectiveFrom: '2025-12-01',
          reason: 'oops',
        }),
      ),
    ).rejects.toThrow(/must be dated after it, or use a correction/)
  })
})

describe('the exclusion constraint forbids overlapping beliefs', () => {
  it('rejects a second open assignment for the same employee', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(
          `INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from)
           VALUES ($1, $2, 'Sales', 'Rep', DATE '2026-06-01')`,
          [A.id, A.employeeId],
        ),
      ),
    ).rejects.toThrow(/assignment_no_overlap|conflicting key value/i)
  })

  it('allows a superseded row to overlap its replacement', async () => {
    const originalId = await withTenant(A.id, async (tx) =>
      (await tx.query<{ id: string }>(
        `SELECT id FROM employee_assignments WHERE superseded_at IS NULL LIMIT 1`)).rows[0]!.id,
    )
    await withTenant(A.id, async (tx) => {
      await correctAssignment(tx, originalId, { designation: 'Senior Engineer', reason: 'title was mis-keyed' })
    })
    const all = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT superseded_at FROM employee_assignments')).rows,
    )
    expect(all).toHaveLength(2)
    expect(all.filter((r) => r.superseded_at === null)).toHaveLength(1)
  })
})

describe('a CORRECTION rewrites belief, not the timeline', () => {
  it('keeps the same effective_from and supersedes the original', async () => {
    const originalId = await withTenant(A.id, async (tx) =>
      (await tx.query<{ id: string }>(
        `SELECT id FROM employee_assignments WHERE superseded_at IS NULL LIMIT 1`)).rows[0]!.id,
    )

    await withTenant(A.id, async (tx) => {
      await correctAssignment(tx, originalId, {
        designation: 'Senior Engineer',
        reason: 'designation was mis-keyed at onboarding',
      })
    })

    const believed = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-06-01'))
    expect(believed?.designation).toBe('Senior Engineer')

    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query(
        `SELECT designation, effective_from::text AS f, superseded_at IS NOT NULL AS gone
           FROM employee_assignments ORDER BY recorded_at`)).rows,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ designation: 'Senior Developer', f: '2026-01-01', gone: true })
    expect(rows[1]).toMatchObject({ designation: 'Senior Engineer', f: '2026-01-01', gone: false })
  })

  it('requires a reason', async () => {
    const id = await withTenant(A.id, async (tx) =>
      (await tx.query<{ id: string }>(
        `SELECT id FROM employee_assignments WHERE superseded_at IS NULL LIMIT 1`)).rows[0]!.id,
    )
    const err = await withTenant(A.id, async (tx) =>
      correctAssignment(tx, id, { designation: 'X', reason: '  ' }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(HistoryError)
    expect((err as HistoryError).code).toBe('CORRECTION_REASON_REQUIRED')
  })
})

describe('transaction time: what did we believe, and when', () => {
  it('reproduces the salary a payroll run would have seen at lock time', async () => {
    // 1. Compensation recorded, effective from joining.
    const originalId = await withTenant(A.id, async (tx) =>
      changeCompensation(tx, {
        employeeId: A.employeeId,
        annualCtcPaise: L(1_000_000),
        effectiveFrom: '2026-01-01',
        reason: 'offer',
      }),
    )

    // 2. Payroll for August locks. Whatever we believed at this instant is what it paid.
    const lockedAt = new Date()
    await new Promise((r) => setTimeout(r, 20))

    // 3. Afterwards we discover the CTC was keyed wrong and correct it.
    await withTenant(A.id, async (tx) => {
      await correctCompensation(tx, originalId, {
        annualCtcPaise: L(1_200_000),
        reason: 'CTC mis-keyed from the offer letter',
      })
    })

    const nowBelief = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-08-31'))
    const atLock = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-08-31', lockedAt))

    expect(nowBelief?.annual_ctc_paise).toBe(String(L(1_200_000)))
    // The run is reproducible: it saw the old figure, and still does.
    expect(atLock?.annual_ctc_paise).toBe(String(L(1_000_000)))
  })

  it('a later revision does not change what an earlier period was paid', async () => {
    await withTenant(A.id, async (tx) => {
      await changeCompensation(tx, {
        employeeId: A.employeeId, annualCtcPaise: L(1_000_000),
        effectiveFrom: '2026-01-01', reason: 'offer',
      })
      await changeCompensation(tx, {
        employeeId: A.employeeId, annualCtcPaise: L(1_400_000),
        effectiveFrom: '2026-11-01', reason: 'annual revision',
      })
    })

    const oct = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-10-31'))
    const nov = await withTenant(A.id, (tx) => profileAt(tx, A.employeeId, '2026-11-01'))
    expect(oct?.annual_ctc_paise).toBe(String(L(1_000_000)))
    expect(nov?.annual_ctc_paise).toBe(String(L(1_400_000)))
  })
})

describe('the current profile view', () => {
  it('resolves today without the caller writing a four-predicate join', async () => {
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT * FROM current_employee_profile')).rows,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].designation).toBe('Senior Developer')
    expect(rows[0].employee_number).toBe(A.employeeNumber)
  })

  it('is RLS-scoped (security_invoker), not owner-scoped', async () => {
    const rows = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT employee_number FROM current_employee_profile')).rows,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].employee_number).toBe(B.employeeNumber)
  })
})

describe('history stays isolated and immutable', () => {
  it('another tenant cannot see compensation history', async () => {
    await withTenant(A.id, async (tx) => {
      await changeCompensation(tx, {
        employeeId: A.employeeId, annualCtcPaise: L(1_000_000),
        effectiveFrom: '2026-01-01', reason: 'offer',
      })
    })
    const rows = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT * FROM compensation_records')).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('the app role cannot delete compensation history', async () => {
    await withTenant(A.id, async (tx) => {
      await changeCompensation(tx, {
        employeeId: A.employeeId, annualCtcPaise: L(1_000_000),
        effectiveFrom: '2026-01-01', reason: 'offer',
      })
    })
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM compensation_records')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('profileAt for another tenant employee returns nothing', async () => {
    const p = await withTenant(A.id, (tx) => profileAt(tx, B.employeeId, '2026-06-01'))
    expect(p).toBeUndefined()
  })
})
