/**
 * Form 16 Part B agrees with the payslips and the declaration it is built
 * from: gross is the year's locked earnings, exempt lines and the HRA
 * exemption come off, Chapter VI-A from the VERIFIED declaration, tax by the
 * year's slabs, TDS as actually deducted, and a PDF renders.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'
import { approve, calculate, createRun, freezeInputs, lock, validate } from '../src/payroll/run.ts'
import { saveDeclaration, submitDeclaration, verifyDeclaration } from '../src/payroll/declarations.ts'
import { buildForm16, form16Pdf } from '../src/payroll/form16.ts'
import { taxOnIncome, type TaxRules, type TaxSlab } from '../src/payroll/tds.ts'

const L = (r: number): number => r * 100
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const APPROVER = '60000000-0000-0000-0000-000000000006'
let A: Tenant
let statutoryId: string
const SLABS: TaxSlab[] = [
  { income_from_paise: '0', income_to_paise: String(L(300_000)), rate: '0' },
  { income_from_paise: String(L(300_000)), income_to_paise: String(L(700_000)), rate: '0.05' },
  { income_from_paise: String(L(700_000)), income_to_paise: null, rate: '0.1' },
]
const RULES: TaxRules = { standard_deduction_paise: String(L(75_000)), rebate_limit_paise: '0', rebate_max_paise: '0', cess_rate: '0.04', surcharge_bands: [] }
const OPTS: EngineOptions = {
  statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
    esi_employee_rate: 0, esi_employer_rate: 0, esi_gross_threshold_paise: 0n },
  ptAmountPaise: () => BigInt(L(200)), pfOnFullWage: false, lopBasis: 'calendar_days',
  computeTds: () => ({ monthlyTdsPaise: BigInt(L(2_000)), trace: {} }),      // a flat figure; Form 16 reports what was deducted
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs CASCADE')
  statutoryId = (await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0, 0, 0) RETURNING id`, [String(L(15_000))])).rows[0]!.id
  await withTenant(A.id, async (tx) => {
    await tx.query(`INSERT INTO employee_statutory_ids (tenant_id, employee_id, pan) VALUES ($1,$2,'ABCDE1234F')`, [A.id, A.employeeId])
    // old regime, 80C 1.2L, rent 2.4L in a metro
    await saveDeclaration(tx, { employeeId: A.employeeId, fiscalYear: '2026-27', regime: 'old', declared: { section80cPaise: L(120_000), rentPaidAnnualPaise: L(240_000), metro: true } })
    await submitDeclaration(tx, A.employeeId, '2026-27')
    const d = (await tx.query<{ id: string }>(`SELECT id FROM tax_declarations WHERE employee_id = $1`, [A.employeeId])).rows[0]!
    await verifyDeclaration(tx, { id: d.id, verifiedByUserId: APPROVER })
    // three locked months: basic 40,000, HRA 16,000, FUEL 3,000 tax-free
    for (const [label, start, end] of [['2026-04', '2026-04-01', '2026-04-30'], ['2026-05', '2026-05-01', '2026-05-31'], ['2026-06', '2026-06-01', '2026-06-30']]) {
      const p = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id
      const run = await createRun(tx, { periodId: p, processedByUserId: PROCESSOR })
      await freezeInputs(tx, run, [{ employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { BASIC: L(40_000), HRA: L(16_000), FUEL: L(3_000) }, annualCtcPaise: L(708_000), stateCode: 'TS', pfApplicable: true, taxRegime: 'old' }], {}, statutoryId)
      await calculate(tx, run, { ...OPTS, components: { pfWageCodes: new Set(['BASIC']), nonTaxableCodes: new Set(['FUEL']), nonEsiCodes: new Set() } })
      await validate(tx, run, { ...OPTS, variancePct: 1000 })
      await approve(tx, run, APPROVER, { requireSeparateApprover: true }); await lock(tx, run, APPROVER, { requireSeparateApprover: true })
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('Form 16 Part B', () => {
  it('composes the year from locked runs and the verified declaration, and every line reconciles', async () => {
    const f = await withTenant(A.id, (tx) => buildForm16(tx, { employeeId: A.employeeId, fiscalYear: '2026-27', slabs: { old: SLABS, new: SLABS }, rules: { old: RULES, new: RULES }, tan: 'CHEA12345B' }))
    expect(f.months).toBe(3)
    expect(f.regime).toBe('old')
    expect(f.employee.pan).toBe('ABCDE1234F')
    expect(f.grossSalaryPaise).toBe(L(59_000) * 3)
    // exempt: FUEL 9,000 + HRA exemption on the year's basic (1.2L) and HRA (48k): min(48k, 2.4L−12k, 60k) = 48,000
    expect(f.chapterVia.hraExemptionPaise).toBe(L(48_000))
    expect(f.exemptAllowancesPaise).toBe(L(9_000) + L(48_000))
    expect(f.professionalTaxPaise).toBe(L(600))
    expect(f.incomeFromSalaryPaise).toBe(L(177_000) - L(57_000) - L(75_000) - L(600))
    // 80C 1.2L allowed in full (cap 1.5L)
    expect(f.chapterVia.totalPaise - f.chapterVia.hraExemptionPaise).toBe(L(120_000))
    expect(f.taxableIncomePaise).toBe(0)                                     // 44,400 − 1.2L floors at 0
    expect(f.totalTaxPaise).toBe(0)
    expect(f.tdsDeductedPaise).toBe(L(6_000))
    expect(f.balancePaise).toBe(-L(6_000))                                    // refund due
    expect(f.notes.some((n) => /Part A/.test(n))).toBe(true)
    expect(f.notes.some((n) => /3 month/.test(n))).toBe(true)
  })

  it('applies slabs and cess when income is taxable, and refuses a year with no pay', async () => {
    const richSlabs = { old: SLABS, new: SLABS }
    // reject the declaration so no Chapter VI-A applies, and drop the standard deduction: 1.19L becomes taxable
    await withTenant(A.id, (tx) => tx.query(`UPDATE tax_declarations SET status = 'rejected' WHERE employee_id = $1`, [A.employeeId]))
    const f = await withTenant(A.id, (tx) => buildForm16(tx, { employeeId: A.employeeId, fiscalYear: '2026-27', slabs: richSlabs,
      rules: { old: { ...RULES, standard_deduction_paise: '0' }, new: RULES } }))
    const taxable = f.taxableIncomePaise
    expect(taxable).toBe(L(177_000) - L(9_000) - L(600))                      // no HRA exemption either: unverified
    expect(f.chapterVia.totalPaise).toBe(0)
    await withTenant(A.id, (tx) => tx.query(`UPDATE tax_declarations SET status = 'verified' WHERE employee_id = $1`, [A.employeeId]))
    expect(f.taxOnIncomePaise).toBe(Math.round(taxOnIncome(taxable, SLABS)))
    expect(f.cessPaise).toBe(Math.round(f.taxOnIncomePaise * 0.04))
    await expect(withTenant(A.id, (tx) => buildForm16(tx, { employeeId: A.employeeId, fiscalYear: '2025-26', slabs: richSlabs, rules: { old: RULES, new: RULES } })))
      .rejects.toMatchObject({ code: 'NO_PAY_IN_YEAR' })
  })

  it('renders a one-page PDF', async () => {
    const f = await withTenant(A.id, (tx) => buildForm16(tx, { employeeId: A.employeeId, fiscalYear: '2026-27', slabs: { old: SLABS, new: SLABS }, rules: { old: RULES, new: RULES } }))
    const pdf = form16Pdf(f)
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.toString('latin1')).toContain('FORM NO. 16')
    expect(pdf.length).toBeGreaterThan(1500)
  })
})
