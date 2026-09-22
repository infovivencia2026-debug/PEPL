import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant, withoutTenantForTesting } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { setSetting, ConfigError } from '../src/config/write.ts'

let A: Tenant
let B: Tenant
const DEPT_ENG = '11111111-1111-1111-1111-111111111111'
const DEPT_SALES = '22222222-2222-2222-2222-222222222222'
const GRADE_MGR = '33333333-3333-3333-3333-333333333333'

/** Entitlements are written by the CONTROL PLANE, never by the application. */
async function grantPlan(tenantId: string, features: Record<string, boolean>): Promise<void> {
  await controlPool.query(
    `INSERT INTO tenant_entitlements (tenant_id, plan_code, features, limits)
     VALUES ($1, 'test', $2::jsonb, '{"employees": 100}'::jsonb)
     ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits`,
    [tenantId, JSON.stringify(features)],
  )
}

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeEach(async () => {
  await controlPool.query('TRUNCATE tenant_settings, tenant_setting_overrides, config_change_log, tenant_config_versions, tenant_entitlements')
  await grantPlan(A.id, { payroll: true, helpdesk: false })
  await grantPlan(B.id, { payroll: true, helpdesk: false })
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('defaults', () => {
  it('a tenant that has configured nothing gets working defaults', async () => {
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.get<string>('attendance.week_pattern')).toBe('six_day')
    expect(cfg.get<string>('attendance.half_day_mode')).toBe('explicit')
    expect(cfg.get<number>('attendance.correction_window_days')).toBe(30)
    expect(cfg.isEnabled('attendance.enabled')).toBe(true)
    expect(cfg.isEnabled('payroll.enabled')).toBe(true)
    expect(cfg.changedKeys()).toEqual([])
  })
})

describe('precedence: override > setting > default', () => {
  it('a tenant setting beats the registry default', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 25 })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.get<number>('attendance.correction_window_days')).toBe(25)
    expect(cfg.changedKeys()).toContain('attendance.correction_window_days')
  })

  it('a scoped override beats the tenant setting, for that scope only', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 25 })
      await setSetting(tx, {
        key: 'attendance.correction_window_days',
        value: 0,
        scope: { type: 'department', id: DEPT_ENG },
      })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.get<number>('attendance.correction_window_days', { department: DEPT_ENG })).toBe(0)
    expect(cfg.get<number>('attendance.correction_window_days', { department: DEPT_SALES })).toBe(25)
    expect(cfg.get<number>('attendance.correction_window_days')).toBe(25)
  })

  it('lower priority wins when two overrides both match', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 5, scope: { type: 'department', id: DEPT_ENG, priority: 50 } })
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 15, scope: { type: 'grade', id: GRADE_MGR, priority: 10 } })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.get<number>('attendance.correction_window_days', { department: DEPT_ENG, grade: GRADE_MGR })).toBe(15)
  })

  it('refuses an override on a key that is not scopable', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        setSetting(tx, {
          key: 'payroll.lop_basis',
          value: 'fixed_30',
          reason: 'policy',
          effectiveFrom: '2026-11-01',
          scope: { type: 'department', id: DEPT_ENG },
        }),
      ),
    ).rejects.toThrow(/cannot be overridden by department/)
  })
})

describe('entitlements cannot be widened by a tenant setting', () => {
  it('turning on an unentitled module has no effect', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'helpdesk.enabled', value: true, reason: 'we want it' })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.isEnabled('helpdesk.enabled')).toBe(false)
  })

  it('the same setting takes effect once the plan grants it', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'helpdesk.enabled', value: true, reason: 'we want it' })
    })
    await grantPlan(A.id, { payroll: true, helpdesk: true })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.isEnabled('helpdesk.enabled')).toBe(true)
  })

  it('the plan matrix decides: Starter has no expenses or performance, Growth has expenses only, Professional has both; core modules are on for all', async () => {
    const plan = async (code: string) => {
      await controlPool.query(`INSERT INTO tenant_entitlements (tenant_id, plan_code, features, limits) SELECT $1::uuid, code, features, limits FROM control_plane.plans WHERE code = $2::text
        ON CONFLICT (tenant_id) DO UPDATE SET features = EXCLUDED.features, limits = EXCLUDED.limits, plan_code = EXCLUDED.plan_code`, [A.id, code])
      return withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    }
    const starter = await plan('starter')
    expect([starter.isEnabled('expenses.enabled'), starter.isEnabled('performance.enabled'), starter.isEnabled('timesheets.enabled'), starter.isEnabled('recruitment.enabled')]).toEqual([false, false, false, false])
    expect([starter.isEnabled('leave.enabled'), starter.isEnabled('attendance.enabled'), starter.isEnabled('documents.enabled')]).toEqual([true, true, true])
    const growth = await plan('growth')
    expect([growth.isEnabled('expenses.enabled'), growth.isEnabled('timesheets.enabled'), growth.isEnabled('performance.enabled')]).toEqual([true, true, false])
    const pro = await plan('professional')
    expect([pro.isEnabled('expenses.enabled'), pro.isEnabled('performance.enabled'), pro.isEnabled('recruitment.enabled')]).toEqual([true, true, true])
  })

  it('tells a module switched off apart from one the plan never sold', async () => {
    // The two look identical to a caller that only asks isEnabled, and they are
    // completely different conversations: one is a settings toggle, the other is
    // an account manager. Sales-led selling depends on the browser knowing which.
    await grantPlan(A.id, { payroll: true, helpdesk: false })
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'payroll.enabled', value: false, reason: 'not this year' })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))

    // Sold, but the company turned it off.
    expect(cfg.isEnabled('payroll.enabled')).toBe(false)
    expect(cfg.isEntitled('payroll.enabled')).toBe(true)

    // Never sold, whatever the setting says.
    expect(cfg.isEnabled('helpdesk.enabled')).toBe(false)
    expect(cfg.isEntitled('helpdesk.enabled')).toBe(false)
    expect(cfg.entitlementOf('helpdesk.enabled')).toBe('helpdesk')

    // A module included in every plan is sold to everyone.
    expect(cfg.entitlementOf('leave.enabled')).toBeNull()
    expect(cfg.isEntitled('leave.enabled')).toBe(true)
  })

  it('losing an entitlement closes the feature without touching the setting', async () => {
    await grantPlan(A.id, { payroll: false })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.isEnabled('payroll.enabled')).toBe(false)
  })
})

describe('dependencies: most restrictive wins', () => {
  it('disabling a dependency closes the dependent feature', async () => {
    await grantPlan(A.id, { payroll: true })
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.enabled', value: false, reason: 'not using attendance' })
    })
    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.isEnabled('attendance.enabled')).toBe(false)
    expect(cfg.isEnabled('payroll.enabled')).toBe(false)
  })
})

describe('effective dating and the payroll guard', () => {
  it('a payroll-affecting change without an effective date is refused', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        setSetting(tx, { key: 'payroll.lop_basis', value: 'fixed_30', reason: 'policy change' }),
      ),
    ).rejects.toThrow(/must carry an effective date/)
  })

  it('a high-risk change without a reason is refused', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        setSetting(tx, { key: 'payroll.lop_basis', value: 'fixed_30', effectiveFrom: '2026-12-01' }),
      ),
    ).rejects.toThrow(/needs a reason/)
  })

  it('a change dated inside a frozen payroll period is refused', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        setSetting(tx, {
          key: 'payroll.lop_basis',
          value: 'fixed_30',
          reason: 'policy change',
          effectiveFrom: '2026-09-15',
          frozenThrough: '2026-09-30',
        }),
      ),
    ).rejects.toThrow(/payroll inputs are frozen through 2026-09-30/)
  })

  it('a future-dated change is invisible until its date arrives', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, {
        key: 'payroll.lop_basis',
        value: 'fixed_30',
        reason: 'policy change',
        effectiveFrom: '2026-12-01',
      })
    })
    const before = await withTenant(A.id, (tx) => resolveConfig(tx, A.id, { asOf: '2026-11-30' }))
    expect(before.get<string>('payroll.lop_basis')).toBe('calendar_days')

    const after = await withTenant(A.id, (tx) => resolveConfig(tx, A.id, { asOf: '2026-12-01' }))
    expect(after.get<string>('payroll.lop_basis')).toBe('fixed_30')
  })

  it('resolving as-of a past date reproduces what was configured then', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.remote_is_paid', value: false, reason: 'cost control', effectiveFrom: '2026-06-01' })
      await setSetting(tx, { key: 'attendance.remote_is_paid', value: true, reason: 'reverted', effectiveFrom: '2026-10-01' })
    })
    const june = await withTenant(A.id, (tx) => resolveConfig(tx, A.id, { asOf: '2026-06-15' }))
    const nov = await withTenant(A.id, (tx) => resolveConfig(tx, A.id, { asOf: '2026-11-15' }))
    expect(june.get<boolean>('attendance.remote_is_paid')).toBe(false)
    expect(nov.get<boolean>('attendance.remote_is_paid')).toBe(true)
  })
})

describe('validation', () => {
  it('rejects a value of the wrong type', async () => {
    await expect(
      withTenant(A.id, async (tx) => setSetting(tx, { key: 'attendance.correction_window_days', value: true })),
    ).rejects.toThrow(/expected integer/)
  })

  it('rejects a value outside the declared range', async () => {
    await expect(
      withTenant(A.id, async (tx) => setSetting(tx, { key: 'attendance.correction_window_days', value: 9999 })),
    ).rejects.toThrow(/outside allowed range/)
  })

  it('rejects a value outside an enum', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        setSetting(tx, { key: 'attendance.week_pattern', value: 'nine_day', reason: 'x', effectiveFrom: '2026-12-01' }),
      ),
    ).rejects.toThrow(/expected one of/)
  })

  it('rejects an unknown key', async () => {
    await expect(
      withTenant(A.id, async (tx) => setSetting(tx, { key: 'leave.does_not_exist', value: 1 })),
    ).rejects.toThrow(/unknown config key/)
  })

  it('surfaces a typed error code', async () => {
    const err = await withTenant(A.id, async (tx) =>
      setSetting(tx, { key: 'payroll.lop_basis', value: 'fixed_30', reason: 'x' }).catch((e: unknown) => e),
    )
    expect(err).toBeInstanceOf(ConfigError)
    expect((err as ConfigError).code).toBe('CONFIG_EFFECTIVE_DATE_REQUIRED')
  })
})

describe('tenant isolation of configuration', () => {
  it('one company config change does not affect another company', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 45 })
    })
    const a = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    const b = await withTenant(B.id, (tx) => resolveConfig(tx, B.id))
    expect(a.get<number>('attendance.correction_window_days')).toBe(45)
    expect(b.get<number>('attendance.correction_window_days')).toBe(30)
  })

  it('config rows of another tenant are invisible', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 45 })
    })
    const rows = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT * FROM tenant_settings')).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('with no tenant context, config resolves to defaults and reads nothing', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 45 })
    })
    const rows = await withoutTenantForTesting(async (tx) =>
      (await tx.query('SELECT * FROM tenant_settings')).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('the app role cannot grant itself an entitlement', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(`UPDATE tenant_entitlements SET features = '{"helpdesk":true}'::jsonb`),
      ),
    ).rejects.toThrow(/permission denied/i)
  })
})

describe('change log and versioning', () => {
  it('every write appends to the change log with before and after', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 20 })
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 30 })
    })
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT key, old_value, new_value FROM config_change_log ORDER BY id')).rows,
    )
    expect(rows).toHaveLength(2)
    expect(rows[0].old_value).toBeNull()
    expect(rows[0].new_value).toBe(20)
    expect(rows[1].old_value).toBe(20)
    expect(rows[1].new_value).toBe(30)
  })

  it('the change log cannot be rewritten', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 20 })
    })
    await expect(
      withTenant(A.id, async (tx) => tx.query('UPDATE config_change_log SET new_value = $1::jsonb', ['0'])),
    ).rejects.toThrow(/permission denied/i)
    await expect(
      withTenant(A.id, async (tx) => tx.query('DELETE FROM config_change_log')),
    ).rejects.toThrow(/permission denied/i)
  })

  it('the config version advances on every write, in the same transaction', async () => {
    const v0 = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(v0.version).toBe(0n)

    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 20 })
    })
    const v1 = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(v1.version).toBe(1n)

    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.correction_window_days', value: 15 })
    })
    const v2 = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(v2.version).toBe(2n)
  })

  it('a rolled-back write leaves neither a value, a log row, nor a version bump', async () => {
    await expect(
      withTenant(A.id, async (tx) => {
        await setSetting(tx, { key: 'attendance.correction_window_days', value: 20 })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    const cfg = await withTenant(A.id, (tx) => resolveConfig(tx, A.id))
    expect(cfg.get<number>('attendance.correction_window_days')).toBe(30)
    expect(cfg.version).toBe(0n)

    const logRows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT 1 FROM config_change_log')).rows,
    )
    expect(logRows).toHaveLength(0)
  })
})
