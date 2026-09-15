/**
 * The four datasets: every problem in the file is reported at once, a file
 * with errors writes nothing, and a clean file lands through the same module
 * functions a form would use.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  DATASETS, commitDataset, template, validateDataset, writeSales,
  attendanceDataset, compensationDataset, leaveOpeningDataset, salesDataset,
} from '../src/import/datasets.ts'
import { createLeaveType } from '../src/leave/policy.ts'
import { createComponent, createStructure } from '../src/payroll/structures.ts'
import { createPeriod, publishPlan, setTargets } from '../src/work/incentive-admin.ts'
import { balance } from '../src/leave/ledger.ts'

const L = (r: number): number => r * 100
let A: Tenant
let second: string

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  await controlPool.query(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2)`, [String(L(15_000)), String(L(21_000))])
  await withTenant(A.id, async (tx) => {
    second = (await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-002','Meera',DATE '2025-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await createLeaveType(tx, { code: 'EL', name: 'Earned' })
    for (const [code, pf] of [['BASIC', true], ['HRA', false], ['SPECIAL', false]] as const) {
      await createComponent(tx, { code, name: code, kind: 'earning', pfWage: pf })
    }
    await createStructure(tx, { code: 'STD', name: 'Standard', lines: [
      { component: 'BASIC', formula: { type: 'percent_of', of: 'CTC', pct: 50 } },
      { component: 'HRA', formula: { type: 'percent_of', of: 'BASIC', pct: 40 } },
      { component: 'SPECIAL', formula: { type: 'balance' } },
    ] })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('templates and shape', () => {
  it('every dataset has a template whose header matches its columns', () => {
    for (const d of Object.values(DATASETS)) {
      const [header, example] = template(d as never).trim().split('\r\n')
      expect(header).toBe(d.headers.join(','))
      expect(example!.split(',').length).toBeGreaterThanOrEqual(d.headers.length - 1)
      expect(d.headers[0]).toBe('employee_number')
    }
  })

  it('a missing column is one clear error, not a hundred', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(validateDataset(tx, attendanceDataset, 'employee_number,work_date\nA-001,2026-09-14'))
        .rejects.toMatchObject({ message: expect.stringMatching(/missing column\(s\): punch_in, punch_out/) })
    })
  })
})

describe('attendance', () => {
  it('reports every bad row at once, resolves people by number, and recomputes the day', async () => {
    const csv = [
      'employee_number,work_date,punch_in,punch_out',
      'A-001,2026-09-14,2026-09-14T09:32:00+05:30,2026-09-14T18:41:00+05:30',
      'A-001,not-a-date,2026-09-15T09:00:00+05:30,',
      'A-001,2026-09-16,2026-09-16T18:00:00+05:30,2026-09-16T09:00:00+05:30',
      'A-001,2026-09-17,,',
      'GHOST,2026-09-14,2026-09-14T09:00:00+05:30,',
      'A-002,2026-09-14,2026-09-14T10:00:00+05:30,2026-09-14T19:00:00+05:30',
    ].join('\n')
    const report = await withTenant(A.id, (tx) => validateDataset(tx, attendanceDataset, csv))
    expect(report.totalRows).toBe(6)
    expect(report.valid).toHaveLength(2)
    expect(report.errors.map((e) => [e.row, e.field])).toEqual([
      [3, 'work_date'], [4, 'punch_out'], [5, 'punch_in'], [6, 'employee_number'],
    ])

    // a file with errors writes nothing
    await withTenant(A.id, async (tx) => {
      await expect(commitDataset(tx, attendanceDataset, { tenantId: A.id, report })).rejects.toThrow(/still has errors/)
    })

    const clean = [
      'employee_number,work_date,punch_in,punch_out',
      'A-001,2026-09-14,2026-09-14T09:32:00+05:30,2026-09-14T18:41:00+05:30',
      'A-002,2026-09-14,2026-09-14T10:00:00+05:30,2026-09-14T19:00:00+05:30',
    ].join('\n')
    const written = await withTenant(A.id, async (tx) => {
      const r = await validateDataset(tx, attendanceDataset, clean)
      expect(r.errors).toEqual([])
      return commitDataset(tx, attendanceDataset, { tenantId: A.id, report: r })
    })
    expect(written).toEqual({ written: 2 })
    const day = await withTenant(A.id, async (tx) => (await tx.query<{ status: string; worked_minutes: number }>(
      `SELECT status, worked_minutes FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-09-14'`, [A.employeeId])).rows[0]!)
    expect(day).toEqual({ status: 'present', worked_minutes: 549 })

    // re-importing the same file is idempotent: the punches are keyed
    const again = await withTenant(A.id, async (tx) => {
      const r = await validateDataset(tx, attendanceDataset, clean)
      return commitDataset(tx, attendanceDataset, { tenantId: A.id, report: r })
    })
    expect(again.written).toBe(2)
    const punches = await withTenant(A.id, async (tx) => (await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM attendance_punches WHERE employee_id = $1 AND local_date = '2026-09-14'`, [A.employeeId])).rows[0]!.n)
    expect(Number(punches)).toBe(2)
  })
})

describe('opening leave balances', () => {
  it('lands in the ledger once, warns on a second attempt, and refuses an unknown type', async () => {
    const csv = [
      'employee_number,leave_type_code,days,cycle_year,as_of',
      'A-001,EL,12.5,2026,2026-04-01',
      'A-002,el,6,2026,2026-04-01',
      'A-001,SICK,5,2026,2026-04-01',
      'A-001,EL,not-a-number,2026,2026-04-01',
    ].join('\n')
    const report = await withTenant(A.id, (tx) => validateDataset(tx, leaveOpeningDataset, csv))
    expect(report.errors.map((e) => e.row)).toEqual([5])
    expect(report.warnings.map((w) => [w.row, w.message])).toEqual([[4, expect.stringMatching(/no active leave type SICK/)]])

    const clean = 'employee_number,leave_type_code,days,cycle_year,as_of\nA-001,EL,12.5,2026,2026-04-01\nA-002,el,6,2026,2026-04-01'
    await withTenant(A.id, async (tx) => {
      const r = await validateDataset(tx, leaveOpeningDataset, clean)
      expect(await commitDataset(tx, leaveOpeningDataset, { tenantId: A.id, report: r })).toEqual({ written: 2 })
      const el = (await tx.query<{ id: string }>(`SELECT id FROM leave_types WHERE code = 'EL'`)).rows[0]!.id
      expect((await balance(tx, A.employeeId, el, 2026)).available).toBe(12.5)
      // a second import of the same opening warns and writes nothing (idempotency key)
      const r2 = await validateDataset(tx, leaveOpeningDataset, clean)
      expect(r2.warnings).toHaveLength(2)
      expect(await commitDataset(tx, leaveOpeningDataset, { tenantId: A.id, report: r2 })).toEqual({ written: 0 })
      expect((await balance(tx, A.employeeId, el, 2026)).available).toBe(12.5)
    })
  })
})

describe('compensation', () => {
  it('takes a structure or explicit components, needs a reason, and warns about an out-of-order date', async () => {
    const csv = [
      'employee_number,annual_ctc_paise,effective_from,structure_code,components,reason',
      `A-001,${L(600_000)},2027-04-01,STD,,annual revision`,
      `A-002,${L(480_000)},2027-04-01,,BASIC=${L(20_000)};HRA=${L(8_000)};SPECIAL=${L(12_000)},offer`,
      `A-001,${L(700_000)},2027-05-01,STD,BASIC=1,both`,
      `A-001,${L(700_000)},2027-06-01,STD,,`,
      `A-001,${L(700_000)},2027-07-01,GHOST,,promotion`,
    ].join('\n')
    const report = await withTenant(A.id, (tx) => validateDataset(tx, compensationDataset, csv))
    expect(report.errors.map((e) => [e.row, e.field])).toEqual([[4, 'components'], [5, 'reason']])
    expect(report.warnings.some((w) => /no active structure GHOST/.test(w.message))).toBe(true)

    const clean = [
      'employee_number,annual_ctc_paise,effective_from,structure_code,components,reason',
      `A-001,${L(600_000)},2027-04-01,STD,,annual revision`,
      `A-002,${L(480_000)},2027-04-01,,BASIC=${L(20_000)};HRA=${L(8_000)};SPECIAL=${L(12_000)},offer`,
    ].join('\n')
    await withTenant(A.id, async (tx) => {
      const r = await validateDataset(tx, compensationDataset, clean)
      expect(r.errors).toEqual([])
      expect(await commitDataset(tx, compensationDataset, { tenantId: A.id, report: r })).toEqual({ written: 2 })
      const rec = (await tx.query<{ components: Record<string, number>; structure_code: string | null }>(
        `SELECT components, structure_code FROM compensation_records WHERE employee_id = $1 AND effective_from = '2027-04-01'`, [A.employeeId])).rows[0]!
      expect(rec.structure_code).toBe('STD')
      expect(rec.components).toEqual({ BASIC: L(25_000), HRA: L(10_000), SPECIAL: L(15_000) })
      const other = (await tx.query<{ components: Record<string, number> }>(
        `SELECT components FROM compensation_records WHERE employee_id = $1 AND effective_from = '2027-04-01'`, [second])).rows[0]!
      expect(other.components).toEqual({ BASIC: L(20_000), HRA: L(8_000), SPECIAL: L(12_000) })
    })
  })
})

describe('sales', () => {
  it('goes into an open period, idempotent by external ref', async () => {
    const periodId = await withTenant(A.id, async (tx) => {
      const plan = await publishPlan(tx, { name: 'Field', calcType: 'percent_of_metric', config: { ratePct: 0.02 }, effectiveFrom: '2027-01-01' }, { today: '2026-12-01' })
      const p = await createPeriod(tx, { label: '2027-01', periodStart: '2027-01-01', periodEnd: '2027-01-31' })
      await setTargets(tx, p.id, [{ employeeId: A.employeeId, planId: plan.id, targetValue: 100_000 }])
      return p.id
    })
    const csv = [
      'employee_number,occurred_on,value_paise,quantity,external_ref',
      `A-001,2027-01-05,${L(150_000)},2,INV-1`,
      `A-001,2027-01-20,${L(90_000)},,INV-2`,
      'A-001,nope,1,,INV-3',
    ].join('\n')
    await withTenant(A.id, async (tx) => {
      const r = await validateDataset(tx, salesDataset, csv)
      expect(r.errors.map((e) => e.row)).toEqual([4])
      const clean = await validateDataset(tx, salesDataset, csv.split('\n').slice(0, 3).join('\n'))
      expect(await writeSales(tx, periodId, clean)).toEqual({ recorded: 2, duplicates: 0 })
      const twice = await validateDataset(tx, salesDataset, csv.split('\n').slice(0, 3).join('\n'))
      expect(await writeSales(tx, periodId, twice)).toEqual({ recorded: 0, duplicates: 2 })
    })
  })
})
