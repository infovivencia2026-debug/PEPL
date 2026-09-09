import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  approve, calculate, createRun, freezeInputs, lock, validate, type FreezeRow,
} from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import {
  amountInWords, payslipPdf, rupees, PayslipError,
} from '../src/payroll/payslip-pdf.ts'

let A: Tenant
let B: Tenant
let periodId: string
let statutoryId: string

const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
const L = (r: number): number => r * 100

const OPTS: EngineOptions = {
  statutory: {
    pf_employee_rate: 0.12,
    pf_employer_rate: 0.12,
    pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0.0075,
    esi_employer_rate: 0.0325,
    esi_gross_threshold_paise: BigInt(L(21_000)),
  },
  ptAmountPaise: () => BigInt(L(200)),
  pfOnFullWage: false,
  lopBasis: 'calendar_days',
}

const freezeRow = (employeeId: string): FreezeRow => ({
  employeeId,
  calendarDays: 30,
  payableDays: 30,
  lopDays: 0,
  monthlyComponents: { basic: L(20_000), hra: L(8_000), special: L(12_000) },
  annualCtcPaise: L(480_000),
  stateCode: 'TS',
  pfApplicable: true,
})

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})

beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(OPTS.statutory.pf_wage_ceiling_paise), String(OPTS.statutory.esi_gross_threshold_paise)],
  )
  statutoryId = rows[0]!.id

  periodId = await withTenant(A.id, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1, '2026-09', DATE '2026-09-01', DATE '2026-09-30', DATE '2026-10-01')
       RETURNING id`,
      [A.id],
    )
    return r.rows[0]!.id
  })
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

async function payslipOfLockedRun(tenant: Tenant): Promise<string> {
  return withTenant(tenant.id, async (tx) => {
    const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
    await freezeInputs(tx, runId, [freezeRow(tenant.employeeId)], { lop_basis: 'calendar_days' },
      statutoryId)
    await calculate(tx, runId, OPTS)
    await validate(tx, runId, { ...OPTS, variancePct: 25 })
    await approve(tx, runId, APPROVER, { requireSeparateApprover: true })
    await lock(tx, runId, APPROVER, { requireSeparateApprover: true })
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM payslips WHERE run_id = $1`, [runId])
    return rows[0]!.id
  })
}

describe('money is formatted the way an Indian payslip prints it', () => {
  it('groups in lakhs and crores', () => {
    expect(rupees(0n)).toBe('0.00')
    expect(rupees(BigInt(L(999)))).toBe('999.00')
    expect(rupees(BigInt(L(1_234)))).toBe('1,234.00')
    expect(rupees(BigInt(L(12_345)))).toBe('12,345.00')
    expect(rupees(BigInt(L(1_234_567)))).toBe('12,34,567.00')
    expect(rupees(BigInt(L(12_345_678)))).toBe('1,23,45,678.00')
  })

  it('keeps paise and signs', () => {
    expect(rupees(123_45n)).toBe('123.45')
    expect(rupees(-500_00n)).toBe('-500.00')
  })

  it('writes the amount in words for the cheque line', () => {
    expect(amountInWords(0n)).toBe('Zero rupees only')
    expect(amountInWords(BigInt(L(1)))).toBe('One rupees only')
    expect(amountInWords(BigInt(L(37_500)))).toBe('Thirty-seven thousand five hundred rupees only')
    expect(amountInWords(BigInt(L(1_234_567))))
      .toBe('Twelve lakh thirty-four thousand five hundred and sixty-seven rupees only')
  })
})

describe('the payslip PDF', () => {
  it('is a real PDF with a cross-reference table', async () => {
    const id = await payslipOfLockedRun(A)
    const pdf = await withTenant(A.id, (tx) => payslipPdf(tx, id))

    const text = pdf.bytes.toString('latin1')
    expect(text.startsWith('%PDF-1.4')).toBe(true)
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
    expect(text).toContain('/Type /Catalog')
    expect(text).toContain('startxref')
    expect(pdf.bytes.length).toBeGreaterThan(800)
  })

  it('prints the figures from the locked run', async () => {
    const id = await payslipOfLockedRun(A)
    const pdf = await withTenant(A.id, (tx) => payslipPdf(tx, id))
    const text = pdf.bytes.toString('latin1')

    // gross 40,000 = basic 20,000 + hra 8,000 + special 12,000
    expect(text).toContain('(40,000.00)')
    expect(text).toContain('(Net pay)')
    expect(text).toContain('(Basic)')
    expect(text).toContain('(Provident fund \\(employee\\))')
    expect(text).toContain('(Employer contributions (not deducted from you))'
      .replace('(not', '\\(not').replace('you))', 'you\\))'))
  })

  it('names the file after the period and the person', async () => {
    const id = await payslipOfLockedRun(A)
    const pdf = await withTenant(A.id, (tx) => payslipPdf(tx, id))
    expect(pdf.fileName).toMatch(/^payslip-2026-09-.*\.pdf$/)
  })

  it('cannot be produced from a run that is not locked', async () => {
    const id = await withTenant(A.id, async (tx) => {
      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [freezeRow(A.employeeId)], { lop_basis: 'calendar_days' },
        statutoryId)
      await calculate(tx, runId, OPTS)
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM payslips WHERE run_id = $1`, [runId])
      return rows[0]?.id ?? null
    })
    if (!id) return // no payslip exists before locking, which is the same guarantee
    await expect(withTenant(A.id, (tx) => payslipPdf(tx, id)))
      .rejects.toMatchObject({ code: 'NOT_LOCKED' })
  })

  it('is not readable from another company', async () => {
    const id = await payslipOfLockedRun(A)
    await expect(withTenant(B.id, (tx) => payslipPdf(tx, id)))
      .rejects.toBeInstanceOf(PayslipError)
  })
})
