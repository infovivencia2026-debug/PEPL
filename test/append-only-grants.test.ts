/**
 * "Append-only" is a grant, not a habit.
 *
 * 003 gives the runtime role INSERT/UPDATE/DELETE on every table, present and future.
 * A table is therefore append-only only if a migration revoked the rest -- and the
 * ones that nobody revoked were the evidence tables: a ticket's messages (what a
 * grievance said), the login lockout counters (which one request could have reset to
 * brute-force a password), and the hard-delete of documents and bank accounts, which
 * the application only ever retires. Found by an audit; the lists live in
 * src/db/table-classification.ts so the launch gate and this test cannot disagree.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { APPEND_ONLY_TABLES, NO_DELETE_TABLES } from '../src/db/table-classification.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { closePools } from '../src/db/pool.ts'
import { config } from '../src/config.ts'

afterAll(async () => { await closePools(); await controlDb.end() })

const has = async (table: string, priv: string): Promise<boolean> =>
  (await controlDb.query<{ p: boolean }>(`SELECT has_table_privilege($1, $2, $3) AS p`, [config.appUser, table, priv])).rows[0]!.p

describe('the runtime role on evidence tables', () => {
  for (const table of APPEND_ONLY_TABLES) {
    it(`${table}: may read and insert, may not update or delete`, async () => {
      expect(await has(table, 'SELECT')).toBe(true)
      expect(await has(table, 'INSERT')).toBe(true)
      expect(await has(table, 'UPDATE')).toBe(false)
      expect(await has(table, 'DELETE')).toBe(false)
    })
  }

  for (const table of NO_DELETE_TABLES) {
    it(`${table}: retired by UPDATE, never hard-deleted`, async () => {
      expect(await has(table, 'UPDATE')).toBe(true)
      expect(await has(table, 'DELETE')).toBe(false)
    })
  }

  it('a table added to a list must exist (the list cannot rot)', async () => {
    const { rows } = await controlDb.query<{ n: string }>(
      `SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`)
    const existing = new Set(rows.map((r) => r.n))
    for (const t of [...APPEND_ONLY_TABLES, ...NO_DELETE_TABLES]) expect(existing.has(t), t).toBe(true)
  })
})
