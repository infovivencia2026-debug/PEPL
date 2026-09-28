/**
 * The audit chain under concurrent writers.
 *
 * This is the test that was missing. Every existing audit test emits from one
 * transaction at a time, so the chain always looked intact — while in a real
 * database three consecutive rows shared one prev_hash and one row pointed at a
 * predecessor with a higher id.
 *
 * A forked chain is worse than no chain: `verifyChain` reports tampering when
 * nobody tampered, and a control that cries wolf gets dismissed when it finally
 * matters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { emit, verifyChain } from '../src/audit/index.ts'

let A: Tenant
let B: Tenant
const ACTOR = 'd0000000-0000-0000-0000-00000000000d'

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

afterAll(async () => {
  // Leave nothing broken behind: gate:launch walks every tenant's chain after
  // the suites run.
  await controlPool.query('TRUNCATE audit_events')
  await closePools()
  await controlPool.end()
})

/** One emit in its own transaction, on its own connection. */
const emitOne = (tenantId: string, entityId: string) =>
  withTenant(tenantId, (tx) => emit(tx, {
    action: 'leave.request.approved',
    entityType: 'leave_request',
    entityId,
    actorUserId: ACTOR,
  }))

describe('concurrent emits keep one unbroken chain', () => {
  it('twelve writers racing for the same company produce a single line', async () => {
    // Separate transactions on separate connections is the real shape: two HTTP
    // requests, or a request and a job, for the same company at the same
    // moment. Promise.all over ONE transaction would not reproduce it — a
    // single PoolClient runs one query at a time.
    const ids = Array.from({ length: 12 }, () => crypto.randomUUID())
    await Promise.all(ids.map((id) => emitOne(A.id, id)))

    const check = await withTenant(A.id, (tx) => verifyChain(tx))
    expect(check).toMatchObject({ ok: true })
    expect(check.checked).toBe(12)
  })

  it('no two rows claim the same predecessor', async () => {
    // The precise shape of the bug: a fork, where several rows name one parent.
    const { rows } = await controlPool.query<{ dupes: string }>(
      `SELECT count(*)::text AS dupes FROM (
         SELECT prev_hash FROM audit_events
          WHERE tenant_id = $1 AND prev_hash IS NOT NULL
          GROUP BY prev_hash HAVING count(*) > 1) x`,
      [A.id])
    expect(Number(rows[0]!.dupes)).toBe(0)
  })

  it('every row follows one with a lower id', async () => {
    // The other shape it took: a row whose predecessor was written after it.
    const { rows } = await controlPool.query<{ broken: string }>(
      `SELECT count(*)::text AS broken FROM (
         SELECT prev_hash, lag(row_hash) OVER (PARTITION BY tenant_id ORDER BY id) AS lag_hash
           FROM audit_events WHERE tenant_id = $1) x
        WHERE prev_hash IS DISTINCT FROM lag_hash`,
      [A.id])
    expect(Number(rows[0]!.broken)).toBe(0)
  })

  it('two companies writing at once do not wait on each other or mix', async () => {
    // The lock is per tenant, so this is both a correctness check and the
    // reason the fix is acceptable: one company's audit traffic must never
    // queue behind another's.
    await Promise.all([
      ...Array.from({ length: 6 }, () => emitOne(A.id, crypto.randomUUID())),
      ...Array.from({ length: 6 }, () => emitOne(B.id, crypto.randomUUID())),
    ])
    expect(await withTenant(A.id, (tx) => verifyChain(tx))).toMatchObject({ ok: true })
    expect(await withTenant(B.id, (tx) => verifyChain(tx))).toMatchObject({ ok: true })
  })
})
