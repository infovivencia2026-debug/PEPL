/**
 * Concurrent decisions on one approval: exactly one transition wins.
 *
 * act() read the request with a plain SELECT and wrote later, with no lock between. Two callers that
 * read "pending" at the same moment both proceeded: two approvals each wrote a history row (and a
 * notification), and an approve racing a withdraw/reject left the request in whichever state wrote last
 * with the other decision still recorded as if it had happened.
 *
 * Deterministic: the first transaction is held OPEN after it has acted, so the second starts while the
 * first's change is uncommitted -- the exact window the race lives in. With the row locked, the second
 * blocks until the first commits and then sees a closed request.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { act, raise } from '../src/approvals/index.ts'

let A: Tenant
const EMP = '10000000-0000-0000-0000-000000000001'
const MGR = '20000000-0000-0000-0000-000000000002'
const MGR2 = '20000000-0000-0000-0000-000000000003'

beforeAll(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

const newRequest = () => withTenant(A.id, (tx) => raise(tx, {
  entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: EMP, chainCode: 'manager',
  title: 'Leave', approvers: { manager: MGR },
}))
const state = (id: string) => withTenant(A.id, async (tx) => ({
  status: (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [id])).rows[0]!.status,
  decisions: (await tx.query<{ action: string }>(`SELECT action FROM approval_actions WHERE approval_request_id = $1 AND action <> 'comment' ORDER BY id`, [id])).rows.map((r) => r.action),
}))

/** Run `first`, keep its transaction open for `holdMs`, and start `second` while it is open. */
async function race<T, U>(
  first: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<T>,
  second: (tx: Parameters<Parameters<typeof withTenant>[1]>[0]) => Promise<U>,
  holdMs = 400,
): Promise<{ a: T; b: U | Error }> {
  let acted!: () => void
  const firstActed = new Promise<void>((r) => { acted = r })
  const a = withTenant(A.id, async (tx) => {
    const out = await first(tx)
    acted()
    await new Promise((r) => setTimeout(r, holdMs))   // still uncommitted
    return out
  })
  await firstActed
  const b = withTenant(A.id, second).catch((e: Error) => e)
  return { a: await a, b: await b }
}

describe('one decision wins', () => {
  it('two approvals: one is recorded, the other is a no-op', async () => {
    const id = await newRequest()
    const { a, b } = await race(
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
    )
    expect(a.changed).toBe(true)
    expect(b).not.toBeInstanceOf(Error)
    expect((b as { changed: boolean }).changed).toBe(false)
    const s = await state(id)
    expect(s.status).toBe('approved')
    expect(s.decisions).toEqual(['approve'])                 // one history row, not two
  })

  it('approve racing a withdraw: the request ends approved and the withdraw does nothing', async () => {
    const id = await newRequest()
    const { a, b } = await race(
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
      (tx) => act(tx, { requestId: id, actorUserId: EMP, action: 'withdraw' }),
    )
    expect(a.status).toBe('approved')
    expect((b as { changed: boolean }).changed).toBe(false)
    const s = await state(id)
    expect(s.status).toBe('approved')
    expect(s.decisions).toEqual(['approve'])                 // no phantom 'withdraw' in the history
  })

  it('withdraw racing an approve: the request ends withdrawn and the approval does nothing', async () => {
    const id = await newRequest()
    const { a, b } = await race(
      (tx) => act(tx, { requestId: id, actorUserId: EMP, action: 'withdraw' }),
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
    )
    expect(a.status).toBe('withdrawn')
    expect((b as { changed: boolean }).changed).toBe(false)
    const s = await state(id)
    expect(s.status).toBe('withdrawn')
    expect(s.decisions).toEqual(['withdraw'])
  })

  it('approve racing a reject: exactly one of them is final', async () => {
    const id = await newRequest()
    await race(
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'reject' }),
    )
    const s = await state(id)
    expect(s.status).toBe('approved')
    expect(s.decisions).toEqual(['approve'])
  })

  it('a request that is not contended still works end to end', async () => {
    const id = await newRequest()
    expect((await withTenant(A.id, (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }))).status).toBe('approved')
    expect((await state(id)).decisions).toEqual(['approve'])
  })

  it('a multi-step request is not advanced twice by a double click', async () => {
    const id = await withTenant(A.id, (tx) => raise(tx, {
      entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: EMP, chainCode: 'manager_then_hr',
      title: 'Leave', approvers: { manager: MGR, hr: MGR2 },
    }))
    await race(
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
      (tx) => act(tx, { requestId: id, actorUserId: MGR, action: 'approve' }),
    )
    const s = await state(id)
    expect(s.status).toBe('pending')                         // still waiting for HR
    expect(s.decisions).toEqual(['approve'])                 // the manager approved once
  })
})
