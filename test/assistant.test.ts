/**
 * Grounded assistant (D5). Intents resolve from plain questions; every
 * answer is read from the caller's own rows under their permissions and
 * scope and names its sources; an employee's team question is cut to themself; an
 * unknown question is counted, not answered; HR sees gaps as counts, never
 * who asked; a person sees only their own questions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { buildContext } from '../src/authz/permissions.ts'
import { appendEntry } from '../src/leave/ledger.ts'
import { draftPolicy, publishPolicy } from '../src/comms/engage.ts'
import { classify, answer, gaps } from '../src/comms/assistant.ts'

let A: Tenant; let empUser: string; let mgrUser: string; let hrUser: string; let mgr: string
const TODAY = '2026-10-10'
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'ahr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining) VALUES ($1,'A-MGR','Maya','Menon',DATE '2022-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,'Engineering','Engineering Manager',DATE '2022-01-01')`, [A.id, mgr])
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, mgr])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'amgr@acme.test', fullName: 'Maya', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    empUser = await createUser(tx, { tenantId: A.id, email: 'aemp@acme.test', fullName: 'Rahul', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    const el = (await tx.query<{ id: string }>(`INSERT INTO leave_types (tenant_id, code, name) VALUES ($1,'EL','Earned Leave') ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name RETURNING id`, [A.id])).rows[0]!.id
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el, entryType: 'opening', deltaDays: 12, effectiveDate: '2026-01-01', cycleYear: 2026, note: 'opening' })
    await tx.query(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01')`, [A.id])
    await tx.query(`INSERT INTO holidays (tenant_id, holiday_on, name) VALUES ($1,DATE '2026-10-20','Diwali'),($1,DATE '2026-11-14','Children''s Day')`, [A.id])
    await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status) VALUES ($1,$2,DATE '2026-10-10','absent'),($1,$3,DATE '2026-10-10','present')`, [A.id, A.employeeId, mgr])
    const p = await draftPolicy(tx, { code: 'WFH', title: 'Work from home policy', body: 'Employees may work from home up to two days a week with manager approval. Fridays are anchor days in the office.', actorUserId: hrUser })
    await publishPolicy(tx, p.id)
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('classify', () => {
  it('maps plain questions to intents', () => {
    expect(classify('How many leaves do I have left?').intent?.key).toBe('leave.balance')
    expect(classify('when will salary be paid').intent?.key).toBe('payroll.payday')
    expect(classify('show my payslip for August').intent?.key).toBe('payroll.payslip')
    expect(classify("who's absent today").intent?.key).toBe('attendance.today')
    expect(classify('what is the WFH policy').intent?.key).toBe('policy.lookup')
    expect(classify('who is my manager').intent?.key).toBe('people.manager')
    expect(classify('upcoming holidays').intent?.key).toBe('holidays.upcoming')
    expect(classify('order me a pizza').intent).toBeNull()
  })
})

describe('answer', () => {
  it('grounded, scoped, sourced; unknowns counted; gaps anonymous', async () => {
    const emp = buildContext({ tenantId: A.id, userId: empUser, employeeId: A.employeeId, roles: ['employee'] })
    const man = buildContext({ tenantId: A.id, userId: mgrUser, employeeId: mgr, roles: ['manager'], reportIds: [A.employeeId] })
    const hr = buildContext({ tenantId: A.id, userId: hrUser, roles: ['hr_admin'] })
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      const ask = (q: string, auth = emp) => answer(tx, { question: q, auth, cfg, today: TODAY })
      let a = await ask('How many leaves do I have left?')
      expect(a.intent).toBe('leave.balance'); expect(a.text).toMatch(/EL\): 12 days available/); expect(a.sources[0]!.type).toBe('leave_ledger')
      a = await ask('when is salary paid')
      expect(a.text).toContain('2026-11-01')
      a = await ask('upcoming holidays')
      expect(a.text).toMatch(/2026-10-20: Diwali/)
      a = await ask('who is my manager?')
      expect(a.text).toMatch(/Maya Menon, Engineering Manager \(amgr@acme.test\)/)
      a = await ask('what is the wfh policy')
      expect(a.intent).toBe('policy.lookup'); expect(a.text).toMatch(/two days a week/); expect(a.sources[0]).toMatchObject({ type: 'policy', label: 'Work from home policy' })
      a = await ask('my attendance this month')
      expect(a.text).toMatch(/2026-10: 0 present, 1 absent/)
      // an employee's "who is absent" is cut to themself; a manager sees their team; HR sees all
      a = await ask("who's absent today")
      expect(a.text).toBe('absent: 1 (Rahul Sharma)')
      a = await ask("who's absent today", man)
      expect(a.text).toMatch(/absent: 1 \(Rahul/)
      a = await ask('who is present today', hr)
      expect(a.text).toMatch(/present: 1/)
      // HR with no employee record asking a personal question
      a = await ask('how many leaves do i have', hr)
      expect(a.text).toMatch(/not linked to an employee record/)
      // unknown, twice → a gap, without attribution
      a = await ask('order me a pizza'); a = await ask('Order me a pizza!')
      expect(a.intent).toBeNull(); expect(a.suggestions.length).toBeGreaterThan(3)
    })
    // a person sees only their own questions (HR asked two); HR's gap view is counts
    await withTenant(A.id, async (tx) => {
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM assistant_queries`)).rows[0]!.n).toBe('2')
    }, { userId: hrUser })
    await withTenant(A.id, async (tx) => {
      const g = await gaps(tx, 30)
      expect(g).toEqual([expect.objectContaining({ asks: 2 })])
      expect(Object.keys(g[0]!)).not.toContain('user_id')
    }, { userId: hrUser })
    await withTenant(A.id, async (tx) => {
      expect(Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM assistant_queries`)).rows[0]!.n)).toBeGreaterThanOrEqual(8)
    }, { userId: empUser })
  })
})
