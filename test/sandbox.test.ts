/**
 * Sandbox tenants (D2). A company gets one sandbox, a full tenant with 12
 * sample people and a fortnight of attendance, on the enterprise plan, dated
 * to expire; a sandbox cannot own a sandbox; reset purges and re-seeds under
 * a new id; expiry purges every row of it; the parent is untouched.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { createSandbox, sandboxOf, resetSandbox, purgeExpiredSandboxes, isSandboxTenant, deleteSandbox } from '../src/control-plane/sandbox.ts'

let A: Tenant; let admin: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  admin = await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'sbadmin@alpha.test', fullName: 'Alpha Admin', password: 'a-long-password-1', roles: ['org_admin'] }))
})
afterAll(async () => { await closePools(); await controlPool.end(); await controlDb.end() })

describe('sandbox', () => {
  it('creates once, seeds, resets, expires', async () => {
    expect(await sandboxOf(A.id)).toBeNull()
    const s = await createSandbox({ parentTenantId: A.id, adminEmail: 'sbadmin@alpha.test', adminName: 'Alpha Admin', organisationType: 'manufacturing', days: 7, requestedByUserId: admin })
    expect(s).toMatchObject({ display_name: 'Alpha — Sandbox', organisation_type: 'manufacturing', headcount: 12, admin_email: 'sbadmin@alpha.test' })
    expect(s.sandbox_expires_on).toBe(new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10))
    expect(await isSandboxTenant(s.id)).toBe(true)
    expect(await isSandboxTenant(A.id)).toBe(false)
    await expect(createSandbox({ parentTenantId: A.id, adminEmail: 'x@alpha.test', adminName: 'x', requestedByUserId: admin })).rejects.toMatchObject({ code: 'SANDBOX_EXISTS' })
    await expect(createSandbox({ parentTenantId: s.id, adminEmail: 'x@alpha.test', adminName: 'x', requestedByUserId: admin })).rejects.toMatchObject({ code: 'SANDBOX_OF_SANDBOX' })
    // the sandbox is a working tenant on the enterprise plan with modules on and attendance computed
    await withTenant(s.id, async (tx) => {
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM daily_attendance WHERE status = 'present'`)).rows[0]!.n).not.toBe('0')
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM compensation_records`)).rows[0]!.n).toBe('12')
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app_users`)).rows[0]!.n).toBe('13')
      expect((await tx.query<{ department: string }>(`SELECT DISTINCT department FROM employee_assignments ORDER BY 1`)).rows.map((r) => r.department)).toEqual(['Engineering', 'Finance', 'Operations', 'Sales'])
    })
    expect((await controlDb.query<{ plan_code: string }>(`SELECT plan_code FROM control_plane.subscriptions WHERE tenant_id = $1`, [s.id])).rows[0]!.plan_code).toBe('enterprise')
    // the parent has none of it
    await withTenant(A.id, async (tx) => expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`)).rows[0]!.n).toBe('1'))
    // reset: new id, same expiry, fresh data
    const r = await resetSandbox({ parentTenantId: A.id, requestedByUserId: admin })
    expect(r.id).not.toBe(s.id)
    expect(r.sandbox_expires_on).toBe(s.sandbox_expires_on)
    expect((await controlDb.query(`SELECT 1 FROM tenants WHERE id = $1`, [s.id])).rowCount).toBe(0)
    expect((await controlDb.query(`SELECT 1 FROM employees WHERE tenant_id = $1`, [s.id])).rowCount).toBe(0)
    // expiry: not yet; then past
    expect(await purgeExpiredSandboxes()).toBe(0)
    expect(await purgeExpiredSandboxes(new Date(Date.now() + 8 * 86_400_000).toISOString().slice(0, 10))).toBe(1)
    expect(await sandboxOf(A.id)).toBeNull()
    expect((await controlDb.query(`SELECT 1 FROM tenants WHERE id = $1`, [r.id])).rowCount).toBe(0)
    await expect(deleteSandbox(A.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // the parent still stands
    expect((await controlDb.query(`SELECT 1 FROM tenants WHERE id = $1`, [A.id])).rowCount).toBe(1)
  })
})
