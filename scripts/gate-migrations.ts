/**
 * Migration filenames must be orderable and unique.
 *
 * `018_auth_lookup.sql` and `018_manager_link.sql` both exist, so the order
 * they apply in is decided by filename sorting rather than by the number. The
 * two happen to be independent, so nothing is broken today — but the next
 * duplicate might not be, and a schema that applies in a different order on a
 * fresh database than it did in production is the kind of difference nobody
 * finds until a restore.
 *
 * The pair is NOT renamed: migrations are forward-only and both are recorded in
 * `_migrations` on every deployed database. Renaming one would make a fresh
 * database apply a file that existing databases know by another name. So the
 * existing collision is grandfathered by name, and any NEW one fails the build.
 */
import { readdirSync } from 'node:fs'

/** The one collision that predates this gate. Do not add to this list. */
const GRANDFATHERED = new Set(['018'])

const files = readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort()

const byNumber = new Map<string, string[]>()
const malformed: string[] = []
for (const f of files) {
  const m = /^(\d{3})_[a-z0-9_]+\.sql$/.exec(f)
  if (!m) { malformed.push(f); continue }
  byNumber.set(m[1]!, [...(byNumber.get(m[1]!) ?? []), f])
}

const duplicates = [...byNumber].filter(([n, list]) => list.length > 1 && !GRANDFATHERED.has(n))
const grandfathered = [...byNumber].filter(([n, list]) => list.length > 1 && GRANDFATHERED.has(n))

console.log(`PEPL migration filenames: ${files.length} file(s)`)
for (const [n, list] of grandfathered) {
  console.log(`  known duplicate ${n}: ${list.join(', ')} (grandfathered; order is by filename)`)
}

if (malformed.length) {
  console.error(`\nmalformed migration name(s): ${malformed.join(', ')}`)
  console.error('expected NNN_lower_snake_case.sql')
}
if (duplicates.length) {
  console.error('\nduplicate migration number(s):')
  for (const [n, list] of duplicates) console.error(`  ${n}: ${list.join(', ')}`)
  console.error('\nTwo files with one number apply in filename order, not numeric order.')
  console.error('Give the new one the next free number.')
}

if (malformed.length || duplicates.length) process.exit(1)
console.log('All migration filenames are unique and well formed.')
