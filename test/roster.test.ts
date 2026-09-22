/**
 * Rosters (B1): a planned day beats the standing shift and the week pattern
 * (shiftFor, recomputeDay, the muster all agree); a rotation staggers offs;
 * shortages compare plan to minimum headcount; a swap redraws both people's
 * days once the colleague accepts and the manager approves; optional
 * holidays are personal holidays within a yearly cap; pre-approved overtime
 * caps what the payroll summary counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { act } from '../src/approvals/index.ts'
import { createShift, rosterEmployee, shiftFor } from '../src/attendance/shifts.ts'
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { summarisePeriod } from '../src/attendance/summary.ts'
import { planDays, applyPattern, rosterGrid, shortages, alertShortages, proposeSwap, respondSwap, listSwaps, pickOptionalHoliday, requestOt } from '../src/attendance/roster.ts'

let A: Tenant
let manager: string; let mgrUser: string; let empUser: string; let colleague: string; let colUser: string
let shiftA: string; let shiftB: string
const policy = { unmarkedDayIsLop: false, lateMarksPerHalfDay: 0, weekPattern: 'five_day' as const, defaultStateCode: 'KA' }
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-RMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    colleague = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-COL','Col',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from, manager_employee_id) VALUES ($1,$2,'Ops','Operator',DATE '2024-01-01',$3)`, [A.id, colleague, manager])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'rmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    empUser = await createUser(tx, { tenantId: A.id, email: 'remp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    colUser = await createUser(tx, { tenantId: A.id, email: 'rcol@acme.test', fullName: 'Col', password: 'a-long-password-1', roles: ['employee'], employeeId: colleague })
    shiftA = (await createShift(tx, { code: 'A', name: 'A', startTime: '06:00', endTime: '14:00', fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0], minHeadcount: 2 })).id
    shiftB = (await createShift(tx, { code: 'B', name: 'B', startTime: '14:00', endTime: '22:00', fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0] })).id
    await rosterEmployee(tx, { employeeId: A.employeeId, shiftId: shiftA, effectiveFrom: '2026-01-01' })
    await rosterEmployee(tx, { employeeId: colleague, shiftId: shiftB, effectiveFrom: '2026-01-01' })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('planned days', () => {
  it('a planned day beats the standing shift and pattern; the day, the muster and shiftFor agree', async () => {
    await withTenant(A.id, async (tx) => {
      // Rahul is standing on A (Sunday off). Plan: Tue 6 Oct on B, Wed 7 Oct off, Sun 11 Oct WORKING on A.
      await planDays(tx, { employeeId: A.employeeId, days: [{ date: '2026-10-06', shiftId: shiftB }, { date: '2026-10-07', shiftId: null, off: true }, { date: '2026-10-11', shiftId: shiftA }], actorUserId: mgrUser })
      expect((await shiftFor(tx, A.employeeId, '2026-10-06'))!.code).toBe('B')
      expect(await shiftFor(tx, A.employeeId, '2026-10-07')).toBeNull()
      expect((await shiftFor(tx, A.employeeId, '2026-10-05'))!.code).toBe('A')          // unplanned: standing
      await recomputeDay(tx, A.employeeId, '2026-10-07', { timezone: 'Asia/Kolkata' })
      expect((await tx.query<{ status: string }>(`SELECT status FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-07'`, [A.employeeId])).rows[0]!.status).toBe('weekly_off')
      const [s] = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy: { ...policy, weekPattern: 'roster' }, employeeIds: [A.employeeId] })
      const code = (d: string) => s!.days.find((c) => c.date === d)!.code
      expect(code('2026-10-07')).toBe('WO')     // planned off
      expect(code('2026-10-11')).toBe('–')      // a Sunday planned as working: no record yet, not an off
      expect(code('2026-10-04')).toBe('WO')     // unplanned Sunday: the shift's weekly off
      const grid = await rosterGrid(tx, { from: '2026-10-05', to: '2026-10-11', employeeIds: [A.employeeId], weekPattern: 'five_day' })
      expect(grid[0]!.cells.map((c) => `${c.shiftCode ?? '-'}${c.off ? '/off' : ''}:${c.source}`)).toEqual(['A:standing', 'B:day', '-/off:day', 'A:standing', 'A:standing', 'A:standing', 'A:day'])
      await expect(planDays(tx, { employeeId: A.employeeId, days: [{ date: '2026-10-08', shiftId: crypto.randomUUID() }], actorUserId: mgrUser })).rejects.toMatchObject({ code: 'SHIFT_NOT_FOUND' })
    })
  })

  it('a rotation staggers offs; shortages compare the plan to the minimum; the alert reaches managers once a day', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await applyPattern(tx, { employeeIds: [A.employeeId, colleague], from: '2026-11-02', to: '2026-11-08', cycle: ['A', 'A', 'A', 'A', 'A', 'A', 'OFF'], stagger: 1, actorUserId: mgrUser })
      expect(r).toEqual({ employees: 2, days: 14 })
      const grid = await rosterGrid(tx, { from: '2026-11-02', to: '2026-11-08', employeeIds: [A.employeeId, colleague], weekPattern: 'five_day' })
      const offAt = (id: string) => grid.find((g) => g.employeeId === id)!.cells.findIndex((c) => c.off)
      expect([offAt(A.employeeId), offAt(colleague)]).toEqual([6, 5])          // staggered by one day
      // A needs 2 people; on each of the two off days only one is planned
      const short = await shortages(tx, { from: '2026-11-02', to: '2026-11-08' })
      expect(short.map((s) => `${s.date}:${s.planned}/${s.minimum}`)).toEqual(['2026-11-07:1/2', '2026-11-08:1/2'])
      expect(await alertShortages(tx, 7, '2026-11-01')).toBe(3)                 // + Nov 1 itself, with nobody planned
      const told = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'roster.shortage'`, [mgrUser])).rows[0]!.n
      expect(Number(told)).toBe(1)
      expect(await alertShortages(tx, 0)).toBe(0)
    })
  })
})

describe('shift swap', () => {
  it('colleague accepts → manager approves → both days redrawn as swap rows', async () => {
    const today = new Date(); const d = new Date(today.getTime() + 10 * 86_400_000).toISOString().slice(0, 10)
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      const s = await proposeSwap(tx, { requesterEmployeeId: A.employeeId, counterpartEmployeeId: colleague, date: d, reason: 'Wedding', requestedByUserId: empUser })
      expect(s).toMatchObject({ status: 'proposed', requester_shift_id: shiftA, counterpart_shift_id: shiftB })
      await expect(proposeSwap(tx, { requesterEmployeeId: colleague, counterpartEmployeeId: A.employeeId, date: d, requestedByUserId: colUser })).rejects.toMatchObject({ code: 'SWAP_OPEN' })
      await expect(respondSwap(tx, cfg, { swapId: s.id, counterpartEmployeeId: A.employeeId, accept: true, userId: empUser })).rejects.toMatchObject({ code: 'NOT_YOURS' })
      const accepted = await respondSwap(tx, cfg, { swapId: s.id, counterpartEmployeeId: colleague, accept: true, userId: colUser })
      expect(accepted.status).toBe('accepted')
      expect(accepted.approval_request_id).toBeTruthy()
      await act(tx, { requestId: accepted.approval_request_id!, actorUserId: mgrUser, action: 'approve' })
      const { settleDecision } = await import('../src/approvals/settle.ts')
      await settleDecision(tx, cfg, { requestId: accepted.approval_request_id!, status: 'approved', actorUserId: mgrUser })
      expect((await listSwaps(tx, { employeeId: A.employeeId }))[0]!.status).toBe('approved')
      expect((await shiftFor(tx, A.employeeId, d))!.code).toBe('B')
      expect((await shiftFor(tx, colleague, d))!.code).toBe('A')
      const grid = await rosterGrid(tx, { from: d, to: d, employeeIds: [A.employeeId], weekPattern: 'five_day' })
      expect(grid[0]!.cells[0]!.source).toBe('swap')
    })
  })
})

describe('optional holidays and overtime approval', () => {
  it('a pick is a holiday for that person only, within the cap; approved OT caps the payroll count when the setting is on', async () => {
    await withTenant(A.id, async (tx) => {
      const hol = (await tx.query<{ id: string }>(`INSERT INTO holidays (tenant_id, holiday_on, name, is_optional) VALUES ($1, DATE '2026-12-25', 'Christmas', true), ($1, DATE '2026-11-04', 'Guru Nanak Jayanti', true) RETURNING id`, [A.id])).rows
      await expect(pickOptionalHoliday(tx, await resolveConfig(tx, A.id), { employeeId: A.employeeId, holidayId: hol[0]!.id })).rejects.toMatchObject({ code: 'OPTIONAL_HOLIDAYS_OFF' })
      await setSetting(tx, { key: 'leave.optional_holidays_allowed', value: 1, reason: 'test' })
      const cfg = await resolveConfig(tx, A.id)
      expect(await pickOptionalHoliday(tx, cfg, { employeeId: A.employeeId, holidayId: hol[0]!.id })).toEqual({ picked: 1, allowed: 1 })
      await expect(pickOptionalHoliday(tx, cfg, { employeeId: A.employeeId, holidayId: hol[1]!.id })).rejects.toMatchObject({ code: 'OPTIONAL_HOLIDAY_CAP' })
      const dec = await summarisePeriod(tx, { periodStart: '2026-12-01', periodEnd: '2026-12-31', policy: { ...policy, weekPattern: 'roster' }, employeeIds: [A.employeeId, colleague] })
      expect(dec.find((r) => r.employeeId === A.employeeId)!.days.find((c) => c.date === '2026-12-25')!.code).toBe('H')
      expect(dec.find((r) => r.employeeId === colleague)!.days.find((c) => c.date === '2026-12-25')!.code).toBe('–')   // not picked: an ordinary day

      // OT: 3 hours worked beyond the shift on 5 Oct; only 60 minutes approved
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T00:30:00Z', localDate: '2026-10-05', direction: 'in', source: 'web' })
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T11:30:00Z', localDate: '2026-10-05', direction: 'out', source: 'web' })   // 06:00–17:00 IST on A (ends 14:00)
      await tx.query(`UPDATE shifts SET ot_eligible = true, ot_after_min = 30 WHERE id = $1`, [shiftA])   // OT counts once 30 min past the end
      await recomputeDay(tx, A.employeeId, '2026-10-05', { timezone: 'Asia/Kolkata' })
      const day = (await tx.query<{ ot_minutes: number }>(`SELECT ot_minutes FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-05'`, [A.employeeId])).rows[0]!
      expect(day.ot_minutes).toBe(180)
      const ot = await requestOt(tx, cfg, { employeeId: A.employeeId, date: '2026-10-05', minutes: 60, reason: 'dispatch', requestedByUserId: empUser })
      expect(ot.status).toBe('pending')
      await act(tx, { requestId: ot.approval_request_id!, actorUserId: mgrUser, action: 'approve' })
      const { settleDecision } = await import('../src/approvals/settle.ts')
      await settleDecision(tx, cfg, { requestId: ot.approval_request_id!, status: 'approved', actorUserId: mgrUser })
      await expect(requestOt(tx, cfg, { employeeId: A.employeeId, date: '2026-10-05', minutes: 30, requestedByUserId: empUser })).rejects.toMatchObject({ code: 'OT_REQUEST_OPEN' })
      const free = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy: { ...policy, weekPattern: 'roster' }, employeeIds: [A.employeeId] })
      expect(free[0]!.otMinutes).toBe(180)                                                  // approval not required: all of it
      const gated = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy: { ...policy, weekPattern: 'roster', otRequiresApproval: true }, employeeIds: [A.employeeId] })
      expect(gated[0]!.otMinutes).toBe(60)                                                  // only what was approved
    })
  })
})
