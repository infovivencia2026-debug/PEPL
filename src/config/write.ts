/**
 * The config write path.
 *
 * Every write: validates against the registry, enforces the payroll effective-date
 * guard, appends to the change log, and bumps the tenant's config version — all in
 * the caller's transaction, so a new version can never be observed with stale values.
 */
import type { PoolClient } from 'pg'
import { getDefinition } from '../config-registry/index.ts'
import type { ConfigValue, ScopeDimension } from '../config-registry/types.ts'

export class ConfigError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

export interface SetSettingInput {
  key: string
  value: ConfigValue
  effectiveFrom?: string | null
  reason?: string
  actorUserId?: string
  scope?: { type: ScopeDimension; id: string; priority?: number }
  /** Periods already frozen for payroll. A payroll-affecting change cannot land inside one. */
  frozenThrough?: string | null
}

export async function setSetting(tx: PoolClient, input: SetSettingInput): Promise<void> {
  const def = getDefinition(input.key)

  let value: ConfigValue
  try {
    value = def.validate(input.value)
  } catch (e) {
    throw new ConfigError('CONFIG_INVALID_VALUE', `${input.key}: ${(e as Error).message}`)
  }

  const affectsPayroll = def.affects.includes('payroll')
  const effectiveFrom = input.effectiveFrom ?? null

  if (affectsPayroll && !effectiveFrom) {
    throw new ConfigError(
      'CONFIG_EFFECTIVE_DATE_REQUIRED',
      `"${input.key}" affects payroll and must carry an effective date, so a locked run stays reproducible`,
    )
  }

  if (affectsPayroll && effectiveFrom && input.frozenThrough && effectiveFrom <= input.frozenThrough) {
    throw new ConfigError(
      'CONFIG_LOCKED_PERIOD',
      `"${input.key}" cannot take effect on ${effectiveFrom}: payroll inputs are frozen through ${input.frozenThrough}. Choose a later date.`,
    )
  }

  if (def.risk === 'high' && !input.reason?.trim()) {
    throw new ConfigError('CONFIG_REASON_REQUIRED', `"${input.key}" is a high-risk setting and needs a reason`)
  }

  if (input.scope && !def.scopable.includes(input.scope.type)) {
    throw new ConfigError(
      'CONFIG_NOT_SCOPABLE',
      `"${input.key}" cannot be overridden by ${input.scope.type} (allowed: ${def.scopable.join(', ') || 'none'})`,
    )
  }

  const tenantId = await currentTenant(tx)
  const json = JSON.stringify(value)

  if (input.scope) {
    const prev = await tx.query<{ value: unknown }>(
      `SELECT value FROM tenant_setting_overrides
        WHERE key = $1 AND scope_type = $2 AND scope_id = $3 AND effective_from IS NOT DISTINCT FROM $4`,
      [input.key, input.scope.type, input.scope.id, effectiveFrom],
    )
    await tx.query(
      `INSERT INTO tenant_setting_overrides
         (tenant_id, key, scope_type, scope_id, value, effective_from, priority, set_by_user_id, reason)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
       ON CONFLICT (tenant_id, key, scope_type, scope_id, effective_from)
       DO UPDATE SET value = EXCLUDED.value, priority = EXCLUDED.priority,
                     set_by_user_id = EXCLUDED.set_by_user_id, reason = EXCLUDED.reason,
                     updated_at = now()`,
      [tenantId, input.key, input.scope.type, input.scope.id, json, effectiveFrom,
       input.scope.priority ?? 100, input.actorUserId ?? null, input.reason ?? null],
    )
    await logChange(tx, tenantId, input, prev.rows[0]?.value ?? null, json, effectiveFrom)
    await bumpVersion(tx, tenantId)
    return
  }

  const prev = await tx.query<{ value: unknown }>(
    `SELECT value FROM tenant_settings WHERE key = $1 AND effective_from IS NOT DISTINCT FROM $2`,
    [input.key, effectiveFrom],
  )
  await tx.query(
    `INSERT INTO tenant_settings (tenant_id, key, value, effective_from, set_by_user_id, reason)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6)
     ON CONFLICT (tenant_id, key, effective_from)
     DO UPDATE SET value = EXCLUDED.value, set_by_user_id = EXCLUDED.set_by_user_id,
                   reason = EXCLUDED.reason, updated_at = now()`,
    [tenantId, input.key, json, effectiveFrom, input.actorUserId ?? null, input.reason ?? null],
  )
  await logChange(tx, tenantId, input, prev.rows[0]?.value ?? null, json, effectiveFrom)
  await bumpVersion(tx, tenantId)
}

async function logChange(
  tx: PoolClient,
  tenantId: string,
  input: SetSettingInput,
  oldValue: unknown,
  newValueJson: string,
  effectiveFrom: string | null,
): Promise<void> {
  await tx.query(
    `INSERT INTO config_change_log
       (tenant_id, key, scope_type, scope_id, old_value, new_value, effective_from, actor_user_id, reason)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8, $9)`,
    [tenantId, input.key, input.scope?.type ?? null, input.scope?.id ?? null,
     oldValue === null ? null : JSON.stringify(oldValue), newValueJson,
     effectiveFrom, input.actorUserId ?? null, input.reason ?? null],
  )
}

/** Same transaction as the write, so version and values move together. */
async function bumpVersion(tx: PoolClient, tenantId: string): Promise<void> {
  await tx.query(
    `INSERT INTO tenant_config_versions (tenant_id, version)
     VALUES ($1, 1)
     ON CONFLICT (tenant_id) DO UPDATE SET version = tenant_config_versions.version + 1, updated_at = now()`,
    [tenantId],
  )
}

async function currentTenant(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new ConfigError('NO_TENANT_CONTEXT', 'config write attempted without a tenant context')
  return t
}
