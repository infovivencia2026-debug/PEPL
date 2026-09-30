/**
 * Creating a company from the console must not be able to strand a half-built one.
 *
 * Reported from a screenshot: an operator picked "Education", got "an account
 * with this email already exists; sign in instead", and had two companies called
 * "onrol - ai execution school" sitting in the database, both stuck at status
 * 'running' with an admin who had no password.
 *
 * The chain behind it:
 *   - the console hard-coded five organisation types (company, ngo, school,
 *     hospital, government); the server's presets are office, field_sales,
 *     education, manufacturing, retail, agency. NONE of the five matched, and
 *     the form's DEFAULT ("company") was one of them;
 *   - provisioning found that out only at its `preset` step, after the tenant and
 *     its admin user already existed, and had no error handling: the job stayed
 *     'running', with no error recorded;
 *   - the retry then hit the admin row the failed attempt left behind, and was
 *     told to "sign in instead" for an account that has no password.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { controlDb, provisionTenant } from '../src/control-plane/index.ts'
import { signup } from '../src/control-plane/billing.ts'
import { abandonProvisioning } from '../src/control-plane/abandon.ts'
import { listPresets, validatePreset } from '../src/control-plane/presets.ts'
import { PRESETS, type Preset } from '../db/reference/presets.ts'
import { closePools } from '../src/db/pool.ts'

const stamp = Date.now()
const PASSWORD = 'a-long-customer-passphrase'
let n = 0
const fresh = (label: string) => {
  n += 1
  return { legalName: `OrgType ${label} ${stamp}-${n}`, adminEmail: `${label}-${stamp}-${n}@orgtype.test` }
}

const tenantsNamed = async (legalName: string) =>
  Number((await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM tenants WHERE legal_name = $1`, [legalName])).rows[0]!.n)
const usersWith = async (email: string) =>
  Number((await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM app_users WHERE lower(email) = lower($1)`, [email])).rows[0]!.n)

afterAll(async () => {
  await closePools()
  await controlDb.end()
})

/** A preset that passes the up-front "does it exist" check and fails when applied. */
const BROKEN: Preset = {
  code: 'zz_broken', label: 'Broken', description: 'fails on apply', examples: '',
  settings: { 'no.such.setting': true }, shifts: [], leaveTypes: [],
}
const withBrokenPreset = async (run: () => Promise<void>) => {
  (PRESETS as Preset[]).push(BROKEN)
  try { await run() } finally { (PRESETS as Preset[]).splice((PRESETS as Preset[]).indexOf(BROKEN), 1) }
}

describe('an organisation type the server does not know', () => {
  it('is refused before anything is created', async () => {
    // This is what the console did: it sent "school" and "company".
    for (const type of ['school', 'company', 'hospital', 'ngo-not-a-preset']) {
      const { legalName, adminEmail } = fresh('unknown')
      await expect(signup({
        legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter', organisationType: type,
      }), type).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      // Nothing left behind to block the retry.
      expect(await tenantsNamed(legalName), `${type}: tenant`).toBe(0)
      expect(await usersWith(adminEmail), `${type}: admin`).toBe(0)
    }
  })

  it('names the types that ARE valid, so the operator can correct it', async () => {
    const { legalName, adminEmail } = fresh('hint')
    let message = ''
    try {
      await signup({
        legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter', organisationType: 'school',
      })
    } catch (e) { message = (e as Error).message }
    expect(message).toContain('education')
    expect(message).toContain('manufacturing')
  })
})

describe('a step that fails after the tenant exists', () => {
  it('marks the job failed and records why, instead of leaving it "running"', async () => {
    const { legalName, adminEmail } = fresh('failed-job')
    await withBrokenPreset(async () => {
      await expect(provisionTenant({
        legalName, displayName: legalName, adminEmail, adminName: 'Admin', planCode: 'starter', organisationType: 'zz_broken',
      })).rejects.toThrow()
    })
    const job = (await controlDb.query<{ status: string; last_error: string | null }>(
      `SELECT j.status, j.last_error FROM control_plane.provisioning_jobs j
         JOIN tenants t ON t.id = j.tenant_id WHERE t.legal_name = $1`, [legalName])).rows[0]
    expect(job?.status).toBe('failed')
    expect(job?.last_error).toContain('zz_broken')
  })

  it('does not block the retry: signup cleans up after itself', async () => {
    const { legalName, adminEmail } = fresh('retry')
    await withBrokenPreset(async () => {
      await expect(signup({
        legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter', organisationType: 'zz_broken',
      })).rejects.toThrow()
    })
    // The half-built company and its passwordless admin are gone...
    expect(await tenantsNamed(legalName)).toBe(0)
    expect(await usersWith(adminEmail)).toBe(0)
    // ...so the same operator can simply try again with the same details.
    const again = await signup({
      legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter', organisationType: 'education',
    })
    expect(again.tenantId).toBeTruthy()
  })
})

describe('abandoning a stuck provisioning', () => {
  it('removes the company and frees the address', async () => {
    const { legalName, adminEmail } = fresh('abandon')
    await expect(provisionTenant({
      legalName, displayName: legalName, adminEmail, adminName: 'Admin', planCode: 'starter',
    }, { failAfter: 'admin_user' })).rejects.toThrow()
    const id = (await controlDb.query<{ id: string }>(`SELECT id FROM tenants WHERE legal_name = $1`, [legalName])).rows[0]!.id

    await abandonProvisioning(id)
    expect(await tenantsNamed(legalName)).toBe(0)
    expect(await usersWith(adminEmail)).toBe(0)
  })

  it('refuses a company that finished provisioning', async () => {
    // A completed tenant is a real customer. Deleting one is the failure this
    // guard exists to make impossible.
    const { legalName, adminEmail } = fresh('completed')
    const { tenantId } = await signup({
      legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter',
    })
    await expect(abandonProvisioning(tenantId)).rejects.toMatchObject({ code: 'NOT_ABANDONABLE' })
    expect(await tenantsNamed(legalName)).toBe(1)
  })

  it('refuses a company that already holds people, even if its job never completed', async () => {
    const { legalName, adminEmail } = fresh('has-people')
    await expect(provisionTenant({
      legalName, displayName: legalName, adminEmail, adminName: 'Admin', planCode: 'starter',
    }, { failAfter: 'defaults' })).rejects.toThrow()
    const id = (await controlDb.query<{ id: string }>(`SELECT id FROM tenants WHERE legal_name = $1`, [legalName])).rows[0]!.id
    await controlDb.query(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'X-1','Someone', CURRENT_DATE)`, [id])

    await expect(abandonProvisioning(id)).rejects.toMatchObject({ code: 'NOT_ABANDONABLE' })
    expect(await tenantsNamed(legalName)).toBe(1)
  })
})

describe('the organisation types on offer', () => {
  it('are more than a token few', () => {
    // Reported as "very limited options". Six was the whole list.
    expect(PRESETS.length).toBeGreaterThanOrEqual(12)
  })

  it('cover the kinds of customer this is sold to', () => {
    const codes = PRESETS.map((p) => p.code)
    for (const code of ['office', 'education', 'manufacturing', 'retail', 'healthcare', 'logistics', 'security_facility', 'ngo', 'government', 'bfsi']) {
      expect(codes, code).toContain(code)
    }
  })

  it('have unique codes', () => {
    const codes = PRESETS.map((p) => p.code)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('every one validates against the settings registry', () => {
    // Otherwise it only fails when a customer picks it.
    for (const p of PRESETS) expect(validatePreset(p), p.code).toEqual([])
  })

  it('every one can actually be used to open a company', async () => {
    for (const p of PRESETS) {
      const { legalName, adminEmail } = fresh(`type-${p.code}`)
      const { tenantId } = await signup({
        legalName, adminEmail, adminName: 'Admin', password: PASSWORD, planCode: 'starter', organisationType: p.code,
      })
      const stored = (await controlDb.query<{ organisation_type: string }>(
        `SELECT organisation_type FROM tenants WHERE id = $1`, [tenantId])).rows[0]!.organisation_type
      expect(stored, p.code).toBe(p.code)
    }
  })

  it('are what the picker lists, with a label and who each fits', () => {
    const listed = listPresets()
    expect(listed.map((p) => p.code)).toEqual(PRESETS.map((p) => p.code))
    for (const p of listed) {
      expect(p.label.length, p.code).toBeGreaterThan(3)
      expect(p.examples.length, p.code).toBeGreaterThan(3)
    }
  })
})

describe('the console', () => {
  const source = readFileSync('web/src/admin/AdminApp.tsx', 'utf8')

  it('does not carry its own list of organisation types', () => {
    // The hard-coded list is what drifted: five values, none of them real. The
    // server owns the list and the console asks for it.
    for (const stale of ['value="company"', 'value="ngo"', 'value="school"', 'value="hospital"', 'value="government"']) {
      expect(source, stale).not.toContain(stale)
    }
    expect(source).toContain("'/presets'")
  })
})
