/**
 * Compliance (C2): the calendar generates only what applies (no PF code → no
 * ECR; PT state → PT and, for an LWF state, LWF; 10+ heads → POSH), with the
 * right due dates (March TDS on 30 April; 24Q quarters), idempotently; marking
 * filed records evidence; the score counts on-time over due; reminders reach
 * payroll/HR once a day; registers render from a locked run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { dueDatesBetween, OBLIGATIONS } from '../db/reference/compliance.ts'
import { generateObligations, calendar, markFiled, complianceScore, remindObligations, wageRegister, overtimeRegister, leaveRegister } from '../src/payroll/compliance.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let A: Tenant; let hrUser: string
const L = (r: number): number => r * 100
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => { hrUser = await createUser(tx, { tenantId: A.id, email: 'chr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] }) })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('reference calendar', () => {
  it('knows the due dates: monthly in the following month, March TDS on 30 April, 24Q quarters, half-yearly LWF', () => {
    const tds = OBLIGATIONS.find((o) => o.code === 'TDS_192')!
    expect(dueDatesBetween(tds, '2026-04-01', '2026-05-31')).toEqual([{ dueOn: '2026-04-30', period: '2026-03' }, { dueOn: '2026-05-07', period: '2026-04' }])
    const q = OBLIGATIONS.find((o) => o.code === 'TDS_24Q')!
    expect(dueDatesBetween(q, '2026-04-01', '2027-03-31').map((d) => `${d.dueOn} ${d.period}`)).toEqual(['2026-05-31 Q4 FY25-26', '2026-07-31 Q1 FY26-27', '2026-10-31 Q2 FY26-27', '2027-01-31 Q3 FY26-27'])
    const pf = OBLIGATIONS.find((o) => o.code === 'PF_ECR')!
    expect(dueDatesBetween(pf, '2026-10-01', '2026-10-31')).toEqual([{ dueOn: '2026-10-15', period: '2026-09' }])
    const lwf = OBLIGATIONS.find((o) => o.code === 'LWF')!
    expect(dueDatesBetween(lwf, '2026-01-01', '2026-12-31').map((d) => d.dueOn)).toEqual(['2026-01-15', '2026-07-15'])
  })
})

describe('company calendar', () => {
  it('generates only what applies, idempotently; marking, score and reminders', async () => {
    await withTenant(A.id, async (tx) => {
      // no PF/ESI codes, no PT state, 1 employee → TDS, 24Q, Form 16, S&E only
      let cfg = await resolveConfig(tx, A.id)
      expect(await generateObligations(tx, cfg, { from: '2026-10-01', to: '2026-10-31' })).toBe(2)   // TDS for September (7 Oct) and Q2 24Q (31 Oct)
      let cal = await calendar(tx, { from: '2026-10-01', to: '2026-10-31', today: '2026-10-01' })
      expect(cal.map((c) => c.code)).toEqual(['TDS_192', 'TDS_24Q'])
      // register for PF and set a PT state in an LWF state
      await setSetting(tx, { key: 'payroll.pf_establishment_code', value: 'KABLR0012345000', reason: 'test' })
      await setSetting(tx, { key: 'payroll.pt_state_code', value: 'KA', reason: 'test', effectiveFrom: '2026-01-01' })
      cfg = await resolveConfig(tx, A.id)
      expect(await generateObligations(tx, cfg, { from: '2026-10-01', to: '2027-01-31' })).toBeGreaterThan(0)
      expect(await generateObligations(tx, cfg, { from: '2026-10-01', to: '2027-01-31' })).toBe(0)     // idempotent
      cal = await calendar(tx, { from: '2026-10-01', to: '2027-01-31', today: '2026-10-01' })
      const codes = new Set(cal.map((c) => c.code))
      expect([...codes].sort()).toEqual(['LWF', 'PF_ECR', 'PT', 'TDS_192', 'TDS_24Q'])                // KA levies LWF; 1 head → no POSH, no bonus
      expect(codes.has('ESI')).toBe(false)
      const pfSep = cal.find((c) => c.code === 'PF_ECR' && c.period === '2026-09')!
      expect(pfSep).toMatchObject({ due_on: '2026-10-15', status: 'pending', produced_by: 'ecr', overdue: false })
      expect(cal.find((c) => c.code === 'PT')!.check).toBe(true)                                      // "confirm with your consultant"

      // marking: filed late, filed on time, not applicable needs a reason
      const tdsSep = cal.find((c) => c.code === 'TDS_192' && c.period === '2026-09')!
      await expect(markFiled(tx, { id: tdsSep.id, status: 'not_applicable', actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await markFiled(tx, { id: tdsSep.id, status: 'filed', filedOn: '2026-10-09', referenceNo: 'CIN 1234', actorUserId: hrUser })       // 2 days late
      await markFiled(tx, { id: pfSep.id, status: 'filed', filedOn: '2026-10-14', referenceNo: 'TRRN 99', actorUserId: hrUser })         // on time
      const score = await complianceScore(tx, { from: '2026-10-01', to: '2026-10-31', today: '2026-10-25' })
      // due by 25 Oct: TDS 7 Oct (late), PF 15 Oct (on time), PT 20 Oct (pending → overdue)
      expect(score).toMatchObject({ due: 3, filedOnTime: 1, filedLate: 1, overdue: 1, score: 33 })
      expect(score.byCode.find((b) => b.code === 'PT')).toMatchObject({ overdue: 1 })

      // reminders: PT (overdue) and PF for October (due 15 Nov, not within 3 days) → 1 obligation to 1 admin, once
      expect(await remindObligations(tx, '2026-10-25')).toBe(1)
      expect(await remindObligations(tx, '2026-10-25')).toBe(0)
      const n = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'compliance.overdue'`, [hrUser])).rows[0]!.n
      expect(n).toBe('1')
    })
  })
})

describe('registers', () => {
  it('wage, overtime and leave registers render from the books', async () => {
    await controlPool.query('TRUNCATE statutory_configs CASCADE')
    const { rows } = await controlPool.query<{ id: string }>(`INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise) VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])
    const OPTS: EngineOptions = { statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)), esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) }, ptAmountPaise: () => 20000n, pfOnFullWage: false, lopBasis: 'calendar_days' }
    await withTenant(A.id, async (tx) => {
      const periodId = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])).rows[0]!.id
      const runId = await createRun(tx, { periodId, processedByUserId: 'a1000000-0000-0000-0000-0000000000a1' })
      await freezeInputs(tx, runId, [{ employeeId: A.employeeId, calendarDays: 30, payableDays: 28, lopDays: 2, monthlyComponents: { basic: L(20_000), hra: L(8_000) }, annualCtcPaise: L(336_000), stateCode: 'KA', otMinutes: 120 }], {}, rows[0]!.id)
      await calculate(tx, runId, OPTS); await validate(tx, runId, { ...OPTS, variancePct: 25 })
      await approve(tx, runId, 'b1000000-0000-0000-0000-0000000000b1', { requireSeparateApprover: true }); await lock(tx, runId, 'b1000000-0000-0000-0000-0000000000b1', { requireSeparateApprover: true })
      const wages = await wageRegister(tx, '2026-09')
      expect(wages.rows).toHaveLength(1)
      expect(wages.rows[0]).toMatchObject({ 'Emp No': 'A-001', 'Days paid': '28.00', PT: 200 })
      expect(Number(wages.rows[0]!['Gross earnings'])).toBeGreaterThan(0)
      expect(wages.csv.split('\n')[0]).toContain('Net paid')
      await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status, ot_minutes) VALUES ($1,$2,DATE '2026-09-10','present',90)`, [A.id, A.employeeId])
      const ot = await overtimeRegister(tx, '2026-09')
      expect(ot.rows[0]).toMatchObject({ Date: '2026-09-10', 'OT hours': 1.5 })
      const leave = await leaveRegister(tx, 2026)
      expect(leave.columns).toContain('Balance')
    })
  })
})
