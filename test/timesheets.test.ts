/**
 * Projects and timesheets: allocations capped at 100%, hours booked only on
 * allocated active projects and never over 24 a day, a week submitted whole
 * and approved through the engine, approved hours in the report, a rejected
 * week editable again, and the daily work log.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeAssignment } from '../src/people/history.ts'
import { act } from '../src/approvals/index.ts'
import {
  upsertProject, listProjects, allocate, listAllocations, endAllocation, weekStartOf,
  getWeek, setHours, submitWeek, settleTimesheetDecision, hoursReport, writeWorkLog, listWorkLogs,
} from '../src/work/timesheets.ts'

let A: Tenant
let manager: string; let managerUser: string; let empUser: string
let erp: string; let internal: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-MGR','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    managerUser = await createUser(tx, { tenantId: A.id, email: 'mgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    empUser = await createUser(tx, { tenantId: A.id, email: 'emp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await changeAssignment(tx, { employeeId: A.employeeId, department: 'Engineering', designation: 'Dev', managerEmployeeId: manager, effectiveFrom: '2026-06-01' })
    erp = (await upsertProject(tx, { code: 'acme-erp', name: 'Acme ERP', client: 'Acme', billable: true, billRatePaisePerHour: 250_000, budgetHours: 100 })).id
    internal = (await upsertProject(tx, { code: 'INT', name: 'Internal', kind: 'internal', billable: false })).id
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('projects and allocations', () => {
  it('codes are normalised, allocation is capped at 100%, a new allocation closes the old one', async () => {
    await withTenant(A.id, async (tx) => {
      expect((await listProjects(tx)).map((p) => p.code).sort()).toEqual(['ACME-ERP', 'INT'])
      await allocate(tx, { projectId: erp, employeeId: A.employeeId, role: 'Developer', percent: 60, startsOn: '2026-09-01' })
      await expect(allocate(tx, { projectId: internal, employeeId: A.employeeId, percent: 50, startsOn: '2026-09-01' })).rejects.toMatchObject({ code: 'OVER_ALLOCATED' })
      await allocate(tx, { projectId: internal, employeeId: A.employeeId, percent: 40, startsOn: '2026-09-01' })
      // re-allocating on the same project closes the earlier row the day before
      await allocate(tx, { projectId: erp, employeeId: A.employeeId, role: 'Lead', percent: 60, startsOn: '2026-10-01' })
      const mine = await listAllocations(tx, { employeeId: A.employeeId })
      const erpRows = mine.filter((a) => a.project_id === erp).sort((a, b) => a.starts_on.localeCompare(b.starts_on))
      expect(erpRows.map((a) => [a.starts_on, a.ends_on, a.role])).toEqual([['2026-09-01', '2026-09-30', 'Developer'], ['2026-10-01', null, 'Lead']])
      expect((await listProjects(tx, { employeeId: A.employeeId })).map((p) => p.code).sort()).toEqual(['ACME-ERP', 'INT'])
    })
  })
})

describe('timesheets', () => {
  it('hours book only where allocated, never over 24 a day; the week submits whole; approval makes the hours count', async () => {
    await withTenant(A.id, async (tx) => {
      expect(weekStartOf('2026-09-09')).toBe('2026-09-07')       // Wednesday → Monday
      expect(weekStartOf('2026-09-07')).toBe('2026-09-07')
      const other = (await upsertProject(tx, { code: 'OTHER', name: 'Not mine' })).id
      await expect(setHours(tx, { employeeId: A.employeeId, projectId: other, workDate: '2026-09-08', hours: 2 })).rejects.toMatchObject({ code: 'NOT_ALLOCATED' })
      await expect(setHours(tx, { employeeId: A.employeeId, projectId: erp, workDate: '2026-08-20', hours: 2 })).rejects.toMatchObject({ code: 'NOT_ALLOCATED' })   // before the allocation
      let sheet = await setHours(tx, { employeeId: A.employeeId, projectId: erp, workDate: '2026-09-08', hours: 6, note: 'API' })
      sheet = await setHours(tx, { employeeId: A.employeeId, projectId: internal, workDate: '2026-09-08', hours: 2 })
      await expect(setHours(tx, { employeeId: A.employeeId, projectId: internal, workDate: '2026-09-08', hours: 19 })).rejects.toMatchObject({ code: 'OVER_24_HOURS' })
      sheet = await setHours(tx, { employeeId: A.employeeId, projectId: erp, workDate: '2026-09-09', hours: 8 })
      expect(sheet.week_start).toBe('2026-09-07')
      expect(sheet.total_hours).toBe('16.00')
      expect(sheet.billable_hours).toBe('14.00')                  // INT is non-billable
      // clearing an entry
      sheet = await setHours(tx, { employeeId: A.employeeId, projectId: internal, workDate: '2026-09-08', hours: 0 })
      expect(sheet.total_hours).toBe('14.00')

      // nothing counts until approved
      expect(await hoursReport(tx, { from: '2026-09-01', to: '2026-09-30' })).toEqual([])
      await expect(submitWeek(tx, { employeeId: A.employeeId, weekStart: '2026-09-14', requestedByUserId: empUser, fallbackChain: 'manager' })).rejects.toMatchObject({ code: 'TIMESHEET_EMPTY' })
      const submitted = await submitWeek(tx, { employeeId: A.employeeId, weekStart: '2026-09-07', requestedByUserId: empUser, fallbackChain: 'manager' })
      expect(submitted.status).toBe('submitted')
      await expect(setHours(tx, { employeeId: A.employeeId, projectId: erp, workDate: '2026-09-10', hours: 1 })).rejects.toMatchObject({ code: 'TIMESHEET_LOCKED' })

      // manager sends it back with a comment: editable again, then resubmitted and approved
      await act(tx, { requestId: submitted.approval_request_id!, actorUserId: managerUser, action: 'reject', comment: 'Wednesday looks high' })
      await settleTimesheetDecision(tx, { timesheetId: submitted.id, status: 'rejected', actorUserId: managerUser, comment: 'Wednesday looks high' })
      let week = await getWeek(tx, A.employeeId, '2026-09-07')
      expect(week.status).toBe('rejected')
      expect(week.comment).toBe('Wednesday looks high')
      await setHours(tx, { employeeId: A.employeeId, projectId: erp, workDate: '2026-09-09', hours: 7 })
      const again = await submitWeek(tx, { employeeId: A.employeeId, weekStart: '2026-09-07', requestedByUserId: empUser, fallbackChain: 'manager' })
      await act(tx, { requestId: again.approval_request_id!, actorUserId: managerUser, action: 'approve' })
      await settleTimesheetDecision(tx, { timesheetId: again.id, status: 'approved', actorUserId: managerUser })
      week = await getWeek(tx, A.employeeId, '2026-09-07')
      expect(week.status).toBe('approved')
      expect(week.total_hours).toBe('13.00')

      const report = await hoursReport(tx, { from: '2026-09-01', to: '2026-09-30' })
      expect(report).toHaveLength(1)
      expect(report[0]).toMatchObject({ project_code: 'ACME-ERP', hours: '13.00', billable_hours: '13.00', billable_paise: String(13 * 250_000) })
      expect((await listProjects(tx)).find((p) => p.id === erp)!.approved_hours).toBe('13.00')
      const notes = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type IN ('timesheet.rejected','timesheet.approved')`, [empUser])).rows[0]!.n
      expect(Number(notes)).toBe(2)
    })
  })

  it('an ended allocation stops bookings after its end; the work log upserts per day', async () => {
    await withTenant(A.id, async (tx) => {
      const alloc = (await listAllocations(tx, { employeeId: A.employeeId })).find((a) => a.project_id === internal)!
      await endAllocation(tx, alloc.id, '2026-09-15')
      await expect(setHours(tx, { employeeId: A.employeeId, projectId: internal, workDate: '2026-09-16', hours: 1 })).rejects.toMatchObject({ code: 'NOT_ALLOCATED' })
      await setHours(tx, { employeeId: A.employeeId, projectId: internal, workDate: '2026-09-15', hours: 1 })

      const log = await writeWorkLog(tx, { employeeId: A.employeeId, workDate: '2026-09-15', done: 'Shipped export', blockers: 'None', nextPlan: 'Load test' })
      const log2 = await writeWorkLog(tx, { employeeId: A.employeeId, workDate: '2026-09-15', done: 'Shipped export + fixed a bug' })
      expect(log2.id).toBe(log.id)
      const logs = await listWorkLogs(tx, { employeeId: A.employeeId, from: '2026-09-01', to: '2026-09-30' })
      expect(logs).toHaveLength(1)
      expect(logs[0]!.done).toBe('Shipped export + fixed a bug')
      expect(logs[0]!.blockers).toBeNull()
    })
  })
})
