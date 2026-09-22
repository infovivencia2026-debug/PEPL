import { describe, it, expect, afterAll, beforeEach } from 'vitest'
import { controlPool } from './fixtures.ts'
import { withTenant, withoutTenantForTesting } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import {
  changePlan, controlDb, grantSupportAccess, provisionTenant, revokeSupportAccess,
  setSubscriptionStatus, supportAccessActive, ControlPlaneError,
} from '../src/control-plane/index.ts'

const ADMIN = 'aa000000-0000-0000-0000-0000000000aa'
const AGENT = 'bb000000-0000-0000-0000-0000000000bb'
const AGENT2 = 'cc000000-0000-0000-0000-0000000000cc'

beforeEach(async () => {
  await controlPool.query(`
    TRUNCATE control_plane.support_access_grants, control_plane.platform_audit,
             control_plane.provisioning_jobs, control_plane.subscriptions CASCADE`)
  await controlPool.query(`
    TRUNCATE ticket_counters, ticket_categories, leave_types,
             tenant_entitlements, tenant_config_versions, app_users,
             employee_assignments, employees, tenants CASCADE`)
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
  await controlDb.end()
})

const newTenant = (planCode = 'growth') =>
  provisionTenant({
    legalName: 'Acme Manufacturing Pvt Ltd',
    displayName: 'Acme',
    planCode,
    adminEmail: 'admin@acme.com',
    adminName: 'Priya',
  })

describe('provisioning is one orchestrator, idempotent and resumable', () => {
  it('runs every step and leaves a usable tenant', async () => {
    const r = await newTenant()
    expect(r.stepsRun).toEqual([
      'tenant', 'subscription', 'entitlements', 'admin_user', 'defaults', 'preset', 'config_version',
    ])

    const seeded = await withTenant(r.tenantId, async (tx) => ({
      leaveTypes: (await tx.query('SELECT code FROM leave_types ORDER BY code')).rows.map((x) => x.code),
      categories: (await tx.query('SELECT name FROM ticket_categories')).rows.length,
      admin: (await tx.query('SELECT email FROM app_users')).rows[0]?.email,
    }))
    expect(seeded.leaveTypes).toEqual(['CL', 'CO', 'EL', 'LOP', 'ML', 'SL'])
    expect(seeded.categories).toBe(6)
    expect(seeded.admin).toBe('admin@acme.com')
  })

  it('a brand-new tenant can run payroll with ZERO configuration', async () => {
    const r = await newTenant('growth')
    const cfg = await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))

    expect(cfg.isEnabled('payroll.enabled')).toBe(true)
    expect(cfg.isEnabled('attendance.enabled')).toBe(true)
    expect(cfg.isEnabled('leave.enabled')).toBe(true)
    expect(cfg.get<string>('attendance.week_pattern')).toBe('six_day')
    expect(cfg.get<string>('payroll.lop_basis')).toBe('calendar_days')
    // nothing has been configured, and nothing needed to be
    expect(cfg.changedKeys()).toEqual([])
  })

  it('a failure part-way leaves a resumable job, and resuming completes it', async () => {
    const err = await newTenantFailing().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ControlPlaneError)

    const job = await controlPool.query<{ id: string; status: string; completed_steps: string[] }>(
      `SELECT id, status, completed_steps FROM control_plane.provisioning_jobs`,
    )
    expect(job.rows[0]!.status).toBe('failed')
    expect(job.rows[0]!.completed_steps).toEqual(['tenant', 'subscription'])

    const resumed = await provisionTenant(
      { legalName: 'Acme', displayName: 'Acme', planCode: 'growth', adminEmail: 'admin@acme.com', adminName: 'Priya' },
      { resumeJobId: job.rows[0]!.id },
    )
    expect(resumed.resumed).toBe(true)
    expect(resumed.stepsRun).toEqual(['entitlements', 'admin_user', 'defaults', 'preset', 'config_version'])

    const after = await controlPool.query<{ status: string }>(
      `SELECT status FROM control_plane.provisioning_jobs`,
    )
    expect(after.rows[0]!.status).toBe('completed')

    // and the tenant is now complete, not half-built
    const seeded = await withTenant(resumed.tenantId, async (tx) =>
      (await tx.query('SELECT code FROM leave_types')).rows.length,
    )
    expect(seeded).toBe(6)
  })

  const newTenantFailing = () =>
    provisionTenant(
      { legalName: 'Acme', displayName: 'Acme', planCode: 'growth', adminEmail: 'admin@acme.com', adminName: 'Priya' },
      { failAfter: 'subscription' },
    )
})

describe('entitlements are a projection, so billing and access cannot drift', () => {
  it('an upgrade opens the module immediately', async () => {
    const r = await newTenant('starter')
    const before = await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))
    expect(before.isEnabled('payroll.enabled')).toBe(false)

    await changePlan(r.tenantId, 'professional')
    const after = await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))
    expect(after.isEnabled('payroll.enabled')).toBe(true)
    expect(after.isEnabled('helpdesk.enabled')).toBe(false) // bought, but not switched on
  })

  it('a downgrade closes it again', async () => {
    const r = await newTenant('professional')
    expect((await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))).isEnabled('payroll.enabled')).toBe(true)

    await changePlan(r.tenantId, 'starter')
    expect((await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))).isEnabled('payroll.enabled')).toBe(false)
  })

  it('every projection bumps the config version so no cache serves stale access', async () => {
    const r = await newTenant('starter')
    const v1 = (await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))).version
    await changePlan(r.tenantId, 'growth')
    const v2 = (await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))).version
    expect(v2).toBeGreaterThan(v1)
  })

  it('carries the plan limits through to the resolver', async () => {
    const r = await newTenant('growth')
    const cfg = await withTenant(r.tenantId, (tx) => resolveConfig(tx, r.tenantId))
    expect(cfg.limit('employees')).toBe(200)
    expect(cfg.limit('unknown_limit')).toBe(Number.POSITIVE_INFINITY)
  })

  it('suspension is reflected without deleting anything', async () => {
    const r = await newTenant('growth')
    await setSubscriptionStatus(r.tenantId, 'suspended')
    const row = await withTenant(r.tenantId, async (tx) =>
      (await tx.query('SELECT status FROM tenant_entitlements')).rows[0],
    )
    expect(row.status).toBe('suspended')
    const emp = await withTenant(r.tenantId, async (tx) =>
      (await tx.query('SELECT * FROM leave_types')).rows.length,
    )
    expect(emp).toBe(6) // data retained
  })
})

describe('the application role is walled off from the control plane', () => {
  it('cannot read subscriptions or plans', async () => {
    await newTenant()
    await expect(
      withoutTenantForTesting(async (tx) => tx.query('SELECT * FROM control_plane.subscriptions')),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withoutTenantForTesting(async (tx) => tx.query('SELECT * FROM control_plane.plans')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('cannot write its own entitlements', async () => {
    const r = await newTenant('starter')
    await expect(
      withTenant(r.tenantId, async (tx) =>
        tx.query(`UPDATE tenant_entitlements SET features = '{"payroll":true}'::jsonb`),
      ),
    ).rejects.toThrow(/permission denied/i)
  })

  it('cannot read another tenant support grants', async () => {
    await expect(
      withoutTenantForTesting(async (tx) => tx.query('SELECT * FROM control_plane.support_access_grants')),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('support access is granted, time-boxed and audited', () => {
  it('requires the tenant approval, a reason, and expires', async () => {
    const r = await newTenant()
    const id = await grantSupportAccess({
      tenantId: r.tenantId, agentId: AGENT, grantedByUserId: ADMIN,
      reason: 'ticket 412: payroll run will not calculate', hours: 4,
    })
    expect(await supportAccessActive(id)).toBe(true)

    await revokeSupportAccess(id)
    expect(await supportAccessActive(id)).toBe(false)
  })

  it('refuses a session with no reason', async () => {
    const r = await newTenant()
    await expect(
      grantSupportAccess({ tenantId: r.tenantId, agentId: AGENT, grantedByUserId: ADMIN, reason: '  ' }),
    ).rejects.toThrow(/must record why/)
  })

  it('refuses access with neither tenant approval nor break-glass', async () => {
    const r = await newTenant()
    await expect(
      grantSupportAccess({ tenantId: r.tenantId, agentId: AGENT, reason: 'just looking' }),
    ).rejects.toThrow(/tenant must approve/)
  })

  it('break-glass needs a second approver', async () => {
    const r = await newTenant()
    await expect(
      grantSupportAccess({ tenantId: r.tenantId, agentId: AGENT, breakGlass: true, reason: 'sev1 outage' }),
    ).rejects.toThrow(/second approver/)

    const id = await grantSupportAccess({
      tenantId: r.tenantId, agentId: AGENT, breakGlass: true,
      approver2AgentId: AGENT2, reason: 'sev1: payroll wrong on pay date',
    })
    expect(await supportAccessActive(id)).toBe(true)
  })

  it('every grant is written to the platform audit', async () => {
    const r = await newTenant()
    await grantSupportAccess({
      tenantId: r.tenantId, agentId: AGENT, grantedByUserId: ADMIN, reason: 'ticket 412',
    })
    const { rows } = await controlPool.query<{ action: string; detail: Record<string, unknown> }>(
      `SELECT action, detail FROM control_plane.platform_audit WHERE tenant_id = $1`,
      [r.tenantId],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.action).toBe('support.access.granted')
    expect(rows[0]!.detail.reason).toBe('ticket 412')
  })

  it('an expired grant is inactive without anyone revoking it', async () => {
    const r = await newTenant()
    const id = await grantSupportAccess({
      tenantId: r.tenantId, agentId: AGENT, grantedByUserId: ADMIN, reason: 'x', hours: 4,
    })
    await controlPool.query(
      `UPDATE control_plane.support_access_grants SET expires_at = now() - interval '1 minute' WHERE id = $1`,
      [id],
    )
    expect(await supportAccessActive(id)).toBe(false)
  })
})

describe('provisioned tenants are isolated from each other', () => {
  it('two tenants provisioned back to back cannot see each other', async () => {
    const a = await newTenant()
    const b = await provisionTenant({
      legalName: 'Beta Traders', displayName: 'Beta', planCode: 'starter',
      adminEmail: 'admin@beta.com', adminName: 'Rahul',
    })

    const aSees = await withTenant(a.tenantId, async (tx) =>
      (await tx.query('SELECT email FROM app_users')).rows.map((r) => r.email),
    )
    const bSees = await withTenant(b.tenantId, async (tx) =>
      (await tx.query('SELECT email FROM app_users')).rows.map((r) => r.email),
    )
    expect(aSees).toEqual(['admin@acme.com'])
    expect(bSees).toEqual(['admin@beta.com'])
  })
})
