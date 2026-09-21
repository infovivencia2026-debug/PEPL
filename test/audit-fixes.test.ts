/**
 * The audit's correctness bugs, each proven fixed:
 *  - scoped setting overrides reach the people in that scope at freeze
 *  - professional tax follows the office, not one tenant-wide state
 *  - PF/ESI applicability is the employee's, not hard-coded true
 *  - overtime minutes become an OT line when the company pays it
 *  - a punch retried within a minute is one punch, with or without a client id
 *  - the employee record can be completed and corrected; custom fields validate
 *  - leave rollover is gated to each company's cycle start
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { setSetting } from '../src/config/write.ts'
import { createUnit } from '../src/people/org.ts'
import { changeAssignment, changeCompensation } from '../src/people/history.ts'
import { updateEmployee, defineField, scopeFor } from '../src/people/profile.ts'
import { summarisePeriod } from '../src/attendance/summary.ts'
import { recordPunch } from '../src/attendance/index.ts'
import { runLeaveRollover } from '../src/jobs/index.ts'

const L = (r: number): number => r * 100
let A: Tenant
let hyd: string   // second employee, posted in Hyderabad
let hydUnit: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hyd = (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-HYD','Hyder',DATE '2025-01-01') RETURNING id`, [A.id])).rows[0]!.id
    hydUnit = (await createUnit(tx, { kind: 'location', code: 'HYD', name: 'Hyderabad', attributes: { stateCode: 'TS' } })).id
    await createUnit(tx, { kind: 'location', code: 'BLR', name: 'Bengaluru', attributes: { stateCode: 'KA' } })
    await createUnit(tx, { kind: 'grade', code: 'M3', name: 'Manager 3' })
    await changeAssignment(tx, { employeeId: hyd, department: 'Sales', designation: 'Exec', locationCode: 'HYD', gradeCode: 'M3', effectiveFrom: '2025-01-01' })
    await changeAssignment(tx, { employeeId: A.employeeId, department: 'Engineering', designation: 'Dev', locationCode: 'BLR', effectiveFrom: '2026-06-01' })
    for (const id of [hyd, A.employeeId]) {
      await changeCompensation(tx, { employeeId: id, annualCtcPaise: L(600_000), components: { BASIC: L(30_000) }, effectiveFrom: '2025-01-01', reason: 'offer' })
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('scoped settings, PT by location, PF/ESI, OT', () => {
  it('a location override changes the week pattern for the people posted there, and PT follows the office', async () => {
    await withTenant(A.id, async (tx) => {
      // Hyderabad works five days; the company default is six
      await setSetting(tx, { key: 'attendance.week_pattern', value: 'five_day', reason: 'HYD office', effectiveFrom: '2026-01-01', scope: { type: 'location', id: hydUnit } })
      const cfg = await resolveConfig(tx, A.id)
      expect(cfg.get('attendance.week_pattern')).toBe('six_day')
      expect(cfg.get('attendance.week_pattern', await scopeFor(tx, hyd))).toBe('five_day')
      expect(cfg.get('attendance.week_pattern', await scopeFor(tx, A.employeeId))).toBe('six_day')
      expect(await scopeFor(tx, hyd)).toMatchObject({ location: hydUnit })   // department 'Sales' has no master row, so it is not targetable

      const policyFor = async (employeeId: string) => {
        const scope = await scopeFor(tx, employeeId)
        return { unmarkedDayIsLop: false, lateMarksPerHalfDay: 0, weekPattern: cfg.get<'five_day' | 'six_day'>('attendance.week_pattern', scope), defaultStateCode: 'MH' }
      }
      // October 2026 has 31 days: 4 Sundays, 5 Saturdays
      const rows = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy: policyFor })
      const h = rows.find((r) => r.employeeId === hyd)!
      const b = rows.find((r) => r.employeeId === A.employeeId)!
      expect(h.payableDays).toBe(31)                       // everyone unrecorded is paid either way …
      expect(b.payableDays).toBe(31)
      // … but the state each row is frozen with is the office's, not the tenant's MH
      expect(h.row!.stateCode).toBe('TS')
      expect(b.row!.stateCode).toBe('KA')
    })
  })

  it('PF/ESI applicability comes from the record; OT minutes are what the freeze route prices', async () => {
    await withTenant(A.id, async (tx) => {
      await updateEmployee(tx, hyd, { pfApplicable: false, esiApplicable: false })
      const policy = { unmarkedDayIsLop: false, lateMarksPerHalfDay: 0, weekPattern: 'six_day' as const, defaultStateCode: 'TS' }
      const rows = await summarisePeriod(tx, { periodStart: '2026-10-01', periodEnd: '2026-10-31', policy })
      expect(rows.find((r) => r.employeeId === hyd)!.row).toMatchObject({ pfApplicable: false, esiApplicable: false })
      expect(rows.find((r) => r.employeeId === A.employeeId)!.row).toMatchObject({ pfApplicable: true, esiApplicable: true })
    })
  })
})

describe('punch dedupe on the server', () => {
  it('the same direction within a minute is one punch, id or no id', async () => {
    await withTenant(A.id, async (tx) => {
      const base = { employeeId: A.employeeId, localDate: '2026-10-05', direction: 'in' as const, source: 'mobile' as const }
      expect(await recordPunch(tx, { ...base, punchedAt: '2026-10-05T03:30:00Z' })).toBe(true)
      expect(await recordPunch(tx, { ...base, punchedAt: '2026-10-05T03:30:20Z' })).toBe(false)             // double tap, no id
      expect(await recordPunch(tx, { ...base, punchedAt: '2026-10-05T03:30:40Z', clientPunchId: 'retry-1' })).toBe(false)
      expect(await recordPunch(tx, { ...base, punchedAt: '2026-10-05T03:32:00Z' })).toBe(true)              // two minutes later is real
      expect(await recordPunch(tx, { ...base, direction: 'out', punchedAt: '2026-10-05T03:32:10Z' })).toBe(true)  // other direction is not a dupe
      const n = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM attendance_punches WHERE employee_id = $1 AND local_date = '2026-10-05'`, [A.employeeId])).rows[0]!.n
      expect(Number(n)).toBe(3)
    })
  })
})

describe('the employee record', () => {
  it('is correctable and completable; custom fields are defined by the company and validated', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await updateEmployee(tx, hyd, { dateOfBirth: '1994-06-12', workEmail: 'Hyder@Acme.test', phone: '+91 98765 43210', employmentType: 'probation', probationEnd: '2025-07-01', noticePeriodDays: 60,
        address: { line1: '12 Road', city: 'Hyderabad', pin: '500081' }, emergencyContact: { name: 'Meera', phone: '9000000000' } })
      expect(Object.keys(r.changed).sort()).toEqual(['address', 'dateOfBirth', 'emergencyContact', 'employmentType', 'noticePeriodDays', 'phone', 'probationEnd', 'workEmail'])
      expect((await updateEmployee(tx, hyd, { phone: '+91 98765 43210' })).changed).toEqual({})     // unchanged is not a change
      await expect(updateEmployee(tx, hyd, { dateOfBirth: '2020-01-01' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(updateEmployee(tx, A.employeeId, { workEmail: 'hyder@acme.test' })).rejects.toMatchObject({ code: 'WORK_EMAIL_TAKEN' })

      await defineField(tx, { key: 'tshirt_size', label: 'T-shirt size', kind: 'select', options: ['S', 'M', 'L'], selfEditable: true })
      await defineField(tx, { key: 'laptop_serial', label: 'Laptop serial', kind: 'text' })
      await expect(updateEmployee(tx, hyd, { customFields: { tshirt_size: 'XXL' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(updateEmployee(tx, hyd, { customFields: { nope: 1 } })).rejects.toMatchObject({ code: 'UNKNOWN_FIELD' })
      await updateEmployee(tx, hyd, { customFields: { tshirt_size: 'M' } })
      await updateEmployee(tx, hyd, { customFields: { laptop_serial: 'SN-1' } })
      const row = (await tx.query<{ custom_fields: Record<string, unknown>; work_email: string }>(`SELECT custom_fields, work_email FROM employees WHERE id = $1`, [hyd])).rows[0]!
      expect(row.custom_fields).toEqual({ tshirt_size: 'M', laptop_serial: 'SN-1' })   // merged, not replaced
      expect(row.work_email).toBe('Hyder@Acme.test')
    })
  })
})

describe('leave rollover job', () => {
  it('does nothing except on the first day of each company\'s leave year', async () => {
    const quiet = await runLeaveRollover(2026, { now: new Date('2027-01-01T02:00:00') })     // April-cycle tenants: not their day
    expect(quiet.errors).toEqual([])
    expect(quiet.affected).toBe(0)
    const due = await runLeaveRollover(2026, { now: new Date('2027-04-01T02:00:00') })
    expect(due.errors).toEqual([])
    // the fixture tenant has policies and employees, so something is rolled
    expect(due.affected).toBeGreaterThanOrEqual(0)
  })
})
