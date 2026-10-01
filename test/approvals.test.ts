import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { act, inbox, raise, ApprovalError } from '../src/approvals/index.ts'

let A: Tenant
let B: Tenant

const EMPLOYEE = '10000000-0000-0000-0000-000000000001'
const MANAGER = '20000000-0000-0000-0000-000000000002'
const HR = '30000000-0000-0000-0000-000000000003'
const FINANCE = '40000000-0000-0000-0000-000000000004'

const leaveRequest = (overrides: Partial<Parameters<typeof raise>[1]> = {}) => ({
  entityType: 'leave',
  entityId: crypto.randomUUID(),
  requestedByUserId: EMPLOYEE,
  chainCode: 'manager_then_hr' as const,
  title: 'Earned leave, 3 days',
  approvers: { manager: MANAGER, hr: HR },
  ...overrides,
})

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
  await closePools()
  await controlPool.end()
})

const status = (t: Tenant, id: string) =>
  withTenant(t.id, async (tx) =>
    (await tx.query('SELECT status, current_step FROM approval_requests WHERE id = $1', [id])).rows[0],
  )

describe('a chain advances step by step', () => {
  it('reaches approved only after every step approves', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    expect(await status(A, id)).toMatchObject({ status: 'pending', current_step: 1 })

    const afterManager = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }),
    )
    expect(afterManager).toMatchObject({ status: 'pending', currentStep: 2 })

    const afterHr = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: HR, action: 'approve' }),
    )
    expect(afterHr.status).toBe('approved')
  })

  it('a single-step chain closes on one approval', async () => {
    const id = await withTenant(A.id, (tx) =>
      raise(tx, leaveRequest({ chainCode: 'manager', approvers: { manager: MANAGER } })),
    )
    const r = await withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }))
    expect(r.status).toBe('approved')
  })

  it('rejection at any step closes the whole request', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    const r = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'reject', comment: 'team is short-staffed' }),
    )
    expect(r.status).toBe('rejected')
    expect((await status(A, id)).status).toBe('rejected')
  })
})

describe('the actions people actually use', () => {
  it('send back returns it to the requester WITHOUT rejecting', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    const r = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'send_back', comment: 'pick different dates' }),
    )
    expect(r.status).toBe('sent_back')

    // Still actionable — it was not closed.
    const resumed = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }),
    )
    expect(resumed.status).toBe('pending')
    expect(resumed.currentStep).toBe(2)
  })

  it('a comment does not decide anything', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    const r = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: HR, action: 'comment', comment: 'checking the balance' }),
    )
    expect(r).toMatchObject({ status: 'pending', changed: false })
    expect((await status(A, id)).current_step).toBe(1)
  })

  // Delegation used to take ANY string from `comment` as the new approver: no check that it was a
  // user, in this company, active, or not the person who asked -- so a requester could hand their
  // own leave to themselves, or to a nonexistent id that orphaned the request.
  const makeUser = (id: string, status = 'active', tenant = A) => withTenant(tenant.id, (tx) => tx.query(
    `INSERT INTO app_users (tenant_id, id, email, full_name, status) VALUES ($1,$2,$3,'x',$4)`,
    [tenant.id, id, `${id}@appr.test`, status]))
  const delegateTo = async (target: string) => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    return withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MANAGER, action: 'delegate', comment: target }))
  }

  it('refuses a delegate target that is not a user of this company', async () => {
    await makeUser(HR, 'active', B)                                   // exists, but in ANOTHER company
    for (const target of ['not-a-uuid', crypto.randomUUID(), HR]) {
      await expect(delegateTo(target), target).rejects.toMatchObject({ code: 'DELEGATE_TARGET_INVALID' })
    }
  })

  it('refuses an inactive user, and the person who asked', async () => {
    const gone = crypto.randomUUID()
    await makeUser(gone, 'disabled')
    await expect(delegateTo(gone)).rejects.toMatchObject({ code: 'DELEGATE_TARGET_INVALID' })
    await makeUser(EMPLOYEE)
    await expect(delegateTo(EMPLOYEE)).rejects.toMatchObject({ code: 'DELEGATE_TO_REQUESTER' })
  })

  it('delegation moves the step to someone else', async () => {
    await makeUser(HR)
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'delegate', comment: HR }),
    )
    const queue = await withTenant(A.id, (tx) => inbox(tx, HR))
    expect(queue).toHaveLength(1)
  })

  it('the requester can withdraw, and nobody else can', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    await expect(
      withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MANAGER, action: 'withdraw' })),
    ).rejects.toThrow(/only the requester/)

    const r = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: EMPLOYEE, action: 'withdraw' }),
    )
    expect(r.status).toBe('withdrawn')
  })
})

describe('safety properties', () => {
  it('approving twice is a no-op, not a double decision', async () => {
    const id = await withTenant(A.id, (tx) =>
      raise(tx, leaveRequest({ chainCode: 'manager', approvers: { manager: MANAGER } })),
    )
    await withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }))
    const again = await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }),
    )
    expect(again).toMatchObject({ status: 'approved', changed: false })

    const decisions = await withTenant(A.id, async (tx) =>
      (await tx.query(`SELECT count(*)::int AS n FROM approval_actions WHERE action = 'approve'`)).rows[0].n,
    )
    expect(decisions).toBe(1)
  })

  it('someone else cannot act on a step assigned to a named approver', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    const err = await withTenant(A.id, async (tx) =>
      act(tx, { requestId: id, actorUserId: FINANCE, action: 'approve' }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(ApprovalError)
    expect((err as ApprovalError).code).toBe('NOT_APPROVER')
  })

  it('a step whose approver IS the requester is skipped, not deadlocked', async () => {
    // A manager applying for their own leave: step 1 resolves to themselves.
    const id = await withTenant(A.id, (tx) =>
      raise(tx, leaveRequest({ requestedByUserId: MANAGER, approvers: { manager: MANAGER, hr: HR } })),
    )
    expect((await status(A, id)).current_step).toBe(2)

    const r = await withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: HR, action: 'approve' }))
    expect(r.status).toBe('approved')
  })

  it('a chain with no resolvable approver auto-approves rather than sticking', async () => {
    const id = await withTenant(A.id, (tx) =>
      raise(tx, leaveRequest({ chainCode: 'manager', approvers: {} })),
    )
    expect((await status(A, id)).status).toBe('approved')
  })

  it('the decision trail cannot be rewritten', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    await withTenant(A.id, (tx) =>
      act(tx, { requestId: id, actorUserId: MANAGER, action: 'reject', comment: 'no' }),
    )
    await expect(
      withTenant(A.id, async (tx) => tx.query(`UPDATE approval_actions SET comment = 'yes'`)),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM approval_actions')),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('the universal inbox', () => {
  it('returns one queue across every entity type', async () => {
    await withTenant(A.id, async (tx) => {
      await raise(tx, leaveRequest())
      await raise(tx, leaveRequest({
        entityType: 'attendance_correction', title: 'Regularize 14 Sep',
      }))
      await raise(tx, leaveRequest({
        entityType: 'compensation', title: 'Revision for EMP-00482',
        chainCode: 'manager_hr_finance', approvers: { manager: MANAGER, hr: HR, finance: FINANCE },
      }))
    })

    const managerQueue = await withTenant(A.id, (tx) => inbox(tx, MANAGER))
    expect(managerQueue).toHaveLength(3)
    expect(new Set(managerQueue.map((i) => i.entity_type)))
      .toEqual(new Set(['leave', 'attendance_correction', 'compensation']))

    // HR sees nothing yet — their step has not been reached.
    expect(await withTenant(A.id, (tx) => inbox(tx, HR))).toHaveLength(0)
  })

  it('an item leaves the queue once acted on and appears in the next approver queue', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    await withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MANAGER, action: 'approve' }))

    expect(await withTenant(A.id, (tx) => inbox(tx, MANAGER))).toHaveLength(0)
    expect(await withTenant(A.id, (tx) => inbox(tx, HR))).toHaveLength(1)
  })

  it('one company queue never shows another company items', async () => {
    await withTenant(A.id, (tx) => raise(tx, leaveRequest()))
    await withTenant(B.id, (tx) => raise(tx, leaveRequest()))

    // Same approver user id in both tenants: only the caller's tenant is visible.
    expect(await withTenant(A.id, (tx) => inbox(tx, MANAGER))).toHaveLength(1)
    expect(await withTenant(B.id, (tx) => inbox(tx, MANAGER))).toHaveLength(1)

    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT * FROM approval_requests')).rows,
    )
    expect(rows).toHaveLength(1)
  })
})
