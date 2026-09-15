/**
 * Payslip distribution: locked runs only, one notification per payslip with
 * the PDF attached and stored as the employee's document, idempotent across
 * runs of the job, and a person with no login is reported rather than lost.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import { distributeRun, pendingRuns } from '../src/payroll/distribute.ts'
import { createUser } from '../src/auth/index.ts'
import { listDocuments, readDocument } from '../src/documents/index.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
let A: Tenant
let statutoryId: string
let runId: string
let periodId: string
let userId: string
let loginless: string
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0, esi_employer_rate: 0, esi_gross_threshold_paise: 0n },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}
const row = (employeeId: string) => ({
  employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
  monthlyComponents: { BASIC: L(30_000) }, annualCtcPaise: L(360_000), stateCode: 'TS', pfApplicable: true,
})

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0, 0, 0) RETURNING id`, [String(L(15_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    userId = await createUser(tx, { tenantId: A.id, email: 'rahul@acme.test', fullName: 'Rahul', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    loginless = (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-009','Nologin',DATE '2025-01-01') RETURNING id`, [A.id])).rows[0]!.id
    periodId = (await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])).rows[0]!.id
    runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [row(A.employeeId), row(loginless)], {}, statutoryId)
    await calculate(tx, runId, OPTS)
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('distribution', () => {
  it('refuses an unlocked run', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(distributeRun(tx, { runId })).rejects.toMatchObject({ code: 'RUN_NOT_LOCKED' })
      expect(await pendingRuns(tx)).toEqual([])           // nothing pending: the run is not locked
    })
  })

  it('sends one notification per payslip with the PDF attached, stores it, and never sends twice', async () => {
    await withTenant(A.id, async (tx) => {
      await validate(tx, runId, { ...OPTS, variancePct: 1000 })
      await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
      await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
      expect(await pendingRuns(tx)).toEqual([{ run_id: runId, label: '2026-09', pending: 2 }])

      const r = await distributeRun(tx, { runId, actorUserId: APPROVER })
      expect(r.sent).toBe(1)
      expect(r.failed).toEqual([])
      expect(r.skipped).toEqual([{ employeeNumber: 'A-009', reason: 'no active login to notify' }])

      const note = (await tx.query<{ title: string; channels: string[]; attachment_document_ids: string[]; entity_id: string }>(
        `SELECT title, channels, attachment_document_ids, entity_id::text FROM notifications WHERE user_id = $1 AND event_type = 'payroll.payslip.available'`, [userId])).rows
      expect(note).toHaveLength(1)
      expect(note[0]!.title).toBe('Your payslip for 2026-09')
      expect(note[0]!.channels).toEqual(['in_app', 'email', 'push'])
      expect(note[0]!.attachment_document_ids).toHaveLength(1)

      // the attachment is a real PDF, owned by the employee, marked confidential
      const docs = await listDocuments(tx, { ownerType: 'employee', ownerId: A.employeeId })
      expect(docs).toHaveLength(1)
      expect(docs[0]).toMatchObject({ category: 'payslip', content_type: 'application/pdf', is_confidential: true })
      expect(docs[0]!.id).toBe(note[0]!.attachment_document_ids[0])
      const file = await readDocument(tx, docs[0]!.id)
      expect(file!.bytes.subarray(0, 5).toString()).toBe('%PDF-')

      // a second pass sends nothing more and leaves one document
      const again = await distributeRun(tx, { runId })
      expect(again.sent).toBe(0)
      // the login-less employee is still undelivered, so it is reported again rather than forgotten
      expect(again.skipped).toEqual([{ employeeNumber: 'A-009', reason: 'no active login to notify' }])
      expect(await listDocuments(tx, { ownerType: 'employee', ownerId: A.employeeId })).toHaveLength(1)
      expect((await pendingRuns(tx))[0]!.pending).toBe(1)   // only the login-less employee remains
      const stamped = (await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM payslips WHERE run_id = $1 AND distributed_at IS NOT NULL`, [runId])).rows[0]!.n
      expect(Number(stamped)).toBe(1)

      // the refinement is narrow: money on a locked run is still immutable in the database
      await expect(tx.query(`UPDATE payslips SET net_paise = 1 WHERE run_id = $1`, [runId]))
        .rejects.toThrow(/locked; create a revision instead/)
    })
  })
})
