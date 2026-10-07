/**
 * openapi.json lists exactly the operations the server serves.
 *
 * It is generated (`npm run openapi`) and had drifted to 512 operations against 534 routes: anyone
 * building against it was missing a fifth of the API. Compared as a set of "METHOD path" so an added,
 * removed or renamed route fails here, and the message says how to fix it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { buildRouter } from '../src/http/app.ts'

const normal = (path: string): string => path.replace(/:[A-Za-z0-9_]+|\{[A-Za-z0-9_]+\}/g, '{}')

describe('openapi.json', () => {
  it('lists the same operations as the router (run `npm run openapi` after adding a route)', () => {
    const doc = JSON.parse(readFileSync('openapi.json', 'utf8')) as { paths: Record<string, Record<string, unknown>> }
    const documented = new Set<string>()
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) if (['get', 'post', 'put', 'patch', 'delete'].includes(method)) documented.add(`${method.toUpperCase()} ${normal(path)}`)
    }
    const served = new Set(buildRouter().list().map((r) => `${r.method} ${normal(r.path)}`))
    const missing = [...served].filter((x) => !documented.has(x)).sort()
    const stale = [...documented].filter((x) => !served.has(x)).sort()
    expect({ missing: missing.slice(0, 10), stale: stale.slice(0, 10), served: served.size, documented: documented.size }).toEqual(
      { missing: [], stale: [], served: served.size, documented: served.size })
  })
})
