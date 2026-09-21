/**
 * Config resolution.
 *
 *   enabled = capability AND release_flag AND entitlement
 *             AND tenant_setting AND scope_override
 *
 * Most restrictive wins, and a tenant setting can NEVER widen an entitlement.
 * That one-directional rule is what makes total customer control commercially safe.
 *
 * Resolved ONCE per request or job — never per call site, and never inside a loop
 * over employees. See docs/architecture/configurability.md §7.
 */
import type { PoolClient } from 'pg'
import { getDefinition, REGISTRY, REGISTRY_KEYS } from '../config-registry/index.ts'
import type { ConfigValue, ScopeDimension } from '../config-registry/types.ts'

export type Scope = Partial<Record<ScopeDimension, string>>

export interface ResolvedConfig {
  readonly tenantId: string
  readonly version: bigint
  readonly asOf: string
  get<T extends ConfigValue>(key: string, scope?: Scope): T
  isEnabled(key: string, scope?: Scope): boolean
  limit(name: string): number
  /** Keys whose effective value differs from the registry default. */
  changedKeys(): string[]
}

interface SettingRow { key: string; value: unknown; effective_from: string | null }
interface OverrideRow extends SettingRow { scope_type: string; scope_id: string; priority: number }

const iso = (d: Date | string): string =>
  typeof d === 'string' ? d : d.toISOString().slice(0, 10)

/** NULL effective_from sorts before every real date: it means "always applied". */
const appliesBy = (effectiveFrom: string | null, asOf: string): boolean =>
  effectiveFrom === null || effectiveFrom <= asOf

export async function resolveConfig(
  tx: PoolClient,
  tenantId: string,
  opts: { asOf?: Date | string; scope?: Scope } = {},
): Promise<ResolvedConfig> {
  const asOf = iso(opts.asOf ?? new Date())

  // Sequential, not Promise.all: a single PoolClient runs one query at a time,
  // and issuing them concurrently only queues them behind a deprecation warning.
  const { rows: verRows } = await tx.query<{ version: string }>(
    'SELECT version FROM tenant_config_versions')
  const { rows: entRows } = await tx.query<{ features: Record<string, boolean>; limits: Record<string, number>; status: string }>(
    'SELECT features, limits, status FROM tenant_entitlements')
  const { rows: settingRows } = await tx.query<SettingRow>(
    'SELECT key, value, effective_from::text FROM tenant_settings ORDER BY key, effective_from NULLS FIRST')
  const { rows: overrideRows } = await tx.query<OverrideRow>(
    `SELECT key, value, effective_from::text, scope_type, scope_id, priority
       FROM tenant_setting_overrides ORDER BY key, priority ASC, effective_from NULLS FIRST`)

  const version = BigInt(verRows[0]?.version ?? '0')
  // A suspended or cancelled subscription sells nothing: every entitled module
  // reads as off, so the data stays and the product stops. past_due keeps working.
  const subscriptionLive = !['suspended', 'cancelled'].includes(entRows[0]?.status ?? 'active')
  const entitlements = subscriptionLive ? (entRows[0]?.features ?? {}) : {}
  const limits = entRows[0]?.limits ?? {}

  // Layer 4: latest row whose effective_from has arrived.
  const settings = new Map<string, unknown>()
  for (const r of settingRows) {
    if (appliesBy(r.effective_from, asOf)) settings.set(r.key, r.value)
  }

  // Layer 5: grouped by key, already ordered by priority (lower wins).
  const overrides = new Map<string, OverrideRow[]>()
  for (const r of overrideRows) {
    if (!appliesBy(r.effective_from, asOf)) continue
    const list = overrides.get(r.key)
    if (list) list.push(r)
    else overrides.set(r.key, [r])
  }

  const rawValue = (key: string, scope?: Scope): ConfigValue => {
    const def = getDefinition(key)

    if (scope) {
      for (const o of overrides.get(key) ?? []) {
        const wanted = scope[o.scope_type as ScopeDimension]
        if (wanted && wanted === o.scope_id) {
          // An override on a non-scopable key is a data error, not a silent win.
          if (!def.scopable.includes(o.scope_type as ScopeDimension)) {
            throw new Error(`config "${key}" is not scopable by ${o.scope_type}`)
          }
          return def.validate(o.value)
        }
      }
    }

    const setting = settings.get(key)
    return setting === undefined ? def.default : def.validate(setting)
  }

  const entitled = (key: string): boolean => {
    const def = getDefinition(key)
    if (!def.entitlement) return true
    return entitlements[def.entitlement] === true
  }

  const resolved: ResolvedConfig = {
    tenantId,
    version,
    asOf,

    get<T extends ConfigValue>(key: string, scope?: Scope): T {
      const def = getDefinition(key)
      // A value behind an unmet entitlement reads as its default, never as the
      // tenant's aspirational setting.
      if (!entitled(key)) return def.default as T
      return rawValue(key, scope) as T
    },

    isEnabled(key: string, scope?: Scope): boolean {
      const def = getDefinition(key)
      if (def.kind !== 'flag' && def.kind !== 'bool') {
        throw new Error(`config "${key}" is not a boolean; use get()`)
      }
      if (!entitled(key)) return false
      if (rawValue(key, scope) !== true) return false
      // Most restrictive wins: a dependency that is off closes this one too.
      for (const dep of def.dependsOn) {
        if (!resolved.isEnabled(dep, scope)) return false
      }
      return true
    },

    limit(name: string): number {
      const v = limits[name]
      return typeof v === 'number' ? v : Number.POSITIVE_INFINITY
    },

    changedKeys(): string[] {
      return REGISTRY_KEYS.filter((k) => {
        const def = REGISTRY[k]
        if (!def) return false
        try {
          return rawValue(k) !== def.default
        } catch {
          return true
        }
      })
    },
  }

  return resolved
}
