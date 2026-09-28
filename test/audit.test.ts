import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { activity, emit, maskPayload, myRecordAccess, verifyChain, AuditError } from '../src/audit/index.ts'

let A: Tenant
let B: Tenant

const HR = '12000000-0000-0000-0000-000000000012'
const MANAGER = '13000000-0000-0000-0000-000000000013'

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  // The tamper tests deliberately edit and delete rows behind the app role to
  // prove the chain notices. That leaves a genuinely broken chain behind, and
  // `gate:launch` checks chain integrity across every tenant AFTER the suites
  // run — so whether verify passes came down to which file happened to reset
  // the fixtures last. A suite repairs what it breaks.
  await controlPool.query('TRUNCATE audit_events')
  await closePools()
  await controlPool.end()
})

describe('the action registry is closed', () => {
  it('rejects an action nobody declared', async () => {
    const err = await withTenant(A.id, async (tx) =>
      emit(tx, { action: 'people.employee.frobnicated', entityType: 'employee' }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(AuditError)
    expect((err as AuditError).code).toBe('UNKNOWN_ACTION')
  })

  it('enforces a reason where the action demands one', async () => {
    const err = await withTenant(A.id, async (tx) =>
      emit(tx, {
        action: 'payroll.run.revised', entityType: 'payroll_run', entityId: crypto.randomUUID(),
      }).catch((e: unknown) => e),
    )
    expect((err as AuditError).code).toBe('REASON_REQUIRED')
  })

  it('derives category and severity from the registry, not the caller', async () => {
    await withTenant(A.id, (tx) =>
      emit(tx, { action: 'payroll.run.locked', entityType: 'payroll_run', entityId: crypto.randomUUID() }),
    )
    const rows = await withTenant(A.id, (tx) => activity(tx))
    expect(rows[0]).toMatchObject({ category: 'payroll', severity: 'critical' })
  })
})

describe('masking', () => {
  it('records that a tier-3 field changed, not what it changed to', () => {
    const masked = maskPayload({ department: 'Engineering', annual_ctc_paise: 120000000 }, 'people.assignment.changed')
    expect(masked).toEqual({ department: 'Engineering', annual_ctc_paise: { changed: true } })
  })

  it('allows the value when the action IS the compensation change', () => {
    const masked = maskPayload({ annual_ctc_paise: 120000000 }, 'people.compensation.changed')
    expect(masked).toEqual({ annual_ctc_paise: 120000000 })
  })

  it('never records a secret, under any action', () => {
    const masked = maskPayload(
      { password_hash: 'x', secret_ciphertext: 'y', token: 'z', email: 'a@b.com' },
      'people.compensation.changed',
    )
    expect(masked).toEqual({ email: 'a@b.com' })
  })

  it('masks on the way in, so the stored row is already safe', async () => {
    await withTenant(A.id, (tx) =>
      emit(tx, {
        action: 'people.assignment.changed', entityType: 'employee', entityId: A.employeeId,
        before: { designation: 'Senior Developer', annual_ctc_paise: 100000000 },
        after: { designation: 'Lead Developer', annual_ctc_paise: 120000000 },
      }),
    )
    const row = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT before, after FROM audit_events')).rows[0],
    )
    expect(row.before.annual_ctc_paise).toEqual({ changed: true })
    expect(row.after.designation).toBe('Lead Developer')
  })
})

describe('the log is append-only and transactional', () => {
  it('cannot be updated or deleted by the app role', async () => {
    await withTenant(A.id, (tx) =>
      emit(tx, { action: 'leave.request.approved', entityType: 'leave_request', entityId: crypto.randomUUID() }),
    )
    await expect(
      withTenant(A.id, async (tx) => tx.query(`UPDATE audit_events SET action = 'rewritten'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM audit_events')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('a rolled-back change takes its audit row with it', async () => {
    await expect(
      withTenant(A.id, async (tx) => {
        await tx.query(
          `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
           VALUES ($1,'A-999','Ghost',DATE '2026-01-01')`, [A.id],
        )
        await emit(tx, { action: 'people.employee.created', entityType: 'employee' })
        throw new Error('rolled back')
      }),
    ).rejects.toThrow('rolled back')

    const counts = await withTenant(A.id, async (tx) => ({
      employees: (await tx.query(`SELECT 1 FROM employees WHERE employee_number = 'A-999'`)).rows.length,
      events: (await tx.query('SELECT 1 FROM audit_events')).rows.length,
    }))
    expect(counts).toEqual({ employees: 0, events: 0 })
  })

  it('refuses to emit without a tenant context', async () => {
    const { withoutTenantForTesting } = await import('../src/db/tenant-tx.ts')
    await expect(
      withoutTenantForTesting(async (tx) =>
        emit(tx, { action: 'leave.request.approved', entityType: 'leave_request' }),
      ),
    ).rejects.toThrow(/without a tenant context/)
  })
})

describe('tamper evidence', () => {
  it('an intact chain verifies', async () => {
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 5; i++) {
        await emit(tx, {
          action: 'leave.request.approved', entityType: 'leave_request',
          entityId: crypto.randomUUID(), actorUserId: HR,
        })
      }
    })
    const check = await withTenant(A.id, (tx) => verifyChain(tx))
    expect(check).toMatchObject({ ok: true, checked: 5 })
  })

  it('detects a row edited behind the application role', async () => {
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 4; i++) {
        await emit(tx, {
          action: 'leave.request.approved', entityType: 'leave_request',
          entityId: crypto.randomUUID(), actorUserId: HR,
        })
      }
    })
    // The app role cannot do this; the superuser can, and so could a compromised
    // operator. The chain is what makes it detectable rather than deniable.
    await controlPool.query(
      `UPDATE audit_events SET action = 'leave.request.rejected'
        WHERE id = (SELECT min(id) + 1 FROM audit_events)`,
    )
    const check = await withTenant(A.id, (tx) => verifyChain(tx))
    expect(check.ok).toBe(false)
    expect(check.brokenAtId).toBeDefined()
  })

  it('detects a deleted row', async () => {
    await withTenant(A.id, async (tx) => {
      for (let i = 0; i < 4; i++) {
        await emit(tx, {
          action: 'leave.request.approved', entityType: 'leave_request',
          entityId: crypto.randomUUID(), actorUserId: HR,
        })
      }
    })
    await controlPool.query(
      `DELETE FROM audit_events WHERE id = (SELECT min(id) + 1 FROM audit_events)`,
    )
    const check = await withTenant(A.id, (tx) => verifyChain(tx))
    expect(check.ok).toBe(false)
  })
})

describe('what the log answers', () => {
  it('filters by category, actor and severity', async () => {
    await withTenant(A.id, async (tx) => {
      await emit(tx, { action: 'payroll.run.locked', entityType: 'payroll_run', actorUserId: HR })
      await emit(tx, { action: 'leave.request.approved', entityType: 'leave_request', actorUserId: MANAGER })
      await emit(tx, { action: 'security.login.failed', entityType: 'session' })
    })
    expect(await withTenant(A.id, (tx) => activity(tx, { category: 'payroll' }))).toHaveLength(1)
    expect(await withTenant(A.id, (tx) => activity(tx, { actorUserId: MANAGER }))).toHaveLength(1)
    expect(await withTenant(A.id, (tx) => activity(tx, { severity: 'critical' }))).toHaveLength(1)
  })

  it('an employee can see who accessed their own salary', async () => {
    await withTenant(A.id, async (tx) => {
      await emit(tx, {
        action: 'access.tier3.revealed', entityType: 'employee', entityId: A.employeeId,
        subjectEmployeeId: A.employeeId, actorUserId: MANAGER, actorLabel: 'Arjun (Manager)',
        metadata: { field: 'annual_ctc_paise' },
      })
    })
    const mine = await withTenant(A.id, (tx) => myRecordAccess(tx, A.employeeId))
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ actor_label: 'Arjun (Manager)', action: 'access.tier3.revealed' })
    expect((mine[0] as { metadata: Record<string, unknown> }).metadata.field).toBe('annual_ctc_paise')
  })

  it('actor_label survives even if the user record is later removed', async () => {
    await withTenant(A.id, (tx) =>
      emit(tx, {
        action: 'payroll.run.locked', entityType: 'payroll_run',
        actorUserId: HR, actorLabel: 'Priya Sharma (Payroll Admin)',
      }),
    )
    const rows = await withTenant(A.id, (tx) => activity(tx))
    expect(rows[0]!.actor_label).toBe('Priya Sharma (Payroll Admin)')
  })

  it('one company log is invisible to another', async () => {
    await withTenant(A.id, (tx) =>
      emit(tx, { action: 'payroll.run.locked', entityType: 'payroll_run', actorUserId: HR }),
    )
    expect(await withTenant(B.id, (tx) => activity(tx))).toHaveLength(0)
  })
})
