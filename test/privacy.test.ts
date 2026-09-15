/**
 * DPDP: the export holds everything about the person and nothing secret;
 * erasure waits for the retention clock, anonymises the person, keeps the
 * ledger, and is idempotent. Plus the retention job actually runs now.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { putDocument, listDocuments } from '../src/documents/index.ts'
import { changeCompensation } from '../src/people/history.ts'
import { eligibleForErasure, erasePersonalData, exportPersonalData } from '../src/people/privacy.ts'
import { purgeOldCoordinates, runRetentionPurge } from '../src/jobs/index.ts'

let A: Tenant
let B: Tenant
let userId: string
const L = (r: number): number => r * 100

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await withTenant(A.id, async (tx) => {
    userId = await createUser(tx, { tenantId: A.id, email: 'leaver@acme.test', fullName: 'Lea Ver', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000), components: { basic: L(25_000) }, effectiveFrom: '2026-04-01' })
    await tx.query(`INSERT INTO employee_statutory_ids (tenant_id, employee_id, uan, pan) VALUES ($1,$2,'100123456789','ABCDE1234F')`, [A.id, A.employeeId])
    await tx.query(`INSERT INTO employee_bank_accounts (tenant_id, employee_id, beneficiary_name, account_number, ifsc) VALUES ($1,$2,'Lea Ver','123456789012','HDFC0000001')`, [A.id, A.employeeId])
    await tx.query(`INSERT INTO attendance_punches (tenant_id, employee_id, punched_at, local_date, direction, source, geo_lat, geo_lng)
                    VALUES ($1,$2, now() - interval '200 days', CURRENT_DATE - 200, 'in', 'mobile', 17.385, 78.4867)`, [A.id, A.employeeId])
    await putDocument(tx, { ownerType: 'employee', ownerId: A.employeeId, fileName: 'id.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') })
  })
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('export', () => {
  it('bundles every table about the person, redacts secrets, lists documents', async () => {
    const b = await withTenant(A.id, (tx) => exportPersonalData(tx, A.employeeId))
    expect(b.userId).toBe(userId)
    expect(Object.keys(b.tables).sort()).toEqual(expect.arrayContaining([
      'employees', 'compensation_records', 'employee_statutory_ids', 'employee_bank_accounts', 'attendance_punches', 'app_users', 'user_roles',
    ]))
    expect(b.tables.app_users![0]).not.toHaveProperty('password_hash')
    expect(b.tables.employee_statutory_ids![0]!.pan).toBe('ABCDE1234F')
    expect(b.documents).toHaveLength(1)
    expect(b.documents[0]!.file_name).toBe('id.pdf')
    // nothing about anyone else, and nothing from another tenant
    for (const rows of Object.values(b.tables)) for (const r of rows) {
      const id = (r.employee_id ?? r.id) as string
      if (r.employee_id) expect(id).toBe(A.employeeId)
    }
    await withTenant(B.id, async (tx) => {
      const other = await exportPersonalData(tx, A.employeeId)
      expect(Object.keys(other.tables)).toEqual([])
    })
  })
})

describe('retention', () => {
  it('the nightly job blanks old coordinates (it used to fail on a missing grant)', async () => {
    const r = await runRetentionPurge()
    expect(r.errors).toEqual([])          // no tenant answers 'permission denied' any more
    expect(await withTenant(A.id, (tx) => purgeOldCoordinates(tx))).toBe(1)
    const { rows } = await withTenant(A.id, (tx) => tx.query<{ geo_lat: string | null }>(
      `SELECT geo_lat FROM attendance_punches WHERE employee_id = $1`, [A.employeeId]))
    expect(rows[0]!.geo_lat).toBeNull()
  })
})

describe('erasure', () => {
  it('refuses while the person is active or inside retention, with the reason', async () => {
    await withTenant(A.id, async (tx) => {
      expect(await eligibleForErasure(tx, A.employeeId, 30)).toMatchObject({ ok: false, reason: expect.stringMatching(/not left/) })
      await tx.query(`UPDATE employees SET status = 'exited', date_of_exit = CURRENT_DATE - 10 WHERE id = $1`, [A.employeeId])
      expect(await eligibleForErasure(tx, A.employeeId, 30)).toMatchObject({ ok: false, reason: expect.stringMatching(/retention runs until/) })
      await expect(erasePersonalData(tx, { employeeId: A.employeeId, reason: 'x', actorUserId: userId, afterDays: 30 }))
        .rejects.toMatchObject({ code: 'NOT_ERASABLE' })
      await expect(erasePersonalData(tx, { employeeId: A.employeeId, reason: '  ', actorUserId: userId, afterDays: 5 }))
        .rejects.toMatchObject({ code: 'REASON_REQUIRED' })
      expect(await eligibleForErasure(tx, A.employeeId, 5)).toEqual({ ok: true })
    })
  })

  it('anonymises the person, keeps the ledger rows, kills the login, and is idempotent', async () => {
    const result = await withTenant(A.id, (tx) =>
      erasePersonalData(tx, { employeeId: A.employeeId, reason: 'request #1', actorUserId: userId, afterDays: 5 }))
    expect(result.anonymised).toMatchObject({ employees: 1, employee_bank_accounts: 1, employee_statutory_ids: 1, documents: 1, app_users: 1, user_roles: 1 })

    await withTenant(A.id, async (tx) => {
      const emp = (await tx.query<{ first_name: string; last_name: string; erased: boolean }>(
        `SELECT first_name, last_name, erased_at IS NOT NULL AS erased FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!
      expect(emp).toEqual({ first_name: 'Erased', last_name: 'employee', erased: true })
      const user = (await tx.query<{ email: string; status: string; password_hash: string | null }>(
        `SELECT email, status, password_hash FROM app_users WHERE id = $1`, [userId])).rows[0]!
      expect(user.status).toBe('erased')
      expect(user.password_hash).toBeNull()
      expect(user.email).toMatch(/^erased-.*@invalid\.local$/)
      const ids = (await tx.query<{ pan: string | null; uan: string | null }>(`SELECT pan, uan FROM employee_statutory_ids WHERE employee_id = $1`, [A.employeeId])).rows[0]!
      expect(ids).toEqual({ pan: null, uan: null })
      const bank = (await tx.query<{ account_number: string }>(`SELECT account_number FROM employee_bank_accounts WHERE employee_id = $1`, [A.employeeId])).rows[0]!
      expect(bank.account_number).toBe('XXXX9012')
      expect(await listDocuments(tx, { ownerType: 'employee', ownerId: A.employeeId })).toEqual([])
      // the compensation record — a ledger fact — is untouched
      expect((await tx.query(`SELECT 1 FROM compensation_records WHERE employee_id = $1`, [A.employeeId])).rowCount).toBe(1)

      // a second erasure is refused as already done, and changes nothing
      expect(await eligibleForErasure(tx, A.employeeId, 5)).toMatchObject({ ok: false, reason: 'already erased' })
    })
  })
})
