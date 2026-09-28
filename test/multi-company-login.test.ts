/**
 * One person, several companies.
 *
 * This is the riskiest change in the product: the thing standing between two
 * customers is that a session belongs to exactly one tenant and a credential
 * resolves to exactly one account. Relaxing the second must not weaken the
 * first, so these tests are written as the security properties they defend
 * rather than as a feature description.
 *
 * What must remain true:
 *   - A wrong password reveals nothing at all, including whether the address
 *     exists in one company or five.
 *   - Holding an account in company A never lets a session read company B.
 *   - The choice of company happens AFTER the password is proven, never before.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { signup } from '../src/control-plane/billing.ts'
import { login, createUser, completeCompanyChoice, AuthError } from '../src/auth/index.ts'

const stamp = Date.now()
/** The consultant who works for both companies. */
const shared = `consultant-${stamp}@practice.test`
const PASSWORD = 'one-long-shared-passphrase'

let alpha: string
let beta: string

beforeAll(async () => {
  alpha = (await signup({
    legalName: `Alpha Mills ${stamp}`, adminEmail: `alpha-${stamp}@alpha.test`,
    adminName: 'Alpha Admin', password: 'alpha-long-passphrase', planCode: 'starter', stateCode: 'TS',
  })).tenantId
  beta = (await signup({
    legalName: `Beta Looms ${stamp}`, adminEmail: `beta-${stamp}@beta.test`,
    adminName: 'Beta Admin', password: 'beta-long-passphrase', planCode: 'starter', stateCode: 'MH',
  })).tenantId

  // The same person, invited into both. This is the case that could not exist
  // before: the address is now deliberately duplicated across tenants.
  await withTenant(alpha, (tx) => createUser(tx, {
    tenantId: alpha, email: shared, fullName: 'Ramesh Iyer', password: PASSWORD, roles: ['auditor'],
  }))
  await withTenant(beta, (tx) => createUser(tx, {
    tenantId: beta, email: shared, fullName: 'Ramesh Iyer', password: PASSWORD, roles: ['auditor'],
  }))
})

afterAll(async () => {
  await closePools()
  await controlDb.end()
})

describe('an address that belongs to one company still behaves exactly as before', () => {
  it('signs in and gets a session for that company', async () => {
    const r = await login({ email: `alpha-${stamp}@alpha.test`, password: 'alpha-long-passphrase' })
    if ('choose' in r) throw new Error('a single-company address must not be asked to choose')
    expect(r.tenantId).toBe(alpha)
    expect(r.token).toBeTruthy()
  })

  it('a wrong password is refused', async () => {
    await expect(login({ email: `alpha-${stamp}@alpha.test`, password: 'not-the-password' }))
      .rejects.toBeInstanceOf(AuthError)
  })
})

describe('an address that belongs to two companies', () => {
  it('asks which company, and only after the password is proven', async () => {
    const r = await login({ email: shared, password: PASSWORD })
    expect('choose' in r && r.choose).toBe(true)
    if (!('choose' in r)) throw new Error('expected a company choice')
    expect(r.companies).toHaveLength(2)
    expect(r.companies.map((c) => c.tenantId).sort()).toEqual([alpha, beta].sort())
    expect(r.choiceToken).toBeTruthy()
    // No session yet: nothing is signed in until a company is picked.
    expect((r as unknown as { token?: string }).token).toBeUndefined()
  })

  it('tells a wrong password nothing whatsoever', async () => {
    // Not "which company?", not "that address exists twice" — the same refusal
    // anyone gets, or the login form becomes a directory of who banks with us.
    await expect(login({ email: shared, password: 'wrong-but-long-enough' }))
      .rejects.toBeInstanceOf(AuthError)
  })

  it('completing the choice issues a session for the chosen company only', async () => {
    const r = await login({ email: shared, password: PASSWORD })
    if (!('choose' in r)) throw new Error('expected a company choice')
    const session = await completeCompanyChoice({ choiceToken: r.choiceToken, tenantId: beta })
    expect(session.tenantId).toBe(beta)
    expect(session.token).toBeTruthy()
  })

  it('refuses a company the proven password does not open', async () => {
    // The token carries the accounts the password actually matched. Naming a
    // third tenant must not mint a session for it.
    const r = await login({ email: shared, password: PASSWORD })
    if (!('choose' in r)) throw new Error('expected a company choice')
    const stranger = (await signup({
      legalName: `Gamma Yarns ${stamp}`, adminEmail: `gamma-${stamp}@gamma.test`,
      adminName: 'Gamma Admin', password: 'gamma-long-passphrase', planCode: 'starter', stateCode: 'KA',
    })).tenantId
    await expect(completeCompanyChoice({ choiceToken: r.choiceToken, tenantId: stranger }))
      .rejects.toBeInstanceOf(AuthError)
  })

  it('will not accept a made-up choice token', async () => {
    await expect(completeCompanyChoice({ choiceToken: 'not-a-real-token', tenantId: alpha }))
      .rejects.toBeInstanceOf(AuthError)
  })

  it('spends the choice token once', async () => {
    const r = await login({ email: shared, password: PASSWORD })
    if (!('choose' in r)) throw new Error('expected a company choice')
    await completeCompanyChoice({ choiceToken: r.choiceToken, tenantId: alpha })
    await expect(completeCompanyChoice({ choiceToken: r.choiceToken, tenantId: beta }))
      .rejects.toBeInstanceOf(AuthError)
  })
})

describe('the isolation that all of this rests on', () => {
  it('a session for one company cannot read the other, even for the same person', async () => {
    // The whole point. Two memberships, one human, and still nothing crosses.
    const r = await login({ email: shared, password: PASSWORD })
    if (!('choose' in r)) throw new Error('expected a company choice')
    const session = await completeCompanyChoice({ choiceToken: r.choiceToken, tenantId: alpha })
    expect(session.tenantId).toBe(alpha)

    const seenFromAlpha = await withTenant(alpha, async (tx) =>
      (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM app_users WHERE tenant_id = $1`, [beta])).rows[0]!.n)
    expect(Number(seenFromAlpha)).toBe(0)
  })
})
