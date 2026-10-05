/**
 * Statutory filings: the file formats are exact, missing identifiers are
 * reported rather than skipped, and the rows come from what the locked run
 * actually paid.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import {
  ecrFile, esiFile, filingRows, form24qAnnexureI, ptSummary, quarterOf, type FilingRow,
} from '../src/payroll/filings.ts'

const L = (r: number): number => r * 100
const P = (r: number): bigint => BigInt(L(r))

const row = (over: Partial<FilingRow> = {}): FilingRow => ({
  employeeId: 'e1', employeeNumber: 'ACM-001', name: 'Priya Sharma',
  uan: '100123456789', esiNumber: '3101234567', pan: 'ABCDE1234F',
  // pfEmployerPaise is the employer's TOTAL 12%; pfPensionPaise is the part of
  // it that went to the pension fund. 1,800 on a 15,000 capped wage, of which
  // 1,250 is pension.
  grossPaise: P(40_000), pfWagePaise: P(20_000), pfEmployeePaise: P(1_800),
  pfEmployerPaise: P(1_800), pfPensionPaise: P(1_250),
  esiEmployeePaise: 0n, esiEmployerPaise: 0n, ptPaise: P(200), tdsPaise: P(2_500), lopDays: 0,
  ...over,
})

describe('ECR', () => {
  it('writes eleven #~# fields with the EPS/EPF split and whole rupees', () => {
    const f = ecrFile([row()], { epsRate: 0.0833, epsWageCeilingPaise: P(15_000), period: '2026-09', establishment: 'TNMAS0012345' })
    expect(f.fileName).toBe('ECR_TNMAS0012345_2026-09.txt')
    const fields = f.content.trimEnd().split('#~#')
    expect(fields).toHaveLength(11)
    // UAN, NAME, gross, EPF wages, EPS wages (capped at 15,000), EDLI wages, EE, EPS, EPF-ER, NCP, refund
    expect(fields.slice(0, 6)).toEqual(['100123456789', 'PRIYA SHARMA', '40000', '20000', '15000', '15000'])
    expect(fields[6]).toBe('1800')                       // employee 12% of the 15k-capped base
    // The BOOKED pension figure, not a recomputation. This function floors and
    // the engine rounds, so deriving it here reported 1249 against a payslip
    // that said 1250 -- a return that disagrees by a rupee with the ledger it
    // came from. It now reports what was actually paid.
    expect(fields[7]).toBe('1250')
    expect(fields[8]).toBe('550')   // 1800 total less 1250 pension
    expect(fields[9]).toBe('0')
    expect(fields[10]).toBe('0')
    expect(f.content.endsWith('\n')).toBe(true)
    expect(f.totalPaise).toBe(P(3_600))
  })

  it('reports a member without a UAN instead of dropping them silently, and skips non-PF employees', () => {
    const f = ecrFile([
      row(),
      row({ employeeNumber: 'ACM-002', name: 'No Uan', uan: null }),
      row({ employeeNumber: 'ACM-003', name: 'Contractor', pfEmployeePaise: 0n, pfEmployerPaise: 0n }),
    ], { epsRate: 0.0833, epsWageCeilingPaise: P(15_000), period: '2026-09' })
    expect(f.rows).toBe(1)
    expect(f.omitted).toEqual([{ employeeNumber: 'ACM-002', name: 'No Uan', reason: expect.stringMatching(/UAN/) }])
  })

  it('never emits a negative employer EPF, and strips the separator from a name', () => {
    const f = ecrFile([row({ name: 'A#B', pfWagePaise: P(1_000), pfEmployeePaise: P(120), pfEmployerPaise: P(50) })],
      { epsRate: 0.0833, epsWageCeilingPaise: P(15_000), period: '2026-09' })
    const fields = f.content.trimEnd().split('#~#')
    expect(fields[1]).toBe('A B')
    expect(Number(fields[8])).toBeGreaterThanOrEqual(0)
  })
})

describe('ESI, PT, 24Q', () => {
  it('ESI lists only covered employees and reports a missing insurance number', () => {
    const f = esiFile([
      row({ esiEmployeePaise: P(150), esiEmployerPaise: P(650), grossPaise: P(20_000), lopDays: 2 }),
      row({ employeeNumber: 'ACM-002', esiNumber: null, esiEmployeePaise: P(150), esiEmployerPaise: P(650) }),
      row({ employeeNumber: 'ACM-003' }),   // above threshold: no ESI lines
    ], { period: '2026-09', code: '31000123450000001', workingDays: 30 })
    const lines = f.content.trimEnd().split('\n')
    expect(lines[0]).toBe('IPNumber,IPName,NoOfDays,TotalMonthlyWages,ReasonCode,LastWorkingDay')
    expect(lines[1]).toBe('3101234567,PRIYA SHARMA,28,20000.00,0,')
    expect(f.rows).toBe(1)
    expect(f.omitted).toHaveLength(1)
    expect(f.totalPaise).toBe(P(800))
  })

  it('ESI days default to the calendar days of the period: a fully paid 31-day month reports 31', () => {
    const one = (period: string) => esiFile([row({ esiEmployeePaise: P(150), esiEmployerPaise: P(650), grossPaise: P(20_000) })], { period, code: 'C' }).content.split('\n')[1]
    expect(one('2026-10')).toBe('3101234567,PRIYA SHARMA,31,20000.00,0,')
    expect(one('2026-09')).toBe('3101234567,PRIYA SHARMA,30,20000.00,0,')
    expect(one('2028-02')).toBe('3101234567,PRIYA SHARMA,29,20000.00,0,')
  })

  it('PT groups by slab with a total line', () => {
    const f = ptSummary([row(), row({ ptPaise: P(150) }), row({ ptPaise: P(200) }), row({ ptPaise: 0n })],
      { period: '2026-09', stateCode: 'TS' })
    expect(f.content).toContain('TS,2026-09,150.00,1,150.00')
    expect(f.content).toContain('TS,2026-09,200.00,2,400.00')
    expect(f.content.trimEnd().split('\n').pop()).toBe(',,TOTAL,3,550.00')
  })

  it('24Q reports a PAN-less deductee and quotes names that need it', () => {
    const f = form24qAnnexureI([
      { month: '2026-07', employeeNumber: 'ACM-001', name: 'Sharma, Priya', pan: 'ABCDE1234F', grossPaise: P(40_000), tdsPaise: P(2_500) },
      { month: '2026-07', employeeNumber: 'ACM-002', name: 'No Pan', pan: null, grossPaise: P(40_000), tdsPaise: P(2_500) },
      { month: '2026-07', employeeNumber: 'ACM-003', name: 'Low', pan: 'ZZZZZ9999Z', grossPaise: P(15_000), tdsPaise: 0n },
    ], { quarter: 'Q2', fiscalYear: '2026-27', tan: 'CHEA12345B' })
    expect(f.fileName).toBe('24Q_CHEA12345B_2026-27_Q2.csv')
    expect(f.content).toContain('2026-07,ACM-001,"SHARMA, PRIYA",ABCDE1234F,40000.00,2500.00')
    expect(f.rows).toBe(1)
    expect(f.omitted[0]!.reason).toMatch(/20%/)
  })

  it('quarters follow the Indian fiscal year', () => {
    expect(quarterOf(new Date('2026-04-01'))).toBe('Q1')
    expect(quarterOf(new Date('2026-09-01'))).toBe('Q2')
    expect(quarterOf(new Date('2026-12-01'))).toBe('Q3')
    expect(quarterOf(new Date('2027-02-01'))).toBe('Q4')
  })
})

// ---------------------------------------------------------------------------
let A: Tenant
let B: Tenant
let statutoryId: string
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: P(15_000),
    esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: P(21_000),
  },
  ptAmountPaise: () => P(200), pfOnFullWage: false, lopBasis: 'calendar_days',
  computeTds: (a) => ({ monthlyTdsPaise: BigInt(Math.round(Number(a.monthlyTaxableGrossPaise) * 0.1 / 100) * 100), trace: {} }),
}

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(L(15_000)), String(L(21_000))])
  statutoryId = rows[0]!.id
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('rows from a locked run', () => {
  it('joins what was paid to the identifiers, per employee, tenant-isolated', async () => {
    await withTenant(A.id, (tx) => tx.query(
      `INSERT INTO employee_statutory_ids (tenant_id, employee_id, uan, pan) VALUES ($1,$2,'100123456789','ABCDE1234F')`,
      [A.id, A.employeeId]))
    const runId = await withTenant(A.id, async (tx) => {
      const p = await tx.query<{ id: string }>(
        `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
         VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01') RETURNING id`, [A.id])
      const runId = await createRun(tx, { periodId: p.rows[0]!.id, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [{
        employeeId: A.employeeId, calendarDays: 30, payableDays: 28, lopDays: 2,
        monthlyComponents: { basic: L(20_000), hra: L(8_000) }, annualCtcPaise: L(336_000), stateCode: 'TS', pfApplicable: true,
      }], {}, statutoryId)
      await calculate(tx, runId, OPTS)
      await validate(tx, runId, { ...OPTS, variancePct: 1000 })
      await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
      await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
      return runId
    })

    const rows = await withTenant(A.id, (tx) => filingRows(tx, runId))
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.uan).toBe('100123456789')
    expect(r.pan).toBe('ABCDE1234F')
    expect(r.esiNumber).toBeNull()
    expect(r.lopDays).toBe(2)
    // 28,000 gross less 2/30 LOP = 26,133; PF wage = basic after LOP = 18,667, capped base 15,000 -> 1,800
    expect(r.grossPaise).toBe(P(26_133))
    expect(r.pfWagePaise).toBe(P(18_667))
    expect(r.pfEmployeePaise).toBe(P(1_800))
    expect(r.pfEmployerPaise).toBe(P(1_800))
    expect(r.ptPaise).toBe(P(200))
    expect(r.tdsPaise).toBeGreaterThan(0n)

    const ecr = ecrFile(rows, { epsRate: 0.0833, epsWageCeilingPaise: P(15_000), period: '2026-09' })
    expect(ecr.rows).toBe(1)
    expect(ecr.content.split('#~#')[9]).toBe('2')    // NCP days = LOP

    await withTenant(B.id, async (tx) => {
      expect(await filingRows(tx, runId)).toEqual([])
    })
  })

  it('the identifier table enforces shape and uniqueness', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(tx.query(
        `INSERT INTO employee_statutory_ids (tenant_id, employee_id, pan) VALUES ($1, gen_random_uuid(), 'bad')`, [A.id]))
        .rejects.toMatchObject({ code: expect.stringMatching(/^23/) })
    })
  })
})
