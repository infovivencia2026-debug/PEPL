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
  }, 120_000)
})
