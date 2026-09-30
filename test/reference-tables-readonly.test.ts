/**
 * The law is not writable by the application role.
 *
 * Statutory rates, professional-tax slabs and exemptions are shared by every
 * company. 099 created `pt_exemptions` and never revoked the default write
 * grant, so the runtime role could INSERT/UPDATE/DELETE it -- and one
 * compromised tenant request could change who is exempt from professional
 * tax for every customer, silently. pt_slabs and statutory_configs were
 * read-only; the newer table alone was not. Found by an audit.
 *
 * The allow-list is the review point: a global table the application may write
 * is a decision that belongs here, in writing, with a reason.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { GLOBAL_TABLES, RUNTIME_WRITABLE_GLOBAL_TABLES as RUNTIME_WRITABLE } from '../src/db/table-classification.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { closePools } from '../src/db/pool.ts'
import { config } from '../src/config.ts'

afterAll(async () => { await closePools(); await controlDb.end() })

describe('global tables and the application role', () => {
  it('grants no write on a global table except the reviewed allow-list', async () => {
    const { rows } = await controlDb.query<{ table_name: string; privilege_type: string }>(
      `SELECT table_name, privilege_type FROM information_schema.role_table_grants
        WHERE table_schema = 'public' AND grantee = $1
          AND privilege_type IN ('INSERT','UPDATE','DELETE','TRUNCATE')
          AND table_name = ANY($2)`,
      [config.appUser, [...GLOBAL_TABLES]])
    const offending = rows.filter((r) => !RUNTIME_WRITABLE.has(r.table_name))
      .map((r) => `${r.table_name}:${r.privilege_type}`)
    expect(offending).toEqual([])
  })

  it('every allow-listed table is really a global table (the list cannot rot)', () => {
    for (const t of RUNTIME_WRITABLE.keys()) expect(GLOBAL_TABLES.has(t)).toBe(true)
  })

  it('pt_exemptions cannot be written through the runtime connection', async () => {
    const { appPool } = await import('../src/db/pool.ts')
    for (const sql of [
      `INSERT INTO pt_exemptions SELECT * FROM pt_exemptions LIMIT 0`,
      `UPDATE pt_exemptions SET state_code = state_code`,
      `DELETE FROM pt_exemptions`,
    ]) {
      await expect(appPool.query(sql), sql).rejects.toThrow(/permission denied/)
    }
    // ...and is still readable, which is what the payroll engine needs.
    await expect(appPool.query(`SELECT count(*) FROM pt_exemptions`)).resolves.toBeTruthy()
  })
})
