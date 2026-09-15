/**
 * Approval policy: the most specific policy picks the chain, approvers resolve
 * from the reporting line, roles and the department master, a delegation
 * redirects a step and is recorded, and stale steps escalate but never the
 * last one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { createUnit, updateUnit } from '../src/people/org.ts'
import { act } from '../src/approvals/index.ts'
import {
  chooseChain, createDelegation, createPolicy, escalateStale, listPolicies, raiseWithPolicy, resolveApprovers, retirePolicy,
} from '../src/approvals/policy.ts'

let A: Tenant
let ids: Record<string, string> = {}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    const emp = async (n: string) => (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,$2,DATE '2025-01-01') RETURNING id`, [A.id, n])).rows[0]!.id
    ids.mgrEmp = await emp('MGR')
    ids.mgr = await createUser(tx, { tenantId: A.id, email: 'mgr@a.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: ids.mgrEmp })
    ids.hr = await createUser(tx, { tenantId: A.id, email: 'hr@a.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    ids.fin = await createUser(tx, { tenantId: A.id, email: 'fin@a.test', fullName: 'Fin', password: 'a-long-password-1', roles: ['finance'] })
    ids.head = await createUser(tx, { tenantId: A.id, email: 'head@a.test', fullName: 'Head', password: 'a-long-password-1', roles: ['manager'] })
    ids.deputy = await createUser(tx, { tenantId: A.id, email: 'dep@a.test', fullName: 'Deputy', password: 'a-long-password-1', roles: ['manager'] })
    ids.self = await createUser(tx, { tenantId: A.id, email: 'me@a.test', fullName: 'Me', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    const sales = await createUnit(tx, { kind: 'department', code: 'SALES', name: 'Sales' })
    await updateUnit(tx, sales.id, { attributes: { headUserId: ids.head } })
    // the fixture already assigned the employee; move them into Sales under the manager
    await tx.query(`UPDATE employee_assignments SET department = 'SALES', manager_employee_id = $2 WHERE employee_id = $1 AND superseded_at IS NULL`, [A.employeeId, ids.mgrEmp])
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('policies choose the chain', () => {
  it('company-wide by threshold, department beats company, retired ignored, fallback otherwise', async () => {
    await withTenant(A.id, async (tx) => {
      expect(await chooseChain(tx, { entityType: 'leave', magnitude: 3, fallback: 'manager' })).toEqual({ chainCode: 'manager', policyId: null })
      const any = await createPolicy(tx, { entityType: 'leave', chainCode: 'manager' })
      const big = await createPolicy(tx, { entityType: 'leave', chainCode: 'manager_then_hr', minMagnitude: 5 })
      const salesBig = await createPolicy(tx, { entityType: 'leave', chainCode: 'manager_dept_head', minMagnitude: 5, departmentCode: 'sales' })
      await expect(createPolicy(tx, { entityType: 'leave', chainCode: 'manager', minMagnitude: 5 })).rejects.toMatchObject({ code: 'POLICY_EXISTS' })
      await expect(createPolicy(tx, { entityType: 'leave', chainCode: 'manager', departmentCode: 'GHOST' })).rejects.toMatchObject({ code: 'UNKNOWN_UNIT' })
      await expect(createPolicy(tx, { entityType: 'leave', chainCode: 'draw_me' as never })).rejects.toMatchObject({ code: 'UNKNOWN_CHAIN' })

      expect((await chooseChain(tx, { entityType: 'leave', magnitude: 2, fallback: 'hr_only' })).policyId).toBe(any.id)
      expect((await chooseChain(tx, { entityType: 'leave', magnitude: 7, fallback: 'hr_only' })).policyId).toBe(big.id)
      expect((await chooseChain(tx, { entityType: 'leave', magnitude: 7, departmentCode: 'SALES', fallback: 'hr_only' })).chainCode).toBe('manager_dept_head')
      expect((await chooseChain(tx, { entityType: 'leave', magnitude: 2, departmentCode: 'SALES', fallback: 'hr_only' })).policyId).toBe(any.id)   // dept policy needs ≥5
      await retirePolicy(tx, salesBig.id)
      expect((await chooseChain(tx, { entityType: 'leave', magnitude: 7, departmentCode: 'SALES', fallback: 'hr_only' })).policyId).toBe(big.id)
      expect((await listPolicies(tx, 'leave')).length).toBe(2)
      expect((await listPolicies(tx, 'leave', true)).length).toBe(3)
      // another entity type falls back
      expect(await chooseChain(tx, { entityType: 'compensation', magnitude: 1e9, fallback: 'manager_hr_finance' })).toMatchObject({ chainCode: 'manager_hr_finance', policyId: null })
    })
  })
})

describe('approvers and delegation', () => {
  it('resolves manager, dept head, hr and finance; a delegation redirects and is recorded on the step', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await resolveApprovers(tx, A.employeeId, '2026-12-01')
      expect(r).toEqual({ approvers: { manager: ids.mgr, dept_head: ids.head, hr: ids.hr, finance: ids.fin }, delegatedFrom: {}, departmentCode: 'SALES' })

      await expect(createDelegation(tx, { fromUserId: ids.mgr!, toUserId: ids.mgr!, fromDate: '2026-12-20', toDate: '2026-12-31' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createDelegation(tx, { fromUserId: ids.mgr!, toUserId: ids.deputy!, fromDate: '2026-01-01', toDate: '2026-12-31' })).rejects.toThrow(/90 days/)
      await createDelegation(tx, { fromUserId: ids.mgr!, toUserId: ids.deputy!, fromDate: '2026-12-20', toDate: '2027-01-03', reason: 'leave' })

      const during = await resolveApprovers(tx, A.employeeId, '2026-12-25')
      expect(during.approvers.manager).toBe(ids.deputy)
      expect(during.delegatedFrom).toEqual({ manager: ids.mgr })
      expect((await resolveApprovers(tx, A.employeeId, '2027-02-01')).approvers.manager).toBe(ids.mgr)

      // raised today (no delegation active): manager_then_hr for 7 days, manager first
      const raised = await raiseWithPolicy(tx, { entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: ids.self!,
        subjectEmployeeId: A.employeeId, magnitude: 7, fallback: 'manager', title: 'Leave · 7 days' })
      expect(raised.chainCode).toBe('manager_then_hr')
      const steps = (await tx.query<{ step_no: number; approver_user_id: string; status: string }>(
        `SELECT step_no, approver_user_id, status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no`, [raised.requestId])).rows
      expect(steps.map((s) => [s.approver_user_id, s.status])).toEqual([[ids.mgr, 'pending'], [ids.hr, 'pending']])
      // the manager approves, then HR
      await act(tx, { requestId: raised.requestId, actorUserId: ids.mgr!, action: 'approve' })
      const done = await act(tx, { requestId: raised.requestId, actorUserId: ids.hr!, action: 'approve' })
      expect(done.status).toBe('approved')
    })
  })
})

describe('everyone is told', () => {
  it('each approver when their step is current, the requester on every decision, once each', async () => {
    await withTenant(A.id, async (tx) => {
      const count = async (userId: string, type?: string) => Number((await tx.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND ($2::text IS NULL OR event_type = $2)`, [userId, type ?? null])).rows[0]!.n)
      const mgrBefore = await count(ids.mgr!, 'approval.requested')
      const hrBefore = await count(ids.hr!, 'approval.requested')
      const selfApproved = await count(ids.self!, 'approval.approved')
      const r = await raiseWithPolicy(tx, { entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: ids.self!,
        subjectEmployeeId: A.employeeId, magnitude: 8, fallback: 'manager', title: 'Leave · 8 days' })
      expect(r.chainCode).toBe('manager_then_hr')
      expect(await count(ids.mgr!, 'approval.requested')).toBe(mgrBefore + 1)     // manager's turn
      expect(await count(ids.hr!, 'approval.requested')).toBe(hrBefore)            // HR not yet
      const { rows } = await tx.query<{ title: string; entity_id: string }>(
        `SELECT title, entity_id FROM notifications WHERE user_id = $1 AND event_type = 'approval.requested' ORDER BY created_at DESC LIMIT 1`, [ids.mgr])
      expect(rows[0]).toEqual({ title: 'Approval needed: Leave · 8 days', entity_id: r.requestId })

      // send back: requester told; manager approves after resubmit -> HR told exactly once for the step
      await act(tx, { requestId: r.requestId, actorUserId: ids.mgr!, action: 'send_back', comment: 'dates?' })
      expect(await count(ids.self!, 'approval.sent_back')).toBe(1)
      await act(tx, { requestId: r.requestId, actorUserId: ids.mgr!, action: 'approve' })
      expect(await count(ids.hr!, 'approval.requested')).toBe(hrBefore + 1)
      expect(await count(ids.self!, 'approval.approved')).toBe(selfApproved)        // not final yet
      await act(tx, { requestId: r.requestId, actorUserId: ids.hr!, action: 'approve' })
      expect(await count(ids.self!, 'approval.approved')).toBe(selfApproved + 1)

      // a rejection tells the requester
      const r2 = await raiseWithPolicy(tx, { entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: ids.self!,
        subjectEmployeeId: A.employeeId, magnitude: 1, fallback: 'manager', title: 'Leave · 1 day' })
      await act(tx, { requestId: r2.requestId, actorUserId: ids.mgr!, action: 'reject', comment: 'no' })
      expect(await count(ids.self!, 'approval.rejected')).toBe(1)
    })
  })
})

describe('escalation', () => {
  it('skips a stale non-final step and moves on; never the last one', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await raiseWithPolicy(tx, { entityType: 'leave', entityId: crypto.randomUUID(), requestedByUserId: ids.self!,
        subjectEmployeeId: A.employeeId, magnitude: 10, fallback: 'manager', title: 'Leave · 10 days' })
      // age the request by four days
      await tx.query(`UPDATE approval_requests SET created_at = now() - interval '4 days' WHERE id = $1`, [r.requestId])
      expect(await escalateStale(tx, 0)).toBe(0)                    // off
      expect(await escalateStale(tx, 5)).toBe(0)                    // not stale yet
      expect(await escalateStale(tx, 3)).toBe(1)                    // manager skipped, HR now current
      const req = (await tx.query<{ current_step: number; status: string }>(`SELECT current_step, status FROM approval_requests WHERE id = $1`, [r.requestId])).rows[0]!
      expect(req).toEqual({ current_step: 2, status: 'pending' })
      const first = (await tx.query<{ status: string; escalated: boolean }>(
        `SELECT status, escalated_at IS NOT NULL AS escalated FROM approval_steps WHERE approval_request_id = $1 AND step_no = 1`, [r.requestId])).rows[0]!
      expect(first).toEqual({ status: 'skipped', escalated: true })
      // HR is the last approver: another pass leaves it alone however stale
      expect(await escalateStale(tx, 1)).toBe(0)
    })
  })
})
