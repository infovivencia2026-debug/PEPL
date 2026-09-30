/**
 * Applying an organisation-type preset.
 *
 * Two paths, one source of truth (db/reference/presets.ts):
 *  - at provisioning, on the superuser client with the tenant not yet live,
 *    settings are written straight into tenant_settings (no payroll exists yet,
 *    so nothing is effective-dated);
 *  - on demand by an org admin, through the app role and setSetting(), so the
 *    payroll-affecting keys get an effective date and the change log like any
 *    other edit.
 */
import type pg from 'pg'
import type { PoolClient } from 'pg'
import { PRESETS, presetByCode, type Preset } from '../../db/reference/presets.ts'
import { REGISTRY } from '../config-registry/index.ts'
import { setSetting } from '../config/write.ts'
import { createShift } from '../attendance/shifts.ts'

export class PresetError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'PresetError' }
}

/** Every key a preset names must exist and its value must validate — checked by the test suite and again at apply. */
export function validatePreset(p: Preset): string[] {
  const problems: string[] = []
  for (const [key, value] of Object.entries(p.settings)) {
    const def = REGISTRY[key]
    if (!def) { problems.push(`${p.code}: unknown setting ${key}`); continue }
    try { def.validate(value) } catch (e) { problems.push(`${p.code}: ${key} = ${JSON.stringify(value)} — ${(e as Error).message}`) }
  }
  return problems
}

export const listPresets = (): Array<Pick<Preset, 'code' | 'label' | 'description' | 'examples'> & { modulesOn: string[]; shifts: string[] }> =>
  PRESETS.map((p) => ({ code: p.code, label: p.label, description: p.description, examples: p.examples,
    modulesOn: Object.entries(p.settings).filter(([k, v]) => k.endsWith('.enabled') && v === true).map(([k]) => k.split('.')[0]!),
    shifts: p.shifts.map((s) => s.name) }))

/**
 * Refuse an organisation type the server does not know, BEFORE any row exists.
 *
 * This used to be discovered at the `preset` step, after the tenant and its admin
 * user had been created, so a wrong value left a half-built company behind. The
 * console was sending values the server had never heard of -- its own hard-coded
 * list -- and every attempt with one of them stranded a tenant.
 */
export function assertKnownOrganisationType(code: string | undefined | null): void {
  if (code === undefined || code === null || code === '') return   // omitted = plain defaults
  if (presetByCode(code)) return
  throw new PresetError('VALIDATION_FAILED',
    `unknown organisation type "${code}"; choose one of: ${PRESETS.map((p) => p.code).join(', ')}`)
}

/** Provisioning path: superuser client, tenant id explicit. Idempotent. */
export async function applyPresetAtProvisioning(client: pg.PoolClient, tenantId: string, code: string): Promise<void> {
  const p = presetByCode(code)
  if (!p) throw new PresetError('PRESET_NOT_FOUND', `no such organisation type: ${code}`)
  const problems = validatePreset(p)
  if (problems.length) throw new PresetError('PRESET_INVALID', problems.join('; '))
  for (const [key, value] of Object.entries(p.settings)) {
    await client.query(
      `INSERT INTO tenant_settings (tenant_id, key, value, effective_from, reason) VALUES ($1, $2, $3::jsonb, NULL, $4)
       ON CONFLICT (tenant_id, key, effective_from) DO UPDATE SET value = EXCLUDED.value, reason = EXCLUDED.reason, updated_at = now()`,
      [tenantId, key, JSON.stringify(value), `preset:${p.code}`])
  }
  for (const s of p.shifts) {
    await client.query(
      `INSERT INTO shifts (tenant_id, code, name, start_time, end_time, grace_in_min, grace_out_min, break_min, full_day_min, half_day_min, ot_after_min, ot_eligible, weekly_off_days)
       VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [tenantId, s.code, s.name, s.startTime, s.endTime, s.graceInMin ?? 0, s.breakMin ?? 0, s.fullDayMin, s.halfDayMin, s.otAfterMin ?? 0, s.otEligible ?? false, s.weeklyOffDays])
  }
  for (const lt of p.leaveTypes) {
    await client.query(`INSERT INTO leave_types (tenant_id, code, name, is_paid, affects_lop) VALUES ($1,$2,$3,$4,false) ON CONFLICT (tenant_id, code) DO NOTHING`, [tenantId, lt.code, lt.name, lt.isPaid])
  }
  await client.query(`UPDATE tenants SET organisation_type = $2 WHERE id = $1`, [tenantId, p.code])
}

/** Admin path: app role, inside withTenant. Payroll-affecting keys take effect from the given date. */
export async function applyPreset(tx: PoolClient, args: { code: string; actorUserId: string; payrollEffectiveFrom: string }): Promise<{ settings: number; shifts: number }> {
  const p = presetByCode(args.code)
  if (!p) throw new PresetError('PRESET_NOT_FOUND', `no such organisation type: ${args.code}`)
  const problems = validatePreset(p)
  if (problems.length) throw new PresetError('PRESET_INVALID', problems.join('; '))
  let settings = 0
  for (const [key, value] of Object.entries(p.settings)) {
    const def = REGISTRY[key]!
    await setSetting(tx, { key, value: def.validate(value), reason: `preset:${p.code}`, actorUserId: args.actorUserId, ...(def.affects.includes('payroll') ? { effectiveFrom: args.payrollEffectiveFrom } : {}) })
    settings++
  }
  let shifts = 0
  const existing = new Set((await tx.query<{ code: string }>(`SELECT code FROM shifts`)).rows.map((r) => r.code))
  for (const s of p.shifts) {
    if (existing.has(s.code)) continue
    await createShift(tx, { code: s.code, name: s.name, startTime: s.startTime, endTime: s.endTime, graceInMin: s.graceInMin, breakMin: s.breakMin, fullDayMin: s.fullDayMin, halfDayMin: s.halfDayMin, otAfterMin: s.otAfterMin, otEligible: s.otEligible, weeklyOffDays: s.weeklyOffDays })
    shifts++
  }
  for (const lt of p.leaveTypes) {
    await tx.query(`INSERT INTO leave_types (tenant_id, code, name, is_paid, affects_lop) SELECT current_tenant(), $1, $2, $3, false ON CONFLICT (tenant_id, code) DO NOTHING`, [lt.code, lt.name, lt.isPaid])
  }
  await tx.query(`UPDATE tenants SET organisation_type = $1 WHERE id = current_tenant()`, [p.code])
  return { settings, shifts }
}
