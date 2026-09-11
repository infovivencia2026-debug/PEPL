/**
 * Leave administration.
 *
 * The versioning rules are the point: a policy is never edited in place, a
 * change closes the version in force on the day before it starts, and a change
 * cannot be backdated — the ledger already wrote entries under the old rules.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  createLeaveType, listLeaveTypes, policyHistory, publishPolicy, reinstateLeaveType,
  retireLeaveType, updateLeaveType, LeavePolicyError,
} from '../src/leave/policy.ts'

let A: Tenant
let B: Tenant
const TODAY = '2026-09-11'

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const newType = (tenantId: string, code = 'PL', name = 'Paternity Leave') =>
  withTenant(tenantId, (tx) => createLeaveType(tx, { code, name }))

const publish = (tenantId: string, typeId: string, effectiveFrom: string, units = 1, extra = {}) =>
  withTenant(tenantId, (tx) =>
    publishPolicy(tx, typeId, {
      accrualMethod: 'monthly', accrualUnitsPerPeriod: units, effectiveFrom, ...extra,
    }, { today: TODAY }))

describe('leave types', () => {
  it('adds a type with an upper-cased, stable code', async () => {
    const type = await newType(A.id, 'pl')
    expect(type.code).toBe('PL')
    expect(type.is_paid).toBe(true)
    expect(type.status).toBe('active')
  })

  it('refuses a code that would not survive on a payslip', async () => {
    await expect(newType(A.id, '1st-leave')).rejects.toMatchObject({ code: 'INVALID_LEAVE_CODE' })
    await expect(newType(A.id, 'THIS_CODE_IS_TOO_LONG')).rejects.toMatchObject({ code: 'INVALID_LEAVE_CODE' })
  })

  it('refuses a duplicate code', async () => {
    await newType(A.id, 'PL')
    await expect(newType(A.id, 'PL')).rejects.toMatchObject({ code: 'LEAVE_TYPE_EXISTS' })
  })

  it('renames without touching the code', async () => {
    const type = await newType(A.id, 'PL')
    const renamed = await withTenant(A.id, (tx) => updateLeaveType(tx, type.id, { name: 'Parental Leave' }))
    expect(renamed.name).toBe('Parental Leave')
    expect(renamed.code).toBe('PL')
  })

  it('retires rather than deletes, and can reinstate', async () => {
    const type = await newType(A.id, 'PL')
    await withTenant(A.id, (tx) => retireLeaveType(tx, type.id))

    const active = await withTenant(A.id, (tx) => listLeaveTypes(tx))
    expect(active.find((t) => t.code === 'PL')).toBeUndefined()

    const all = await withTenant(A.id, (tx) => listLeaveTypes(tx, { includeRetired: true }))
    expect(all.find((t) => t.code === 'PL')!.status).toBe('retired')

    await withTenant(A.id, (tx) => reinstateLeaveType(tx, type.id))
    expect((await withTenant(A.id, (tx) => listLeaveTypes(tx))).find((t) => t.code === 'PL')).toBeDefined()
  })

  it('cannot retire something twice', async () => {
    const type = await newType(A.id, 'PL')
    await withTenant(A.id, (tx) => retireLeaveType(tx, type.id))
    await expect(withTenant(A.id, (tx) => retireLeaveType(tx, type.id)))
      .rejects.toBeInstanceOf(LeavePolicyError)
  })
})

describe('policy versions', () => {
  it('the first version is 1 and is in force from its date', async () => {
    const type = await newType(A.id)
    const v1 = await publish(A.id, type.id, '2026-10-01', 1.5)
    expect(v1.version).toBe(1)
    expect(v1.effective_to).toBeNull()

    const before = await withTenant(A.id, (tx) => listLeaveTypes(tx, { asOf: '2026-09-30' }))
    expect(before.find((t) => t.code === 'PL')!.policy).toBeNull()
    const after = await withTenant(A.id, (tx) => listLeaveTypes(tx, { asOf: '2026-10-01' }))
    expect(after.find((t) => t.code === 'PL')!.policy!.accrual_units_per_period).toBe(1.5)
  })

  it('a new version closes the old one on the day before', async () => {
    const type = await newType(A.id)
    await publish(A.id, type.id, '2026-10-01', 1.5)
    const v2 = await publish(A.id, type.id, '2027-04-01', 1.75)
    expect(v2.version).toBe(2)

    const history = await withTenant(A.id, (tx) => policyHistory(tx, type.id))
    expect(history.map((p) => [p.version, p.effective_from, p.effective_to])).toEqual([
      [2, '2027-04-01', null],
      [1, '2026-10-01', '2027-03-31'],
    ])
  })

  it('the version in force depends on the date asked about', async () => {
    const type = await newType(A.id)
    await publish(A.id, type.id, '2026-10-01', 1.5)
    await publish(A.id, type.id, '2027-04-01', 1.75)

    const inFY26 = await withTenant(A.id, (tx) => listLeaveTypes(tx, { asOf: '2026-12-15' }))
    const inFY27 = await withTenant(A.id, (tx) => listLeaveTypes(tx, { asOf: '2027-06-15' }))
    expect(inFY26.find((t) => t.code === 'PL')!.policy!.accrual_units_per_period).toBe(1.5)
    expect(inFY27.find((t) => t.code === 'PL')!.policy!.accrual_units_per_period).toBe(1.75)
  })

  it('cannot be backdated: the ledger already wrote entries under the old rules', async () => {
    const type = await newType(A.id)
    await expect(publish(A.id, type.id, '2026-01-01'))
      .rejects.toMatchObject({ code: 'POLICY_NOT_BACKDATABLE' })
  })

  it('may start today', async () => {
    const type = await newType(A.id)
    expect((await publish(A.id, type.id, TODAY)).effective_from).toBe(TODAY)
  })

  it('replaces a future version that had not yet started, rather than stacking it', async () => {
    const type = await newType(A.id)
    await publish(A.id, type.id, '2026-10-01', 1.5)
    await publish(A.id, type.id, '2027-04-01', 1.75)   // future
    await publish(A.id, type.id, '2027-01-01', 2.0)    // earlier future: supersedes the April one

    const history = await withTenant(A.id, (tx) => policyHistory(tx, type.id))
    expect(history.map((p) => [p.accrual_units_per_period, p.effective_from, p.effective_to])).toEqual([
      [2.0, '2027-01-01', null],
      [1.5, '2026-10-01', '2026-12-31'],
    ])
  })

  it('rejects a retired type', async () => {
    const type = await newType(A.id)
    await withTenant(A.id, (tx) => retireLeaveType(tx, type.id))
    await expect(publish(A.id, type.id, '2026-10-01'))
      .rejects.toMatchObject({ code: 'LEAVE_TYPE_RETIRED' })
  })

  it('validates the numbers and the method', async () => {
    const type = await newType(A.id)
    await expect(publish(A.id, type.id, '2026-10-01', -1))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(publish(A.id, type.id, '2026-10-01', 5, { accrualMethod: 'none' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    await expect(publish(A.id, type.id, '2026-10-01', 1, { minUnit: 'minute' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })
})

describe('isolation', () => {
  it('one company’s types and policies are invisible to another', async () => {
    const type = await newType(A.id, 'PL')
    await publish(A.id, type.id, '2026-10-01')

    const inB = await withTenant(B.id, (tx) => listLeaveTypes(tx, { includeRetired: true }))
    expect(inB.find((t) => t.code === 'PL')).toBeUndefined()

    await expect(publish(B.id, type.id, '2026-10-01'))
      .rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})
