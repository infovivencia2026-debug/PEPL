/**
 * Exit: gratuity, encashment and notice recovery as pure math; the settlement
 * resolved ONCE at freeze into the final run's lines; unfreeze releases it,
 * lock settles it and marks the person exited.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { computePayroll, type EngineOptions } from '../src/payroll/engine.ts'
import {
  approve, calculate, createRun, freezeInputs, getRun, lock, unfreezeInputs, validate,
} from '../src/payroll/run.ts'
import { GRATUITY_CAP_PAISE, gratuity, leaveEncashment, noticeRecovery, settlementLines } from '../src/payroll/settlement.ts'
import {
  cancelSeparation, computeSettlement, getSeparation, initiateSeparation, ExitError,
} from '../src/payroll/exit.ts'
import { changeCompensation } from '../src/people/history.ts'
import { createLeaveType, publishPolicy } from '../src/leave/policy.ts'
import { appendEntry } from '../src/leave/ledger.ts'

const L = (r: number): number => r * 100
const P = (r: number): bigint => BigInt(L(r))
const D = (s: string): Date => new Date(s)

describe('gratuity', () => {
  it('needs five years (or 4y 240d), rounds six months up, 15/26 of last drawn', () => {
    const w = L(30_000)
    expect(gratuity({ wagePaise: w, dateOfJoining: D('2022-01-01'), lastWorkingDay: D('2026-06-30') }).eligible).toBe(false)
    // 4 years + 240 days is five
    const edge = gratuity({ wagePaise: w, dateOfJoining: D('2022-01-01'), lastWorkingDay: D('2026-08-29') })
    expect(edge.eligible).toBe(true)
    expect(edge.yearsCounted).toBe(5)                 // 4y + 240d rounds up (>= 183 days)
    expect(edge.amountPaise).toBe(Math.round(w * 15 / 26 * 5))
    // 7 years 2 months -> 7
    const seven = gratuity({ wagePaise: w, dateOfJoining: D('2019-04-01'), lastWorkingDay: D('2026-05-31') })
    expect(seven.yearsCounted).toBe(7)
    // 7 years 7 months -> 8
    expect(gratuity({ wagePaise: w, dateOfJoining: D('2018-10-15'), lastWorkingDay: D('2026-05-31') }).yearsCounted).toBe(8)
  })

  it('is capped at 20 lakh and says so; death waives the five years', () => {
    const big = gratuity({ wagePaise: L(500_000), dateOfJoining: D('2010-01-01'), lastWorkingDay: D('2026-01-01') })
    expect(big.amountPaise).toBe(GRATUITY_CAP_PAISE)
    expect(big.computedPaise).toBeGreaterThan(GRATUITY_CAP_PAISE)
    expect(big.note).toMatch(/capped/)
    const death = gratuity({ wagePaise: L(30_000), dateOfJoining: D('2025-01-01'), lastWorkingDay: D('2026-09-01'), waiveMinimumService: true })
    expect(death.eligible).toBe(true)
    expect(death.yearsCounted).toBe(2)               // 1y 8m rounds up
  })
})

describe('encashment and notice', () => {
  it('encashes per day at wage / divisor across types, honouring a cap', () => {
    const e = leaveEncashment({ balances: [{ leaveTypeCode: 'EL', days: 12 }, { leaveTypeCode: 'CL', days: 3 }],
      wagePaise: L(30_000), divisor: 30, maxDays: 14 })
    expect(e.days).toBe(14)
    expect(e.byType).toEqual([
      { leaveTypeCode: 'EL', days: 12, amountPaise: L(12_000) },
      { leaveTypeCode: 'CL', days: 2, amountPaise: L(2_000) },
    ])
    expect(e.amountPaise).toBe(L(14_000))
  })

  it('recovers the notice shortfall on gross, nothing when served or waived', () => {
    const short = noticeRecovery({ requiredDays: 60, resignedOn: D('2026-09-01'), lastWorkingDay: D('2026-10-01'),
      grossMonthlyPaise: L(60_000), divisor: 30 })
    expect(short).toEqual({ servedDays: 30, shortfallDays: 30, amountPaise: L(60_000) })
    expect(noticeRecovery({ requiredDays: 30, resignedOn: D('2026-09-01'), lastWorkingDay: D('2026-10-15'),
      grossMonthlyPaise: L(60_000), divisor: 30 }).amountPaise).toBe(0)
    expect(noticeRecovery({ requiredDays: 60, resignedOn: D('2026-09-01'), lastWorkingDay: D('2026-09-02'),
      grossMonthlyPaise: L(60_000), divisor: 30, waived: true }).amountPaise).toBe(0)
  })

  it('becomes payslip lines: exempt earnings and deductions, nothing for zeros', () => {
    const lines = settlementLines({
      gratuity: { eligible: true, yearsCounted: 6, amountPaise: L(100_000), computedPaise: L(100_000), note: '' },
      encashment: { days: 10, amountPaise: L(10_000), byType: [] },
      notice: { servedDays: 0, shortfallDays: 10, amountPaise: L(20_000) },
      recoveriesPaise: 0,
    })
    expect(lines).toEqual([
      { code: 'GRATUITY', amountPaise: L(100_000), taxable: false },
      { code: 'LEAVE_ENCASH', amountPaise: L(10_000), taxable: false },
      { code: 'NOTICE_RECOVERY', amountPaise: L(20_000), type: 'deduction' },
    ])
  })

  it('the engine keeps exempt lines out of TDS and applies adhoc deductions to net', () => {
    const seen: bigint[] = []
    const opts: EngineOptions = {
      statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: P(15_000),
        esi_employee_rate: 0, esi_employer_rate: 0, esi_gross_threshold_paise: 0n },
      ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
      computeTds: (a) => { seen.push(a.monthlyTaxableGrossPaise); return { monthlyTdsPaise: 0n, trace: {} } },
    }
    const c = computePayroll({
      employeeId: 'e', calendarDays: 30, payableDays: 30, lopDays: 0, stateCode: 'TS',
      monthlyComponents: { basic: L(20_000) }, pfApplicable: true, esiApplicable: false, taxRegime: 'new',
      adhoc: [{ code: 'GRATUITY', amountPaise: L(100_000), taxable: false }, { code: 'RECOVERY', amountPaise: L(5_000), type: 'deduction' }],
    }, opts)
    expect(c.grossPaise).toBe(P(120_000))                       // gratuity is paid
    expect(seen).toEqual([P(20_000 - 1_800)])                   // but not taxed
    expect(c.deductionsPaise).toBe(P(1_800 + 5_000))
    expect(c.netPaise).toBe(P(120_000 - 6_800))
  })
})

// ---------------------------------------------------------------------------
let A: Tenant
let statutoryId: string
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
const HR = '70000000-0000-0000-0000-000000000007'
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: P(15_000),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: P(21_000) },
  ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])
  statutoryId = rows[0]!.id
  // Joined 2019-04-01 with 60,000 (basic 30,000); 10 days of encashable EL.
  await withTenant(A.id, async (tx) => {
    await tx.query(`UPDATE employees SET date_of_joining = DATE '2019-04-01' WHERE id = $1`, [A.employeeId])
    await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(720_000),
      components: { basic: L(30_000), hra: L(15_000), special: L(15_000) }, effectiveFrom: '2026-04-01', actorUserId: HR })
    const el = await createLeaveType(tx, { code: 'EL', name: 'Earned leave' })
    await publishPolicy(tx, el.id, { accrualMethod: 'monthly', accrualUnitsPerPeriod: 1.5, encashable: true, effectiveFrom: '2026-09-15' }, { today: '2026-09-15' })
    await appendEntry(tx, { employeeId: A.employeeId, leaveTypeId: el.id, entryType: 'opening', deltaDays: 10,
      effectiveDate: '2026-01-01', cycleYear: 2026, idempotencyKey: 'open-el' })
  })
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

async function period(start: string, end: string, label: string): Promise<string> {
  return withTenant(A.id, async (tx) => (await tx.query<{ id: string }>(
    `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
     VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id)
}

describe('the separation record', () => {
  it('opens once, previews, cancels with a reason, and refuses a second open one', async () => {
    const sep = await withTenant(A.id, (tx) => initiateSeparation(tx, {
      employeeId: A.employeeId, reason: 'resignation', initiatedOn: '2026-09-01', lastWorkingDay: '2026-10-20',
      noticeDaysRequired: 60, actorUserId: HR,
    }))
    expect(sep.status).toBe('initiated')
    await withTenant(A.id, async (tx) => {
      await expect(initiateSeparation(tx, { employeeId: A.employeeId, reason: 'termination', lastWorkingDay: '2026-11-01', actorUserId: HR }))
        .rejects.toMatchObject({ code: 'SEPARATION_OPEN' })
      await expect(initiateSeparation(tx, { employeeId: A.employeeId, reason: 'bogus' as never, lastWorkingDay: '2026-11-01', actorUserId: HR }))
        .rejects.toBeInstanceOf(ExitError)

      const s = await computeSettlement(tx, sep, { encashmentDivisor: 30, noticeDivisor: 30 })
      // 2019-04-01 -> 2026-10-20 = 7y 6m+ -> 8 years × 15/26 × 30,000
      expect(s.gratuity).toMatchObject({ eligible: true, yearsCounted: 8, amountPaise: Math.round(L(30_000) * 15 / 26 * 8) })
      expect(s.encashment).toMatchObject({ days: 10, amountPaise: L(10_000) })
      // 60 required, 49 served (Sep 1 -> Oct 20) -> 11 days × 60,000/30
      expect(s.notice).toMatchObject({ servedDays: 49, shortfallDays: 11, amountPaise: L(22_000) })
      expect(s.adhoc.map((a) => a.code)).toEqual(['GRATUITY', 'LEAVE_ENCASH', 'NOTICE_RECOVERY'])

      await expect(cancelSeparation(tx, sep.id, ' ')).rejects.toMatchObject({ code: 'REASON_REQUIRED' })
      const c = await cancelSeparation(tx, sep.id, 'withdrawn')
      expect(c.status).toBe('cancelled')
    })
  })

  it('freeze resolves it into the final run; unfreeze releases; lock settles and exits the employee', async () => {
    const sep = await withTenant(A.id, (tx) => initiateSeparation(tx, {
      employeeId: A.employeeId, reason: 'resignation', initiatedOn: '2026-09-01', lastWorkingDay: '2026-10-20',
      noticeDaysRequired: 60, recoveriesPaise: L(3_000), recoveriesNote: 'laptop charger', actorUserId: HR,
    }))
    const sep_ = await period('2026-09-01', '2026-09-30', '2026-09')   // not the final month
    const oct = await period('2026-10-01', '2026-10-31', '2026-10')    // last working day inside

    const row = { employeeId: A.employeeId, calendarDays: 31, payableDays: 20, lopDays: 0,
      monthlyComponents: { basic: L(30_000), hra: L(15_000), special: L(15_000) }, annualCtcPaise: L(720_000),
      stateCode: 'TS', pfApplicable: true }

    // September: no settlement — the last working day is not in this period.
    await withTenant(A.id, async (tx) => {
      const r = await createRun(tx, { periodId: sep_, processedByUserId: PROCESSOR })
      await freezeInputs(tx, r, [{ ...row, calendarDays: 30, payableDays: 30 }], {}, statutoryId)
      const { rows } = await tx.query<{ adhoc: unknown[] }>(`SELECT adhoc FROM payroll_inputs WHERE run_id = $1`, [r])
      expect(rows[0]!.adhoc).toEqual([])
      expect((await getSeparation(tx, A.employeeId))!.status).toBe('initiated')
    })

    // October: frozen -> in_payroll with the settlement as values; unfrozen -> released.
    const runId = await withTenant(A.id, async (tx) => {
      const r = await createRun(tx, { periodId: oct, processedByUserId: PROCESSOR })
      await freezeInputs(tx, r, [row], {}, statutoryId, { settlement: { encashmentDivisor: 30, noticeDivisor: 30 } })
      const { rows } = await tx.query<{ adhoc: { code: string; amountPaise: number }[]; exited_mid_period: boolean }>(
        `SELECT adhoc, exited_mid_period FROM payroll_inputs WHERE run_id = $1`, [r])
      expect(rows[0]!.exited_mid_period).toBe(true)
      expect(rows[0]!.adhoc.map((a) => a.code)).toEqual(['GRATUITY', 'LEAVE_ENCASH', 'NOTICE_RECOVERY', 'RECOVERY'])
      let s = (await getSeparation(tx, A.employeeId))!
      expect(s.status).toBe('in_payroll')
      expect(s.settlement_run_id).toBe(r)
      expect(s.settlement!.recoveriesPaise).toBe(L(3_000))

      await unfreezeInputs(tx, r)
      s = (await getSeparation(tx, A.employeeId))!
      expect(s.status).toBe('initiated')
      expect(s.settlement).toBeNull()

      await freezeInputs(tx, r, [row], {}, statutoryId, { settlement: { encashmentDivisor: 30, noticeDivisor: 30 } })
      await calculate(tx, r, OPTS)
      await validate(tx, r, { ...OPTS, variancePct: 1000 })
      await approve(tx, r, APPROVER, { requireSeparateApprover: true })
      return r
    })

    // The payslip carries the settlement. Prorated 20/31 of 60,000 = 38,710 + gratuity + encashment.
    await withTenant(A.id, async (tx) => {
      const { rows } = await tx.query<{ component_code: string; amount_paise: string; component_type: string }>(
        `SELECT component_code, component_type, amount_paise::text FROM payroll_lines WHERE run_id = $1 ORDER BY component_code`, [runId])
      const by = Object.fromEntries(rows.map((r) => [r.component_code, r]))
      // every payslip line rounds to the rupee as it is written
      expect(by.GRATUITY!.amount_paise).toBe(String(Math.round(L(30_000) * 15 / 26 * 8 / 100) * 100))
      expect(by.LEAVE_ENCASH!.amount_paise).toBe(String(L(10_000)))
      expect(by.NOTICE_RECOVERY).toMatchObject({ component_type: 'deduction', amount_paise: String(L(22_000)) })
      expect(by.RECOVERY).toMatchObject({ component_type: 'deduction', amount_paise: String(L(3_000)) })
      expect(Number(by.BASIC!.amount_paise)).toBe(Math.round(L(30_000) * 20 / 31 / 100) * 100)

      expect((await tx.query<{ status: string }>(`SELECT status FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!.status).toBe('active')
      // The leaver has a login with a live session and an API key. Leaving payroll must
      // also mean leaving the product -- these used to survive the exit untouched.
      const leaverId = (await tx.query<{ id: string }>(
        `INSERT INTO app_users (tenant_id, email, full_name, employee_id, password_hash)
         VALUES ($1, 'leaver@example.test', 'Leaver', $2, 'x') RETURNING id`, [A.id, A.employeeId])).rows[0]!.id
      await tx.query(`INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at) VALUES ($1,$2,'exit-test-hash', now() + interval '1 day')`, [A.id, leaverId])
      await tx.query(`INSERT INTO api_keys (tenant_id, user_id, name, prefix, key_hash) VALUES ($1,$2,'k','pk_x','exit-test-key')`, [A.id, leaverId])
      await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
      const after = await tx.query<{ status: string; live_sessions: number; live_keys: number }>(
        `SELECT u.status,
                (SELECT count(*)::int FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL) AS live_sessions,
                (SELECT count(*)::int FROM api_keys k WHERE k.user_id = u.id AND k.revoked_at IS NULL) AS live_keys
           FROM app_users u WHERE u.id = $1`, [leaverId])
      expect(after.rows[0]).toEqual({ status: 'disabled', live_sessions: 0, live_keys: 0 })
      expect((await getRun(tx, runId)).status).toBe('locked')

      const s = (await getSeparation(tx, A.employeeId))!
      expect(s.status).toBe('settled')
      expect(s.settled_at).not.toBeNull()
      const emp = (await tx.query<{ status: string; date_of_exit: string }>(
        `SELECT status, date_of_exit::text FROM employees WHERE id = $1`, [A.employeeId])).rows[0]!
      expect(emp).toEqual({ status: 'exited', date_of_exit: '2026-10-20' })

      // Nothing can be started for someone who has left.
      await expect(initiateSeparation(tx, { employeeId: A.employeeId, reason: 'resignation', lastWorkingDay: '2026-12-01', actorUserId: HR }))
        .rejects.toMatchObject({ code: 'ALREADY_EXITED' })
      void sep
    })
  })
})
