/**
 * A leaver is paid for the days they worked, and their settlement is not lost if it is late.
 *
 * PAY-09  Until the final settlement LOCKS, nothing marks the person as having left (date_of_exit
 *         is written at lock). The attendance summary therefore counted every day of every month
 *         up to then as employed, and a leaver whose settlement was delayed was paid a full month
 *         for a month they did not work.
 * PAY-10  A separation was picked up only by the run whose period CONTAINED the last working day.
 *         If a clearance was still pending in that run the settlement "waited for the next run" --
 *         and the next run's period no longer contained the day, so it never came: the leaver was
 *         never settled and never marked exited.
 *
 * Both were found by an audit and are reproduced here before the fix.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createRun, freezeInputs } from '../src/payroll/run.ts'
import { getSeparation, initiateSeparation } from '../src/payroll/exit.ts'
import { summarisePeriod } from '../src/attendance/summary.ts'
import { changeCompensation } from '../src/people/history.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const HR = '70000000-0000-0000-0000-000000000007'
const policy = { unmarkedDayIsLop: false, lateMarksPerHalfDay: 0, weekPattern: 'five_day' as const, defaultStateCode: 'KA' }
let A: Tenant
let statutoryId: string

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    await tx.query(`UPDATE employees SET date_of_joining = DATE '2019-04-01' WHERE id = $1`, [A.employeeId])
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(720_000),
      components: { basic: L(30_000), hra: L(15_000), special: L(15_000) }, effectiveFrom: '2026-04-01', actorUserId: HR })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

const period = (start: string, end: string, label: string) => withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
  `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
   VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id)

describe('days after the last working day', () => {
  it('are not counted as employed days while the separation is still open', async () => {
    await withTenant(A.id, (tx) => initiateSeparation(tx, {
      employeeId: A.employeeId, reason: 'resignation', initiatedOn: '2026-09-01', lastWorkingDay: '2026-10-10', actorUserId: HR,
    }))
    const [s] = await withTenant(A.id, (tx) => summarisePeriod(tx, {
      periodStart: '2026-10-01', periodEnd: '2026-10-31', policy, employeeIds: [A.employeeId] }))
    // 1st to 10th Oct inclusive. payable + LOP is what the engine prorates a leaver by: 31 here
    // meant a full month's pay for ten days' work.
    expect(s!.payableDays + s!.lopDays).toBe(10)
  })
})

describe('a settlement that is late', () => {
  it('is picked up by the next run, not lost', async () => {
    // A fresh leaver: the first separation above belongs to the previous test.
    await controlPool.query(`DELETE FROM employee_separations WHERE tenant_id = $1`, [A.id])
    const sep = await withTenant(A.id, (tx) => initiateSeparation(tx, {
      employeeId: A.employeeId, reason: 'resignation', initiatedOn: '2026-08-15', lastWorkingDay: '2026-09-20', actorUserId: HR,
    }))
    // A clearance is still outstanding when the September run is frozen.
    await controlPool.query(
      `INSERT INTO exit_clearances (tenant_id, separation_id, area, status) VALUES ($1,$2,'it','pending')`, [A.id, sep.id])
    const row = { employeeId: A.employeeId, calendarDays: 30, payableDays: 20, lopDays: 0,
      monthlyComponents: { basic: L(30_000), hra: L(15_000), special: L(15_000) }, annualCtcPaise: L(720_000), stateCode: 'TS', pfApplicable: true }

    const sepPeriod = await period('2026-09-01', '2026-09-30', '2026-09')
    await withTenant(A.id, async (tx) => {
      const r = await createRun(tx, { periodId: sepPeriod, processedByUserId: PROCESSOR })
      await freezeInputs(tx, r, [row], {}, statutoryId, { settlement: { encashmentDivisor: 30, noticeDivisor: 30 } })
      expect((await getSeparation(tx, A.employeeId))!.status).toBe('initiated')     // waiting, as designed
    })

    // The clearance comes in after the September run; the NEXT month's run must settle it.
    await controlPool.query(`UPDATE exit_clearances SET status = 'cleared' WHERE separation_id = $1`, [sep.id])
    const octPeriod = await period('2026-10-01', '2026-10-31', '2026-10')
    await withTenant(A.id, async (tx) => {
      const r = await createRun(tx, { periodId: octPeriod, processedByUserId: PROCESSOR })
      await freezeInputs(tx, r, [{ ...row, calendarDays: 31, payableDays: 0 }], {}, statutoryId, { settlement: { encashmentDivisor: 30, noticeDivisor: 30 } })
      const s = (await getSeparation(tx, A.employeeId))!
      expect(s.status).toBe('in_payroll')
      expect(s.settlement_run_id).toBe(r)
    })
  })
})
