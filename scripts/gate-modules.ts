/**
 * gate:modules — every module switch is a COMPLETE module.
 *
 * A module is a `<name>.enabled` flag in the registry. For each one this gate
 * asserts the blueprint's definition of done (§5):
 *
 *   1. it is sellable (`entitlement`) OR declared `core: true` — never free by
 *      accident, which is how expenses/timesheets/recruitment/performance
 *      shipped to every plan for months;
 *   2. at least one permission belongs to it (prefix map below);
 *   3. at least one route guards on it (`requireModule(ctx, '<name>.enabled')`);
 *   4. at least one test file exercises it (the module name appears in test/);
 *   5. a CODEX-BRIEF section mentions it, so the UI contract exists.
 *
 * Exit 1 on the first module that fails any line.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REGISTRY } from '../src/config-registry/index.ts'
import { PERMISSIONS } from '../src/authz/permissions.ts'

/** Module name → permission prefix, where they differ. */
const PERMISSION_PREFIX: Record<string, string> = {
  recruitment: 'recruit', expenses: 'expense', timesheets: 'timesheet', helpdesk: 'ticket',
  chat: 'announcement', mail: 'mail', notifications: 'settings', documents: 'document', payroll: 'payroll',
}
/** Self-service modules whose routes use authed(null): every signed-in user owns their own rows. */
const SELF_SERVICE = new Set(['mail'])
/** Core infrastructure that has no route guard of its own. */
const NO_ROUTE_GUARD = new Set(['notifications'])

const readAll = (dir: string): string => {
  let out = ''
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out += readAll(p)
    else if (/\.(ts|tsx|md)$/.test(e.name)) out += readFileSync(p, 'utf8') + '\n'
  }
  return out
}
const routes = readAll('src/http')
const tests = readdirSync('test').filter((f) => f.endsWith('.test.ts'))
const testText = Object.fromEntries(tests.map((f) => [f, readFileSync(join('test', f), 'utf8')]))
const brief = readFileSync('CODEX-BRIEF.md', 'utf8')

const modules = Object.keys(REGISTRY).filter((k) => k.endsWith('.enabled')).map((k) => k.split('.')[0]!)
let failed = 0
const check = (mod: string, what: string, ok: boolean, detail: string): void => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${mod.padEnd(14)} ${what.padEnd(28)} ${detail}`)
  if (!ok) failed++
}

for (const mod of modules) {
  const def = REGISTRY[`${mod}.enabled`]!
  check(mod, 'sellable or core', Boolean(def.entitlement) || def.core === true,
    def.entitlement ? `entitlement=${def.entitlement}` : def.core ? 'core' : 'neither — add entitlement or core: true')
  const prefix = PERMISSION_PREFIX[mod] ?? mod
  const perms = PERMISSIONS.filter((p) => p.startsWith(prefix + '.'))
  check(mod, 'has permissions', perms.length > 0 || SELF_SERVICE.has(mod), perms.length ? `${perms.length} (${prefix}.*)` : SELF_SERVICE.has(mod) ? 'exempt (self-service, authed(null))' : `none with prefix ${prefix}.`)
  const guarded = routes.includes(`'${mod}.enabled'`)
  check(mod, 'route guard', guarded || NO_ROUTE_GUARD.has(mod), guarded ? 'requireModule found' : NO_ROUTE_GUARD.has(mod) ? 'exempt (infrastructure)' : 'no requireModule')
  const covered = tests.filter((f) => testText[f]!.includes(mod) || testText[f]!.includes(prefix))
  check(mod, 'tested', covered.length > 0, covered.length ? `${covered.length} file(s)` : 'no test mentions it')
  check(mod, 'in CODEX-BRIEF', brief.toLowerCase().includes(mod), brief.toLowerCase().includes(mod) ? 'yes' : 'no section')
}
console.log(failed ? `\n${failed} check(s) failed across ${modules.length} module(s)` : `\nAll ${modules.length} modules complete.`)
process.exit(failed ? 1 : 0)
