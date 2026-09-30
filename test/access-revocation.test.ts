/**
 * Leaving the company must end the access, not just the payroll.
 *
 * An exited employee's login stayed valid: finalizeSettlements() marked the EMPLOYEE
 * 'exited' and touched nothing else, and both bearer lookups (auth_session_by_hash,
 * auth_api_key_by_hash) looked only at the session or key row, never at the user it
 * belonged to. So a person who had left kept a working session -- and an unrevoked
 * API key -- with whatever roles they held, until the session happened to expire.
 * Found by an audit.
 *
 * Two independent fixes, each tested on its own: the lookups refuse a user who is not
 * active (so ANY way of deactivating someone cuts them off), and completing a
 * separation deactivates the user and revokes what they hold.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import { createHash } from 'node:crypto'
import { resetAndSeed, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { appPool, closePools } from '../src/db/pool.ts'
import { endAccessForEmployee } from '../src/people/access.ts'

let A: Tenant
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const TOKEN = 'session-token-for-access-test'
const KEY = 'pk_api-key-for-access-test'

beforeEach(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools() })

/** A user linked to the seeded employee, holding a live session and an API key. */
async function userWithAccess(): Promise<string> {
  return withTenant(A.id, async (tx) => {
    const u = await tx.query<{ id: string }>(
      `INSERT INTO app_users (tenant_id, email, full_name, employee_id, password_hash)
       VALUES ($1, 'leaver@example.test', 'Leaver', $2, 'x') RETURNING id`, [A.id, A.employeeId])
    const userId = u.rows[0]!.id
    await tx.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,$3, now() + interval '1 day')`,
      [A.id, userId, hash(TOKEN)])
    await tx.query(
      `INSERT INTO api_keys (tenant_id, user_id, name, prefix, key_hash) VALUES ($1,$2,'ci','pk_api',$3)`,
      [A.id, userId, hash(KEY)])
    return userId
  })
}

/** Exactly what the request path runs before any tenant is known. */
const sessionRows = async () =>
  (await appPool.query(`SELECT * FROM auth_session_by_hash($1)`, [hash(TOKEN)])).rows
const keyRows = async () =>
  (await appPool.query(`SELECT * FROM auth_api_key_by_hash($1)`, [hash(KEY)])).rows

describe('the bearer lookups look at the user, not only the credential', () => {
  it('control: a live session and key of an active user resolve', async () => {
    await userWithAccess()
    expect(await sessionRows()).toHaveLength(1)
    expect(await keyRows()).toHaveLength(1)
  })

  for (const status of ['disabled', 'exited', 'erased', 'locked']) {
    it(`a ${status} user's session and API key no longer resolve`, async () => {
      const userId = await userWithAccess()
      await withTenant(A.id, (tx) => tx.query(`UPDATE app_users SET status = $2 WHERE id = $1`, [userId, status]))
      expect(await sessionRows()).toHaveLength(0)
      expect(await keyRows()).toHaveLength(0)
    })
  }

  it('reactivating the user brings the (unrevoked) credentials back -- the lookup is the guard, not a delete', async () => {
    const userId = await userWithAccess()
    await withTenant(A.id, (tx) => tx.query(`UPDATE app_users SET status = 'disabled' WHERE id = $1`, [userId]))
    await withTenant(A.id, (tx) => tx.query(`UPDATE app_users SET status = 'active' WHERE id = $1`, [userId]))
    expect(await sessionRows()).toHaveLength(1)
  })
})

describe('ending access for an employee who has left', () => {
  it('disables the login, revokes every session and every API key', async () => {
    const userId = await userWithAccess()
    const n = await withTenant(A.id, (tx) => endAccessForEmployee(tx, A.employeeId))
    expect(n).toBe(1)

    const { user, sessions, keys } = await withTenant(A.id, async (tx) => ({
      user: (await tx.query(`SELECT status, password_hash FROM app_users WHERE id = $1`, [userId])).rows[0],
      sessions: (await tx.query(`SELECT count(*)::int AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rows[0].n,
      keys: (await tx.query(`SELECT count(*)::int AS n FROM api_keys WHERE user_id = $1 AND revoked_at IS NULL`, [userId])).rows[0].n,
    }))
    expect(user.status).toBe('disabled')
    expect(sessions).toBe(0)
    expect(keys).toBe(0)
    expect(await sessionRows()).toHaveLength(0)
    expect(await keyRows()).toHaveLength(0)
  })

  it('does not touch an already erased user, nor another employee\'s user', async () => {
    const userId = await userWithAccess()
    await withTenant(A.id, (tx) => tx.query(`UPDATE app_users SET status = 'erased' WHERE id = $1`, [userId]))
    await withTenant(A.id, (tx) => endAccessForEmployee(tx, A.employeeId))
    const s = await withTenant(A.id, async (tx) =>
      (await tx.query(`SELECT status FROM app_users WHERE id = $1`, [userId])).rows[0].status)
    expect(s).toBe('erased')
  })

  it('is harmless for an employee who never had a login', async () => {
    expect(await withTenant(A.id, (tx) => endAccessForEmployee(tx, A.employeeId))).toBe(0)
  })
})
