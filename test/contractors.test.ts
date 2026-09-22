/**
 * Contractors, LWF and bonus (C5). TDS arithmetic: section × entity × PAN,
 * thresholds per FY, never on GST, recomputed at approval once the FY total
 * crosses the line. A contractor cannot be frozen into a payroll run; an
 * invoice is never deleted; the 26Q register names missing PANs. LWF lands
 * as LWF_EE / LWF_ER only in the state's collection months. Bonus Act: the
 * ₹21,000 gate and the ₹7,000 basis.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { tdsRate, tdsApplies, computeInvoice, setTerms, submitInvoice, decideInvoice, markInvoicePaid, listInvoices, removeTerms, tdsRegister26Q, statutoryBonus } from '../src/payroll/contractors.ts'
import { lwfFor, loadStatutory } from '../src/payroll/statutory.ts'
import { createRun, freezeInputs, calculate } from '../src/payroll/run.ts'
import type { EngineOptions } from '../src/payroll/engine.ts'

let A: Tenant; let hrUser: string; let vendor: string
const L = (r: number): number => r * 100
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'khr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    vendor = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-V1','Vendor',DATE '2026-04-01') RETURNING id`, [A.id])).rows[0]!.id
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('TDS arithmetic', () => {
  it('rates by section and entity; 20% without PAN; thresholds per FY', () => {
    expect(tdsRate('194C', 'individual', true)).toBe(1)
    expect(tdsRate('194C', 'company', true)).toBe(2)
    expect(tdsRate('194J', 'firm', true)).toBe(10)
    expect(tdsRate('194J', 'firm', false)).toBe(20)
    expect(tdsRate('194J', 'firm', true, 2)).toBe(2)        // technical services override
    expect(tdsApplies('194C', L(25_000), L(50_000))).toBe(false)
    expect(tdsApplies('194C', L(35_000), 0)).toBe(true)     // single invoice over 30k
    expect(tdsApplies('194C', L(25_000), L(80_000))).toBe(true)
    expect(tdsApplies('194J', L(40_000), 0)).toBe(false)
    expect(tdsApplies('194J', L(40_000), L(20_000))).toBe(true)
    const c = computeInvoice({ tds_section: '194J', entity_type: 'individual', pan: 'ABCPE1234F', tds_rate_pct: null }, L(80_000), L(14_400), 0)
    expect(c).toEqual({ section: '194J', ratePct: 10, tdsPaise: L(8_000), netPaise: L(86_400) })   // TDS on fees, not GST
  })
})

describe('contractor invoices', () => {
  it('terms take the person off payroll; TDS follows the FY threshold; paid needs a reference; 26Q register', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(setTerms(tx, { employeeId: vendor, pan: 'BAD' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const t = await setTerms(tx, { employeeId: vendor, pan: 'ABCPE1234F', tdsSection: '194J', rateType: 'monthly', ratePaise: L(40_000) })
      expect(t).toMatchObject({ entity_type: 'individual', tds_section: '194J' })
      expect((await tx.query<{ t: string }>(`SELECT employment_type AS t FROM employees WHERE id = $1`, [vendor])).rows[0]!.t).toBe('consultant')
      // October: 40k → under the 50k 194J threshold → no TDS yet
      const i1 = await submitInvoice(tx, { employeeId: vendor, invoiceNo: 'INV-1', invoiceDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', submittedByUserId: hrUser })
      expect(i1).toMatchObject({ amount_paise: String(L(40_000)), tds_paise: '0', net_paise: String(L(40_000)), status: 'submitted' })
      await expect(submitInvoice(tx, { employeeId: vendor, invoiceNo: 'INV-1', invoiceDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', submittedByUserId: hrUser })).rejects.toMatchObject({ code: 'DUPLICATE_INVOICE' })
      await expect(submitInvoice(tx, { employeeId: vendor, invoiceNo: 'INV-G', invoiceDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', gstPaise: L(7_200), submittedByUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // GST with no GSTIN
      await expect(submitInvoice(tx, { employeeId: A.employeeId, invoiceNo: 'X', invoiceDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', amountPaise: 1, submittedByUserId: hrUser })).rejects.toMatchObject({ code: 'NOT_CONTRACTOR' })
      await decideInvoice(tx, { id: i1.id, status: 'approved', actorUserId: hrUser })
      // November: 40k + 40k = 80k crosses 50k → 10% on this invoice
      const i2 = await submitInvoice(tx, { employeeId: vendor, invoiceNo: 'INV-2', invoiceDate: '2026-11-30', periodStart: '2026-11-01', periodEnd: '2026-11-30', submittedByUserId: hrUser })
      expect(i2).toMatchObject({ tds_rate_pct: '10.00', tds_paise: String(L(4_000)), net_paise: String(L(36_000)) })
      await expect(markInvoicePaid(tx, { id: i2.id, paymentRef: 'UTR1' })).rejects.toMatchObject({ code: 'INVOICE_STATE' })   // not approved
      await expect(decideInvoice(tx, { id: i2.id, status: 'rejected', actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // reason
      await decideInvoice(tx, { id: i2.id, status: 'approved', actorUserId: hrUser })
      await expect(markInvoicePaid(tx, { id: i2.id, paymentRef: ' ' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      expect((await markInvoicePaid(tx, { id: i2.id, paymentRef: 'UTR 999' })).status).toBe('paid')
      expect((await listInvoices(tx, { employeeId: vendor, status: 'paid' })).length).toBe(1)
      const reg = await tdsRegister26Q(tx, { from: '2026-10-01', to: '2026-12-31' })
      expect(reg.rows).toEqual([{ employee_name: 'Vendor', pan: 'ABCPE1234F', section: '194J', invoices: 1, amount_paise: L(40_000), tds_paise: L(4_000) }])
      expect(reg.missingPan).toEqual([])
      // a contractor cannot be frozen into a run
      const periodId = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,'2026-10',DATE '2026-10-01',DATE '2026-10-31',DATE '2026-11-01') RETURNING id`, [A.id])).rows[0]!.id
      const runId = await createRun(tx, { periodId, processedByUserId: hrUser })
      await expect(freezeInputs(tx, runId, [{ employeeId: vendor, calendarDays: 31, payableDays: 31, lopDays: 0, monthlyComponents: { basic: L(40_000) }, annualCtcPaise: L(480_000), stateCode: 'KA' }], {}, '00000000-0000-0000-0000-000000000000')).rejects.toMatchObject({ code: 'CONTRACTOR_NOT_ON_PAYROLL' })
      await expect(removeTerms(tx, vendor)).rejects.toMatchObject({ code: 'INVOICES_OPEN' })   // i1 is approved, not yet paid
    })
    await expect(withTenant(A.id, (tx) => tx.query(`DELETE FROM contractor_invoices`))).rejects.toThrow(/permission denied/i)
  })
})

describe('LWF and bonus', () => {
  it('LWF only in collection months and lands on the payslip; bonus gate and basis', async () => {
    await controlPool.query('TRUNCATE statutory_configs CASCADE')
    await controlPool.query(`DELETE FROM lwf_rates WHERE state_code = 'MH'`)
    const { rows } = await controlPool.query<{ id: string }>(`INSERT INTO statutory_configs (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise, esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise) VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`, [String(L(15_000)), String(L(21_000))])
    await controlPool.query(`INSERT INTO lwf_rates (state_code, effective_from, employee_paise, employer_paise, deduction_months) VALUES ('MH', DATE '2026-04-01', 2500, 7500, '{6,12}')`)
    const rates = [{ state_code: 'MH', employee_paise: '2500', employer_paise: '7500', deduction_months: [6, 12], wage_ceiling_paise: null }]
    expect(lwfFor(rates, 'MH', 12, BigInt(L(50_000)))).toEqual({ employee: 2500n, employer: 7500n })
    expect(lwfFor(rates, 'MH', 11, BigInt(L(50_000)))).toEqual({ employee: 0n, employer: 0n })
    expect(lwfFor(rates, 'KA', 12, BigInt(L(50_000)))).toEqual({ employee: 0n, employer: 0n })
    await withTenant(A.id, async (tx) => {
      const statutory = await loadStatutory(tx, '2026-12-01')
      expect(statutory.lwfRates.find((r) => r.state_code === 'MH')).toBeTruthy()
      const OPTS: EngineOptions = { statutory: statutory.config, ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days' }
      const run = async (label: string, start: string, end: string): Promise<Record<string, string>> => {
        const periodId = (await tx.query<{ id: string }>(`INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date) VALUES ($1,$2,$3::date,$4::date,$4::date + 1) RETURNING id`, [A.id, label, start, end])).rows[0]!.id
        const runId = await createRun(tx, { periodId, processedByUserId: hrUser })
        await freezeInputs(tx, runId, [{ employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0, monthlyComponents: { basic: L(30_000) }, annualCtcPaise: L(360_000), stateCode: 'MH' }], {}, rows[0]!.id)
        await calculate(tx, runId, { ...OPTS, lwfRates: statutory.lwfRates })
        const lines = (await tx.query<{ c: string; a: string }>(`SELECT component_code AS c, amount_paise::text AS a FROM payroll_lines WHERE run_id = $1`, [runId])).rows
        return Object.fromEntries(lines.map((l) => [l.c, l.a]))
      }
      const dec = await run('2026-12', '2026-12-01', '2026-12-31')
      expect(dec.LWF_EE).toBe('2500'); expect(dec.LWF_ER).toBe('7500')
      const nov = await run('2026-11', '2026-11-01', '2026-11-30')
      expect(nov.LWF_EE).toBeUndefined()
    })
    expect(statutoryBonus({ monthlyWagePaise: L(25_000), monthsWorked: 12, daysWorked: 300, ratePct: 8.33 })).toMatchObject({ eligible: false })
    expect(statutoryBonus({ monthlyWagePaise: L(15_000), monthsWorked: 12, daysWorked: 20, ratePct: 8.33 })).toMatchObject({ eligible: false })
    expect(statutoryBonus({ monthlyWagePaise: L(15_000), monthsWorked: 12, daysWorked: 300, ratePct: 8.33 })).toEqual({ eligible: true, basisPaise: L(7_000), bonusPaise: L(6_997) })   // 7000×12×8.33%
    expect(statutoryBonus({ monthlyWagePaise: L(6_000), monthsWorked: 6, daysWorked: 150, ratePct: 20 })).toEqual({ eligible: true, basisPaise: L(6_000), bonusPaise: L(7_200) })
    expect(statutoryBonus({ monthlyWagePaise: L(15_000), monthsWorked: 12, daysWorked: 300, ratePct: 8.33, minimumWagePaise: L(9_000) })).toMatchObject({ basisPaise: L(9_000) })
  })
})
