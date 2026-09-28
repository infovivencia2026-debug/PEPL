/**
 * The single login form.
 *
 * Everyone signs in at the same place, so the interesting properties are about
 * what the shared front door must NOT do:
 *
 *   - it must not let the browser choose which identity it is signing in as,
 *   - it must not mint a session in the wrong store, and
 *   - it must not let one address exist in both stores, which is what would
 *     make the routing ambiguous in the first place.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { unifiedLogin } from '../src/auth/unified-login.ts'
import { upsertPlatformUser } from '../src/control-plane/platform-auth.ts'
import { signup } from '../src/control-plane/billing.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { closePools, appPool } from '../src/db/pool.ts'

const stamp = Date.now()
const operator = `unified-ops-${stamp}@pepl.test`
const OPERATOR_PASSWORD = 'a-long-operator-passphrase'
const customer = `unified-cust-${stamp}@customerco.test`
const CUSTOMER_PASSWORD = 'a-long-customer-passphrase'
let tenantId: string

beforeAll(async () => {
  await upsertPlatformUser({ email: operator, fullName: 'Unified Operator', password: OPERATOR_PASSWORD })
  const s = await signup({
    legalName: `UnifiedCo ${stamp}`, adminEmail: customer, adminName: 'Unified Admin',
    password: CUSTOMER_PASSWORD, planCode: 'starter', stateCode: 'TS',
  })
  tenantId = s.tenantId
})

afterAll(async () => {
  await controlDb.query(`DELETE FROM control_plane.platform_users WHERE email = $1`, [operator])
  await closePools()
  await controlDb.end()
})

describe('one form, two stores', () => {
  it('sends an operator to the console', async () => {
    const r = await unifiedLogin({ email: operator, password: OPERATOR_PASSWORD })
    expect(r.kind).toBe('platform')
  })

  it('sends a customer into their company', async () => {
    const r = await unifiedLogin({ email: customer, password: CUSTOMER_PASSWORD })
    expect(r.kind).toBe('tenant')
    if (r.kind === 'tenant') expect(r.tenantId).toBe(tenantId)
  })

  it('refuses both the same way, so the form cannot enumerate operators', async () => {
    // A wrong password against an operator address and against an address in
    // neither store must be indistinguishable to whoever is typing.
    const a = await unifiedLogin({ email: operator, password: 'not-the-password' }).catch((e) => e)
    const b = await unifiedLogin({ email: `ghost-${stamp}@nowhere.test`, password: 'not-the-password' }).catch((e) => e)
    expect(a.code).toBe('INVALID_CREDENTIALS')
    expect(b.code).toBe('INVALID_CREDENTIALS')
    expect(a.status).toBe(b.status)
  })
})

describe('an address belongs to one store only', () => {
  it('refuses an operator whose address is already a customer', async () => {
    await expect(upsertPlatformUser({
      email: customer, fullName: 'Impostor', password: 'a-long-impostor-passphrase',
    })).rejects.toThrow()
  })

  it('refuses a customer user whose address is already an operator', async () => {
    // Raw insert on the app role: the guarantee has to hold below the service
    // layer, not inside it.
    const client = await appPool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
      await expect(client.query(
        `INSERT INTO app_users (tenant_id, email, full_name, password_hash) VALUES ($1,$2,$3,$4)`,
        [tenantId, operator, 'Impostor', 'scrypt$x$y'],
      )).rejects.toThrow(/operator/i)
    } finally {
      await client.query('ROLLBACK').catch(() => undefined)
      client.release()
    }
  })
})
