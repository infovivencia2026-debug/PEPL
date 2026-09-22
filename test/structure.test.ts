/**
 * Org structure (B4): the chart is derived from reporting lines; positions
 * count seats and refuse over-seating; a transfer is approved and lands as an
 * assignment change on its date (immediately when due, by the job when not);
 * a profile change request applies through updateEmployee on approval.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { act } from '../src/approvals/index.ts'
import { settleDecision } from '../src/approvals/settle.ts'
import { currentPosting } from '../src/people/profile.ts'
import { orgChart, reportingLine, upsertPosition, listPositions, seatEmployee, setPositionStatus, headcountByPosition, requestTransfer, listTransfers, applyDueTransfers, requestProfileChange, decideProfileChange, listProfileChanges } from '../src/people/structure.ts'

let A: Tenant
let ceo: string; let mgr: string; let mgrUser: string; let hrUser: string; let empUser: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    ceo = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-CEO','Ceo',DATE '2020-01-01') RETURNING id`, [A.id])).rows[0]!.id
    mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-MGR','Mgr',DATE '2022-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Leadership','CEO',DATE '2020-01-01')`, [A.id, ceo])
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from, manager_employee_id) VALUES ($1,$2,'Engineering','Manager',DATE '2022-01-01',$3)`, [A.id, mgr, ceo])
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, mgr])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'smgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'shr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'semp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('org chart and positions', () => {
  it('derives the tree from reporting lines and walks the line upward', async () => {
    await withTenant(A.id, async (tx) => {
      const chart = await orgChart(tx, {})
      expect(chart.total).toBe(3)
      expect(chart.roots.map((r) => r.name)).toEqual(['Ceo'])
      expect(chart.roots[0]!.reports[0]).toMatchObject({ name: 'Mgr', directReports: 1 })
      expect(chart.roots[0]!.reports[0]!.reports[0]!.employeeId).toBe(A.employeeId)
      const sub = await orgChart(tx, { rootEmployeeId: mgr })
      expect(sub.roots[0]!.name).toBe('Mgr')
      expect((await reportingLine(tx, A.employeeId)).map((l) => l.name)).toEqual(['Mgr', 'Ceo'])
    })
  })

  it('positions have seats; seating beyond capacity is refused; a held position cannot close', async () => {
    await withTenant(A.id, async (tx) => {
      const pos = await upsertPosition(tx, { code: 'eng-dev', title: 'Developer', department: 'Engineering', designation: 'Developer', seats: 1 })
      expect(pos).toMatchObject({ code: 'ENG-DEV', seats: 1, filled: 0 })
      await seatEmployee(tx, { employeeId: A.employeeId, positionId: pos.id })
      await seatEmployee(tx, { employeeId: A.employeeId, positionId: pos.id })   // same person again: fine
      await expect(seatEmployee(tx, { employeeId: mgr, positionId: pos.id })).rejects.toMatchObject({ code: 'POSITION_FULL' })
      expect((await listPositions(tx, { vacantOnly: true })).length).toBe(0)
      await expect(setPositionStatus(tx, pos.id, 'closed')).rejects.toMatchObject({ code: 'POSITION_OCCUPIED' })
      await upsertPosition(tx, { code: 'ENG-DEV', title: 'Developer', department: 'Engineering', designation: 'Developer', seats: 3 })
      expect(await headcountByPosition(tx)).toMatchObject({ seats: 3, filled: 1, vacant: 2 })
    })
  })
})

describe('transfers', () => {
  it('is approved through the engine and lands as an assignment change; a future date waits for the job', async () => {
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      await expect(requestTransfer(tx, cfg, { employeeId: A.employeeId, effectiveFrom: '2026-10-01', reason: 'x', requestedByUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // nothing changes
      const t = await requestTransfer(tx, cfg, { employeeId: A.employeeId, effectiveFrom: '2026-01-15', department: 'Sales', locationCode: 'BLR', managerEmployeeId: ceo, reason: 'Business need', requestedByUserId: empUser })
      expect(t.status).toBe('pending')
      await expect(requestTransfer(tx, cfg, { employeeId: A.employeeId, effectiveFrom: '2026-02-01', department: 'Ops', reason: 'again', requestedByUserId: empUser })).rejects.toMatchObject({ code: 'TRANSFER_OPEN' })
      // chain manager_then_hr: the manager (of Rahul) approves, then HR
      await act(tx, { requestId: t.approval_request_id!, actorUserId: mgrUser, action: 'approve' })
      const hrApprover = (await tx.query<{ approver_user_id: string; status: string }>(`SELECT approver_user_id, status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no`, [t.approval_request_id])).rows
      expect(hrApprover.map((s) => s.status)).toEqual(['approved', 'pending'])
      await act(tx, { requestId: t.approval_request_id!, actorUserId: hrApprover[1]!.approver_user_id, action: 'approve' })
      await settleDecision(tx, cfg, { requestId: t.approval_request_id!, status: 'approved', actorUserId: hrUser })
      // the date is in the past → applied at once
      expect((await listTransfers(tx, { employeeId: A.employeeId }))[0]!.status).toBe('applied')
      const posting = await currentPosting(tx, A.employeeId)
      expect(posting).toMatchObject({ department: 'Sales', location_code: 'BLR', manager_employee_id: ceo, designation: 'Senior Developer' })   // designation unchanged
      // a future one waits
      const future = await requestTransfer(tx, cfg, { employeeId: mgr, effectiveFrom: '2099-01-01', department: 'Sales', reason: 'later', requestedByUserId: hrUser })
      const steps = (await tx.query<{ approver_user_id: string | null; status: string }>(`SELECT approver_user_id, status FROM approval_steps WHERE approval_request_id = $1 ORDER BY step_no`, [future.approval_request_id])).rows
      for (const s of steps) if (s.status === 'pending' && s.approver_user_id) await act(tx, { requestId: future.approval_request_id!, actorUserId: s.approver_user_id, action: 'approve' })
      await settleDecision(tx, cfg, { requestId: future.approval_request_id!, status: 'approved', actorUserId: hrUser })
      expect((await listTransfers(tx, { employeeId: mgr }))[0]!.status).toBe('approved')
      expect(await applyDueTransfers(tx, '2098-12-31')).toBe(0)
      expect(await applyDueTransfers(tx, '2099-01-01')).toBe(1)
      expect((await currentPosting(tx, mgr, '2099-01-01'))!.department).toBe('Sales')
    })
  })
})

describe('profile change requests', () => {
  it('an employee proposes; HR approves into the record or rejects with a reason; one at a time', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(requestProfileChange(tx, { employeeId: A.employeeId, changes: { employmentType: 'permanent' } as never })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const r = await requestProfileChange(tx, { employeeId: A.employeeId, changes: { lastName: 'Sharma-Rao', dateOfBirth: '1991-03-04' }, note: 'Marriage certificate attached' })
      expect(r.status).toBe('pending')
      await expect(requestProfileChange(tx, { employeeId: A.employeeId, changes: { phone: '+91 90000 00000' } })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_OPEN' })
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'profile.change.requested'`, [hrUser])).rows[0]!.n).toBe('1')
      await expect(decideProfileChange(tx, { requestId: r.id, approve: false, actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // a refusal says why
      const done = await decideProfileChange(tx, { requestId: r.id, approve: true, actorUserId: hrUser })
      expect(done.status).toBe('approved')
      const e = (await tx.query<{ last_name: string; date_of_birth: string }>(`SELECT last_name, date_of_birth::text FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!
      expect(e).toEqual({ last_name: 'Sharma-Rao', date_of_birth: '1991-03-04' })
      await expect(decideProfileChange(tx, { requestId: r.id, approve: true, actorUserId: hrUser })).rejects.toMatchObject({ code: 'CHANGE_REQUEST_DECIDED' })
      const r2 = await requestProfileChange(tx, { employeeId: A.employeeId, changes: { phone: 'not a number' } })
      const no = await decideProfileChange(tx, { requestId: r2.id, approve: false, actorUserId: hrUser, note: 'Not a valid number' })
      expect(no.status).toBe('rejected')
      expect((await listProfileChanges(tx, { employeeId: A.employeeId })).map((x) => x.status).sort()).toEqual(['approved', 'rejected'])
    })
  })
})
