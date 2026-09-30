/**
 * Organisation-type presets: every key each preset names exists in the
 * registry and validates; provisioning with a type writes the settings,
 * seeds the shifts and records the type; the resolved config reflects it;
 * an admin can re-apply a preset through the app role (payroll keys get an
 * effective date) and an unknown code is refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { provisionTenant } from '../src/control-plane/index.ts'
import { PRESETS } from '../db/reference/presets.ts'
import { validatePreset, applyPreset, listPresets } from '../src/control-plane/presets.ts'

let A: Tenant
beforeAll(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

describe('presets', () => {
  it('every preset names only real settings with valid values, and the picker lists them', () => {
    for (const p of PRESETS) expect(validatePreset(p)).toEqual([])
    const listed = listPresets().map((p) => p.code)
    // The original six keep their codes and their order: a live tenant stores its
    // organisation_type, so renaming or dropping one would orphan real companies.
    expect(listed.slice(0, 6)).toEqual(['office', 'field_sales', 'education', 'manufacturing', 'retail', 'agency'])
    // ...and the picker offers everything, including the types added later.
    expect(listed).toEqual(PRESETS.map((p) => p.code))
    expect(listPresets().find((p) => p.code === 'manufacturing')!.shifts).toHaveLength(4)
  })

  it('provisioning with a type seeds settings, shifts and the type; the resolved config shows it', async () => {
    const stamp = Date.now()
    const { tenantId } = await provisionTenant({ legalName: `Meghaa Infra ${stamp}`, displayName: 'Meghaa', planCode: 'professional', adminEmail: `admin-${stamp}@meghaa.test`, adminName: 'Admin', organisationType: 'manufacturing' })
    await controlPool.query(`INSERT INTO tenant_entitlements (tenant_id, plan_code, features, limits) SELECT $1::uuid, code, features, limits FROM control_plane.plans WHERE code = 'professional' ON CONFLICT (tenant_id) DO NOTHING`, [tenantId])
    const t = (await controlPool.query<{ organisation_type: string }>(`SELECT organisation_type FROM tenants WHERE id = $1`, [tenantId])).rows[0]!
    expect(t.organisation_type).toBe('manufacturing')
    await withTenant(tenantId, async (tx) => {
      const cfg = await resolveConfig(tx, tenantId)
      expect(cfg.get('attendance.week_pattern')).toBe('roster')
      expect(cfg.get('payroll.ot_pay')).toBe('double')
      expect(cfg.get('attendance.late_marks_per_half_day')).toBe(3)
      expect(cfg.isEnabled('attendance.remote_enabled')).toBe(false)
      const shifts = (await tx.query<{ code: string }>(`SELECT code FROM shifts ORDER BY code`)).rows.map((r) => r.code)
      expect(shifts).toEqual(['A', 'B', 'C', 'GEN'])
    })
    // An unknown type is refused BEFORE anything is created. It used to be found
    // at the `preset` step, after the tenant and its admin existed -- so this very
    // call created a SECOND "Meghaa Infra" and then failed, leaving it behind.
    await expect(provisionTenant({ legalName: `Meghaa Infra ${stamp}`, displayName: 'Meghaa', planCode: 'professional', adminEmail: `admin-${stamp}@meghaa.test`, adminName: 'Admin', organisationType: 'nope' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    const count = await controlPool.query<{ n: string }>(`SELECT count(*)::text AS n FROM tenants WHERE legal_name = $1`, [`Meghaa Infra ${stamp}`])
    expect(count.rows[0]!.n).toBe('1')
  })

  it('an admin re-applies a preset through the app role: payroll keys are effective-dated, shifts are not duplicated', async () => {
    await withTenant(A.id, async (tx) => {
      const admin = await createUser(tx, { tenantId: A.id, email: 'padmin@acme.test', fullName: 'Admin', password: 'a-long-password-1', roles: ['org_admin'] })
      const r = await applyPreset(tx, { code: 'education', actorUserId: admin, payrollEffectiveFrom: '2027-01-01' })
      expect(r.shifts).toBe(2)
      const again = await applyPreset(tx, { code: 'education', actorUserId: admin, payrollEffectiveFrom: '2027-01-01' })
      expect(again.shifts).toBe(0)
      const rows = (await tx.query<{ key: string; effective_from: string | null }>(`SELECT key, effective_from::text FROM tenant_settings WHERE key IN ('attendance.week_pattern','leave.cycle_start_month') ORDER BY key`)).rows
      expect(rows).toEqual([{ key: 'attendance.week_pattern', effective_from: '2027-01-01' }, { key: 'leave.cycle_start_month', effective_from: '2027-01-01' }])   // both affect payroll → effective-dated
      expect((await tx.query<{ e: string | null }>(`SELECT effective_from::text AS e FROM tenant_settings WHERE key = 'attendance.qr_punch_enabled'`)).rows[0]!.e).toBeNull()   // a plain switch is immediate
      expect((await tx.query<{ code: string }>(`SELECT code FROM leave_types WHERE code = 'VL'`)).rows).toHaveLength(1)
      expect((await tx.query<{ t: string }>(`SELECT organisation_type AS t FROM tenants`)).rows[0]!.t).toBe('education')
      await expect(applyPreset(tx, { code: 'bank', actorUserId: admin, payrollEffectiveFrom: '2027-01-01' })).rejects.toMatchObject({ code: 'PRESET_NOT_FOUND' })
    })
  })
})
