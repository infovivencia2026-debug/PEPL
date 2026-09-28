/**
 * The restore drill runs in CI, against the test database, with the same
 * pg_dump / pg_restore an operator would use. A backup that cannot be
 * restored and verified is found here, not on the day it is needed.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { restoreDrill } from '../scripts/restore-drill.ts'

const hasPgTools = spawnSync('pg_dump', ['--version'], { encoding: 'utf8' }).status === 0

describe('restore drill', () => {
  it.skipIf(!hasPgTools)('dumps, restores into a scratch database, matches every row count, keeps RLS, re-verifies the audit chain', async () => {
    const r = await restoreDrill()
    expect(r.tables).toBeGreaterThan(80)
    expect(r.dumpBytes).toBeGreaterThan(10_000)
    // Measured against a POPULATED database, which is the state this runs in
    // during a suite: ~40 s early on, 239 s at 90 migrations, 257 s at 93 with
    // another project's tests sharing the box — which overran the old 300 s
    // budget and failed a verify for no reason of its own. The ceiling is
    // deliberately generous: what is being proven is that a backup restores at
    // all, and a drill that times out under load is one people learn to skip.
  }, 600_000)
})
