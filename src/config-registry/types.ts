/**
 * Config DEFINITIONS live in code; config VALUES live per tenant in Postgres.
 *
 * Definitions carry a type, a default, validation, a risk class, help text and a
 * dependency list. In code these are reviewable, testable and versioned with the
 * feature they govern. As database rows they drift from the code that reads them,
 * which is the most common cause of "this setting does nothing".
 *
 * See docs/architecture/configurability.md §3.
 */

export type ScopeDimension = 'department' | 'location' | 'grade' | 'employment_type'

export type Risk = 'low' | 'high'

/** What happens to existing data when a module-level flag is switched off. */
export type DisableEffect = 'soft' | 'blocked_if_data'

export type ConfigValue = boolean | number | string

export interface DefinitionBase<T extends ConfigValue> {
  readonly kind: 'flag' | 'bool' | 'int' | 'enum' | 'text'
  readonly default: T
  readonly label: string
  readonly help: string
  readonly risk: Risk
  /** Entitlement key that must be present for this setting to have any effect. */
  readonly entitlement?: string
  /**
   * A module every plan includes. Only meaningful on a `<module>.enabled` flag:
   * gate:modules requires every module switch to be EITHER sellable (entitlement)
   * OR declared core, so a module can never again ship free by accident.
   */
  readonly core?: boolean
  /** Other feature keys that must be enabled for this one to be enabled. */
  readonly dependsOn: readonly string[]
  /** Declaring 'payroll' forces effective-dating and the frozen-period guard. */
  readonly affects: readonly string[]
  /** Which override dimensions layer 5 permits for this key. */
  readonly scopable: readonly ScopeDimension[]
  readonly disableEffect?: DisableEffect
  validate(value: unknown): T
}

export type Definition = DefinitionBase<ConfigValue>

interface CommonOpts {
  label: string
  help: string
  risk?: Risk
  entitlement?: string
  core?: boolean
  dependsOn?: readonly string[]
  affects?: readonly string[]
  scopable?: readonly ScopeDimension[]
  disableEffect?: DisableEffect
}

const common = (o: CommonOpts) => ({
  label: o.label,
  help: o.help,
  risk: o.risk ?? 'low',
  entitlement: o.entitlement,
  core: o.core,
  dependsOn: o.dependsOn ?? [],
  affects: o.affects ?? [],
  scopable: o.scopable ?? [],
  disableEffect: o.disableEffect,
})

export function bool(opts: CommonOpts & { default: boolean }): DefinitionBase<boolean> {
  return {
    kind: 'bool',
    default: opts.default,
    ...common(opts),
    validate(v: unknown): boolean {
      if (typeof v !== 'boolean') throw new Error(`expected boolean, got ${typeof v}`)
      return v
    },
  }
}

/** A module-level on/off switch. Same shape as bool, but flagged high risk by default. */
export function flag(opts: CommonOpts & { default: boolean }): DefinitionBase<boolean> {
  return { ...bool({ ...opts, risk: opts.risk ?? 'high' }), kind: 'flag' }
}

export function int(
  opts: CommonOpts & { default: number; min?: number; max?: number },
): DefinitionBase<number> {
  const { min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = opts
  return {
    kind: 'int',
    default: opts.default,
    ...common(opts),
    validate(v: unknown): number {
      if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`expected integer, got ${JSON.stringify(v)}`)
      if (v < min || v > max) throw new Error(`value ${v} outside allowed range ${min}..${max}`)
      return v
    },
  }
}

export function enumOf<T extends string>(
  values: readonly T[],
  opts: CommonOpts & { default: T },
): DefinitionBase<string> {
  return {
    kind: 'enum',
    default: opts.default,
    ...common(opts),
    validate(v: unknown): string {
      if (typeof v !== 'string' || !values.includes(v as T)) {
        throw new Error(`expected one of ${values.join(' | ')}, got ${JSON.stringify(v)}`)
      }
      return v
    },
  }
}

export function text(opts: CommonOpts & { default: string; maxLength?: number }): DefinitionBase<string> {
  const max = opts.maxLength ?? 1000
  return {
    kind: 'text',
    default: opts.default,
    ...common(opts),
    validate(v: unknown): string {
      if (typeof v !== 'string') throw new Error(`expected string, got ${typeof v}`)
      if (v.length > max) throw new Error(`string longer than ${max} characters`)
      return v
    },
  }
}

/** Namespaces a module's definitions into fully-qualified keys ("leave.enabled"). */
export function defineConfig(
  namespace: string,
  defs: Record<string, Definition>,
): Record<string, Definition> {
  const out: Record<string, Definition> = {}
  for (const [name, def] of Object.entries(defs)) out[`${namespace}.${name}`] = def
  return out
}
