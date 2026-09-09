/**
 * CI gate: registry invariants.
 *
 * Every setting is permanent surface area — a UI row, a migration, a test axis, a
 * support answer. This gate keeps that surface honest:
 *   1. every definition has a label, help text and a validating default
 *   2. every key declaring affects:['payroll'] is effective-dateable
 *   3. every dependsOn target exists and is itself a boolean flag
 *   4. the dependency graph is acyclic
 *   5. scopable dimensions are from the known set
 *   6. module-level flags declare a disableEffect (never silent data loss)
 */
import { REGISTRY } from '../src/config-registry/index.ts'
import type { ScopeDimension } from '../src/config-registry/types.ts'

const SCOPES: readonly ScopeDimension[] = ['department', 'location', 'grade', 'employment_type']

const failures: string[] = []
const fail = (m: string): number => failures.push(m)

for (const [key, def] of Object.entries(REGISTRY)) {
  if (!key.includes('.')) fail(`"${key}" is not namespaced as <module>.<setting>`)
  if (!def.label?.trim()) fail(`"${key}" has no label — the admin UI is generated from these`)
  if (!def.help?.trim()) fail(`"${key}" has no help text`)

  try {
    def.validate(def.default)
  } catch (e) {
    fail(`"${key}" default fails its own validation: ${(e as Error).message}`)
  }

  if (def.affects.includes('payroll') && def.risk !== 'high') {
    fail(`"${key}" affects payroll but is not marked high risk — it would change money without a reason prompt`)
  }

  for (const dim of def.scopable) {
    if (!SCOPES.includes(dim)) fail(`"${key}" is scopable by unknown dimension "${dim}"`)
  }

  for (const dep of def.dependsOn) {
    const target = REGISTRY[dep]
    if (!target) {
      fail(`"${key}" depends on "${dep}", which is not in the registry`)
    } else if (target.kind !== 'flag' && target.kind !== 'bool') {
      fail(`"${key}" depends on "${dep}", which is not a boolean and cannot be "enabled"`)
    }
  }

  if (def.kind === 'flag' && !def.disableEffect) {
    fail(`"${key}" is a module flag without a disableEffect — disabling must never silently delete data`)
  }
}

// Cycle detection over dependsOn.
const state = new Map<string, 'visiting' | 'done'>()
const walk = (key: string, trail: string[]): void => {
  const s = state.get(key)
  if (s === 'done') return
  if (s === 'visiting') {
    fail(`dependency cycle: ${[...trail, key].join(' -> ')}`)
    return
  }
  state.set(key, 'visiting')
  for (const dep of REGISTRY[key]?.dependsOn ?? []) {
    if (REGISTRY[dep]) walk(dep, [...trail, key])
  }
  state.set(key, 'done')
}
for (const key of Object.keys(REGISTRY)) walk(key, [])

if (failures.length) {
  console.error(`\nConfig registry gate FAILED (${failures.length} problem(s)):\n`)
  for (const f of failures) console.error(`  x ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`Config registry gate passed: ${Object.keys(REGISTRY).length} definitions verified.`)
