/**
 * CI gate: every permission is actually asserted somewhere.
 *
 * A permission nobody checks is a role that grants nothing. It reads as a
 * capability in the roles screen, an admin assigns it expecting an effect, and
 * there is none — the same failure as a setting no code reads, which is why
 * that gate exists too.
 *
 * This found seven when it was written, including bank.export, whose feature
 * was fully built and tested with no route to reach it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/authz/permissions.ts'
import { ACTIONS } from '../src/audit/index.ts'

const failures: string[] = []
const fail = (m: string): number => failures.push(m)

function sources(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== 'node_modules') sources(full, found)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      found.push(full)
    }
  }
  return found
}

/** Where a permission has to appear to count as enforced. */
const enforcement = sources('src')
  .filter((file) => !file.includes('authz'))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n')

/**
 * Permissions no route asserts, with the reason each is legitimate.
 *
 * An entry here claims the permission gates VISIBILITY of a screen whose data
 * is already protected by other permissions. It is not a way to silence the
 * gate: every entry is printed on each run, so the list cannot quietly grow.
 */
const ADVISORY: Record<string, string> = {
  'report.read':
    'reports derive from employees, attendance and payroll, each gated by its ' +
    'own permission; this decides only who sees the screen',
}

/** The UI may legitimately be the only consumer of a read-only permission. */
const ui = sources('web/src').map((file) => readFileSync(file, 'utf8')).join('\n')

for (const permission of PERMISSIONS) {
  const quoted = `'${permission}'`
  if (enforcement.includes(quoted)) continue
  if (ADVISORY[permission]) continue

  if (ui.includes(quoted)) {
    fail(
      `"${permission}" is used by the UI but asserted by no route. If it only ` +
      'decides which screen is visible, declare it in ADVISORY with the reason; ' +
      'otherwise assert it on the route that serves the data.',
    )
    continue
  }
  fail(
    `"${permission}" is declared but never asserted anywhere — a role granting ` +
    'it grants nothing. Assert it on a route or remove it.',
  )
}

// A permission no role holds is unreachable for a different reason: nobody can
// ever be given it, so the routes asserting it are dead to every seeded role.
const held = new Set(Object.values(ROLE_PERMISSIONS).flatMap((r) => r.permissions))
for (const permission of PERMISSIONS) {
  if (!held.has(permission)) {
    fail(`"${permission}" is held by no seeded role — nobody can be granted it`)
  }
}

// Audit actions are a closed vocabulary: emit() rejects an unknown one with
// UNKNOWN_ACTION at request time. A route emitting an action the vocabulary
// lacks therefore works in every unit test that never calls the route and
// fails for the first real user. Found live by the smoke rig: tax_declaration
// verify/reject answered 422 on the running server. Every `action: '…'` literal
// in src/ must name an action that exists.
for (const file of sources('src').filter((f) => !f.includes('audit'))) {
  const text = readFileSync(file, 'utf8')
  for (const m of text.matchAll(/\baction:\s*'([a-z_]+(?:\.[a-z_]+)+)'/g)) {
    if (!(m[1]! in ACTIONS)) {
      fail(`${file} emits audit action "${m[1]}", which is not in the vocabulary in src/audit/index.ts`)
    }
  }
}

if (failures.length) {
  console.error(`\nPermission gate FAILED (${failures.length} problem(s)):\n`)
  for (const f of failures) console.error(`  x ${f}`)
  console.error('')
  process.exit(1)
}
console.log(`Permission gate passed: ${PERMISSIONS.length} permissions, all asserted and grantable.`)
for (const [permission, why] of Object.entries(ADVISORY)) {
  console.log(`  advisory (visibility only): ${permission} — ${why}`)
}
