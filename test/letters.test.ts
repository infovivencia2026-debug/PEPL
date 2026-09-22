/**
 * Letters: defaults seed once per tenant; merge fields come from the record
 * and custom.* from the caller; an unknown field is refused at template time;
 * issuing files a PDF under the person's documents with a reference number
 * and tells them. Probation: the job opens a review ahead of probation_end,
 * confirming makes the employment permanent and issues the letter, extending
 * moves the end date, and a decided review cannot be decided twice.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeCompensation } from '../src/people/history.ts'
import { listTemplates, upsertTemplate, previewLetter, issueLetter, listIssued, rupeesInWords, openDueProbationReviews, listProbationReviews, decideProbation } from '../src/people/letters.ts'

let A: Tenant
let hrUser: string; let manager: string; let mgrUser: string; let empUser: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-LMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    await tx.query(`UPDATE employees SET employment_type = 'probation', probation_end = DATE '2026-10-01', address = '{"line1":"12 MG Road","city":"Bengaluru","state":"KA","pincode":"560001"}'::jsonb WHERE id = $1`, [A.employeeId])
    hrUser = await createUser(tx, { tenantId: A.id, email: 'lhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'lmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    empUser = await createUser(tx, { tenantId: A.id, email: 'lemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: 1_250_000_00, components: { BASIC: 52_083_00 }, effectiveFrom: '2026-01-01', reason: 'seed', actorUserId: hrUser })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('templates and merge', () => {
  it('seeds defaults once, spells rupees the Indian way, refuses unknown fields, merges the record', async () => {
    expect(rupeesInWords(1_250_000_00n)).toBe('Rupees Twelve Lakh Fifty Thousand only')
    expect(rupeesInWords(1_00_00_000_00n)).toBe('Rupees One Crore only')
    expect(rupeesInWords(4_05_099_00n)).toBe('Rupees Four Lakh Five Thousand Ninety Nine only')
    await withTenant(A.id, async (tx) => {
      const first = await listTemplates(tx)
      expect(first.map((t) => t.code).sort()).toEqual(['address_proof', 'appointment', 'confirmation', 'experience', 'increment', 'salary_certificate', 'warning'])
      expect((await listTemplates(tx)).length).toBe(7)                       // not seeded twice
      await expect(upsertTemplate(tx, { code: 'x', name: 'X', title: 'X', body: 'Hello {{employee.shoe_size}}' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await upsertTemplate(tx, { code: 'transfer', name: 'Transfer', title: 'TRANSFER ORDER', body: 'Dear {{employee.first_name}}, you move to {{custom.new_location}}.' })
      expect((await listTemplates(tx)).length).toBe(8)

      const p = await previewLetter(tx, { code: 'salary_certificate', employeeId: A.employeeId })
      expect(p.text).toContain('₹12,50,000 (Rupees Twelve Lakh Fifty Thousand only)')
      expect(p.text).toContain('₹1,04,167 per month')
      expect(p.text).toContain('Alpha')                                        // company display name
      expect(p.missing).toEqual(['custom.purpose'])
      const filled = await previewLetter(tx, { code: 'address_proof', employeeId: A.employeeId, custom: { purpose: 'a passport application' } })
      expect(filled.text).toContain('12 MG Road, Bengaluru, KA, 560001')
      expect(filled.missing).toEqual([])
    })
  })

  it('issues a PDF into the documents with a reference number and tells the employee; the missing field is refused', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(issueLetter(tx, { code: 'salary_certificate', employeeId: A.employeeId, actorUserId: hrUser })).rejects.toMatchObject({ code: 'MERGE_INCOMPLETE' })
      const r = await issueLetter(tx, { code: 'salary_certificate', employeeId: A.employeeId, custom: { purpose: 'a housing loan' }, actorUserId: hrUser, signatory: 'Priya Sharma' })
      expect(r.letter.reference_no).toMatch(/^ALPH\/HR\/\d{4}\/0001$/)
      expect(r.document).toMatchObject({ content_type: 'application/pdf', category: 'salary_revision', is_confidential: true })
      const again = await issueLetter(tx, { code: 'experience', employeeId: A.employeeId, custom: { last_day: '31 October 2026' }, actorUserId: hrUser })
      expect(again.letter.reference_no.endsWith('/0002')).toBe(true)
      expect((await listIssued(tx, { employeeId: A.employeeId })).map((l) => l.code)).toEqual(['experience', 'salary_certificate'])
      const told = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'letter.issued'`, [empUser])).rows[0]!.n
      expect(Number(told)).toBe(2)
      await expect(tx.query(`DELETE FROM issued_letters WHERE id = $1`, [r.letter.id])).rejects.toThrow(/permission denied/)   // an issued letter is a record
    })
  })
})

describe('probation', () => {
  it('the job opens a review ahead of the end date once; confirming issues the letter and makes the employment permanent', async () => {
    await withTenant(A.id, async (tx) => {
      expect(await openDueProbationReviews(tx, 14, '2026-09-01')).toBe(0)     // a month early: nothing
      expect(await openDueProbationReviews(tx, 14, '2026-09-20')).toBe(1)
      expect(await openDueProbationReviews(tx, 14, '2026-09-21')).toBe(0)     // idempotent
      const [rev] = await listProbationReviews(tx, { status: 'pending' })
      expect(rev).toMatchObject({ employee_id: A.employeeId, reviewer_employee_id: manager, probation_end: '2026-10-01' })
      for (const u of [mgrUser, hrUser]) {
        const n = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'probation.review.due'`, [u])).rows[0]!.n
        expect(Number(n)).toBe(1)
      }
      await expect(decideProbation(tx, { reviewId: rev!.id, decision: 'extend', actorUserId: mgrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })            // needs remarks
      await expect(decideProbation(tx, { reviewId: rev!.id, decision: 'extend', remarks: 'x', extendedTo: '2026-09-01', actorUserId: mgrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const done = await decideProbation(tx, { reviewId: rev!.id, decision: 'confirm', rating: 4, remarks: 'Meets expectations', actorUserId: mgrUser })
      expect(done.status).toBe('confirmed')
      expect(done.letter_id).toBeTruthy()
      const e = (await tx.query<{ employment_type: string; confirmed_on: string }>(`SELECT employment_type, confirmed_on::text FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!
      expect(e).toEqual({ employment_type: 'permanent', confirmed_on: '2026-10-01' })
      expect((await listIssued(tx, { employeeId: A.employeeId, code: 'confirmation' })).length).toBe(1)
      await expect(decideProbation(tx, { reviewId: rev!.id, decision: 'extend', remarks: 'x', extendedTo: '2026-12-01', actorUserId: hrUser })).rejects.toMatchObject({ code: 'REVIEW_DECIDED' })
    })
  })

  it('extending moves the end date and the next job run opens a new review for it', async () => {
    await withTenant(A.id, async (tx) => {
      await tx.query(`UPDATE employees SET employment_type = 'probation', probation_end = DATE '2026-11-15', confirmed_on = NULL WHERE id = $1`, [A.employeeId])
      expect(await openDueProbationReviews(tx, 14, '2026-11-05')).toBe(1)
      const [rev] = await listProbationReviews(tx, { status: 'pending' })
      const ext = await decideProbation(tx, { reviewId: rev!.id, decision: 'extend', remarks: 'Needs another quarter', extendedTo: '2027-02-15', actorUserId: hrUser })
      expect(ext).toMatchObject({ status: 'extended', extended_to: '2027-02-15' })
      expect((await tx.query<{ p: string }>(`SELECT probation_end::text AS p FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!.p).toBe('2027-02-15')
      expect(await openDueProbationReviews(tx, 14, '2026-11-06')).toBe(0)     // not due yet
      expect(await openDueProbationReviews(tx, 14, '2027-02-05')).toBe(1)     // the extended end comes due
    })
  })
})
