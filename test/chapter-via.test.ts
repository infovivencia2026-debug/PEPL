import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { allowableDeductions, capsFor, hraExemption } from '../src/payroll/chapter-via.ts'
import {
  allowanceFor, getDeclaration, listDeclarations, rejectDeclaration, saveDeclaration,
  submitDeclaration, verifyDeclaration, DeclarationError,
} from '../src/payroll/declarations.ts'
import { createRun, freezeInputs, calculate } from '../src/payroll/run.ts'
import { computeTds } from '../src/payroll/tds.ts'

const L = (rupees: number): number => rupees * 100
const FY = '2026-27'
const SALARY = { basicAnnualPaise: L(240_000), hraAnnualPaise: L(96_000) }

// ---------------------------------------------------------------------------
// Pure: caps and HRA
// ---------------------------------------------------------------------------
describe('chapter VI-A caps', () => {
  it('80C stops at 1.5 lakh, 80CCD(1B) at 50k, 80D self at 25k', () => {
    const a = allowableDeductions(
      { section80cPaise: L(400_000), section80ccd1bPaise: L(100_000), section80dSelfPaise: L(60_000) },
      SALARY, FY, 'old')
    const by = Object.fromEntries(a.lines.map((l) => [l.section, l.allowedPaise]))
    expect(by['80C']).toBe(L(150_000))
    expect(by['80CCD(1B)']).toBe(L(50_000))
    expect(by['80D self']).toBe(L(25_000))
    expect(a.totalPaise).toBe(L(225_000))
  })

  it('80D parents doubles for senior citizens', () => {
    const junior = allowableDeductions({ section80dParentsPaise: L(60_000) }, SALARY, FY, 'old')
    const senior = allowableDeductions({ section80dParentsPaise: L(60_000), parentsSenior: true }, SALARY, FY, 'old')
    expect(junior.totalPaise).toBe(L(25_000))
    expect(senior.totalPaise).toBe(L(50_000))
  })

  it('80E has no ceiling; 80G is recorded but never allowed through payroll', () => {
    const a = allowableDeductions({ section80ePaise: L(900_000), section80gPaise: L(50_000) }, SALARY, FY, 'old')
    expect(a.totalPaise).toBe(L(900_000))
    expect(a.notes.join(' ')).toMatch(/80G/)
  })

  it('the new regime allows nothing and says so', () => {
    const a = allowableDeductions({ section80cPaise: L(150_000), rentPaidAnnualPaise: L(240_000) }, SALARY, FY, 'new')
    expect(a.totalPaise).toBe(0)
    expect(a.hraExemptionPaise).toBe(0)
    expect(a.notes.length).toBeGreaterThan(0)
  })

  it('a fiscal year not yet entered falls back to the latest known caps', () => {
    expect(capsFor('2099-00')).toEqual(capsFor('2026-27'))
  })
})

describe('HRA exemption', () => {
  it('is the least of HRA received, rent minus 10% basic, and 50%/40% of basic', () => {
    // rent 2.4L - 24k = 2.16L ; 50% basic = 1.2L ; HRA = 96k -> 96k
    expect(hraExemption({ rentPaidAnnualPaise: L(240_000), metro: true }, SALARY)).toBe(L(96_000))
    // low rent: 60k - 24k = 36k is the binding leg
    expect(hraExemption({ rentPaidAnnualPaise: L(60_000), metro: true }, SALARY)).toBe(L(36_000))
    // non-metro with a big HRA: 40% of basic binds
    expect(hraExemption({ rentPaidAnnualPaise: L(500_000) },
      { basicAnnualPaise: L(240_000), hraAnnualPaise: L(200_000) })).toBe(L(96_000))
  })

  it('is zero without rent, without HRA, or when rent is under 10% of basic', () => {
    expect(hraExemption({}, SALARY)).toBe(0)
    expect(hraExemption({ rentPaidAnnualPaise: L(100_000) }, { ...SALARY, hraAnnualPaise: 0 })).toBe(0)
    expect(hraExemption({ rentPaidAnnualPaise: L(20_000) }, SALARY)).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Lifecycle and freeze
// ---------------------------------------------------------------------------
let A: Tenant
let B: Tenant
let periodId: string
let statutoryId: string
const PROCESSOR = '50000000-0000-0000-0000-000000000005'
const VERIFIER = '70000000-0000-0000-0000-000000000007'

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
  await controlPool.query('TRUNCATE statutory_configs, pt_slabs, tax_slabs, tax_rules CASCADE')
  const { rows } = await controlPool.query<{ id: string }>(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2) RETURNING id`,
    [String(L(15_000)), String(L(21_000))],
  )
  statutoryId = rows[0]!.id
  periodId = await withTenant(A.id, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1, '2026-09', DATE '2026-09-01', DATE '2026-09-30', DATE '2026-10-01') RETURNING id`,
      [A.id])
    return r.rows[0]!.id
  })
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('declaration lifecycle', () => {
  it('draft -> submitted -> verified, and editing a verified one returns it to draft', async () => {
    await withTenant(A.id, async (tx) => {
      const d = await saveDeclaration(tx, {
        employeeId: A.employeeId, fiscalYear: FY, regime: 'old',
        declared: { section80cPaise: L(100_000), section80dSelfPaise: 'garbage', metro: true },
      })
      expect(d.status).toBe('draft')
      // sanitised: the junk field is dropped, the boolean kept
      expect(d.declared).toEqual({ section80cPaise: L(100_000), metro: true })

      await expect(verifyDeclaration(tx, { id: d.id, verifiedByUserId: VERIFIER }))
        .rejects.toMatchObject({ code: 'DECLARATION_NOT_SUBMITTED' })

      const s = await submitDeclaration(tx, A.employeeId, FY)
      expect(s.status).toBe('submitted')
      await expect(submitDeclaration(tx, A.employeeId, FY))
        .rejects.toMatchObject({ code: 'DECLARATION_NOT_EDITABLE' })

      // Nobody verifies their own declaration: a payroll administrator is also an employee.
      await expect(verifyDeclaration(tx, { id: d.id, verifiedByUserId: VERIFIER, verifierEmployeeId: A.employeeId }))
        .rejects.toMatchObject({ code: 'SELF_VERIFICATION' })

      const v = await verifyDeclaration(tx, { id: d.id, verifiedByUserId: VERIFIER })
      expect(v.status).toBe('verified')
      expect(v.verified_by_user_id).toBe(VERIFIER)

      const again = await saveDeclaration(tx, {
        employeeId: A.employeeId, fiscalYear: FY, regime: 'old', declared: { section80cPaise: L(150_000) },
      })
      expect(again.id).toBe(d.id)
      expect(again.status).toBe('draft')
      expect(again.verified_at).toBeNull()
    })
  })

  it('rejection needs a reason and sends the employee back to editing', async () => {
    await withTenant(A.id, async (tx) => {
      await submitDeclaration(tx, A.employeeId, FY)
      const d = (await getDeclaration(tx, A.employeeId, FY))!
      await expect(rejectDeclaration(tx, { id: d.id, reason: '  ' }))
        .rejects.toBeInstanceOf(DeclarationError)
      const r = await rejectDeclaration(tx, { id: d.id, reason: 'no PPF passbook' })
      expect(r.status).toBe('rejected')
      // a rejected declaration can be resubmitted
      expect((await submitDeclaration(tx, A.employeeId, FY)).status).toBe('submitted')
      const queue = await listDeclarations(tx, FY, 'submitted')
      expect(queue.map((q) => q.id)).toContain(d.id)
    })
  })

  it('rejects a malformed fiscal year and an unknown regime', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(saveDeclaration(tx, { employeeId: A.employeeId, fiscalYear: '2026', regime: 'old', declared: {} }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(saveDeclaration(tx, { employeeId: A.employeeId, fiscalYear: FY, regime: 'x' as never, declared: {} }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })
  })

  it('is invisible from another tenant', async () => {
    await withTenant(B.id, async (tx) => {
      expect(await getDeclaration(tx, A.employeeId, FY)).toBeNull()
      expect(await listDeclarations(tx, FY)).toEqual([])
    })
  })
})

describe('freeze resolves the allowance into a value', () => {
  it('an unverified declaration deducts nothing', async () => {
    await withTenant(A.id, async (tx) => {
      // the previous test left A's declaration submitted, not verified
      const r = await allowanceFor(tx, { employeeId: A.employeeId, fiscalYear: FY, salary: SALARY })
      expect(r.allowance.totalPaise).toBe(0)
      expect(r.regime).toBe('old')
      expect(r.allowance.notes[0]).toMatch(/submitted/)
    })
  })

  it('a verified declaration lands in payroll_inputs.chapter_via_paise and lowers TDS', async () => {
    await withTenant(A.id, async (tx) => {
      const d = (await getDeclaration(tx, A.employeeId, FY))!
      await verifyDeclaration(tx, { id: d.id, verifiedByUserId: VERIFIER })

      const runId = await createRun(tx, { periodId, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [{
        employeeId: A.employeeId, calendarDays: 30, payableDays: 30, lopDays: 0,
        monthlyComponents: { basic: L(20_000), hra: L(8_000), special: L(12_000) },
        annualCtcPaise: L(480_000), stateCode: 'TS', pfApplicable: false,
        // taxRegime deliberately omitted: the declaration's regime must be used
      }], {}, statutoryId)

      const { rows } = await tx.query<{ chapter_via_paise: string; tax_regime: string }>(
        `SELECT chapter_via_paise::text, tax_regime FROM payroll_inputs WHERE run_id = $1`, [runId])
      // 80C 1.5L (the last save) + no HRA claimed
      expect(rows[0]!.chapter_via_paise).toBe(String(L(150_000)))
      expect(rows[0]!.tax_regime).toBe('old')

      // The engine sees it through the TDS hook — and only through payroll_inputs.
      const seen: bigint[] = []
      await calculate(tx, runId, {
        statutory: {
          pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
          esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)),
        },
        ptAmountPaise: () => 0n,
        pfOnFullWage: false,
        lopBasis: 'calendar_days',
        computeTds: (args) => {
          seen.push(args.declaredDeductionsPaise)
          return { monthlyTdsPaise: 0n, trace: {} }
        },
      })
      expect(seen).toEqual([BigInt(L(150_000))])
    })
  })

  it('a caller-supplied figure wins over the declaration (revisions, tests)', async () => {
    await withTenant(A.id, async (tx) => {
      // one run per period and revision: this test needs its own period
      const { rows: p } = await tx.query<{ id: string }>(
        `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
         VALUES ($1, '2026-10', DATE '2026-10-01', DATE '2026-10-31', DATE '2026-11-01') RETURNING id`, [A.id])
      const runId = await createRun(tx, { periodId: p[0]!.id, processedByUserId: PROCESSOR })
      await freezeInputs(tx, runId, [{
        employeeId: A.employeeId, calendarDays: 31, payableDays: 31, lopDays: 0,
        monthlyComponents: { basic: L(20_000) }, annualCtcPaise: L(240_000), stateCode: 'TS',
        chapterViaPaise: L(12_345),
      }], {}, statutoryId)
      const { rows } = await tx.query<{ v: string }>(
        `SELECT chapter_via_paise::text AS v FROM payroll_inputs WHERE run_id = $1`, [runId])
      expect(rows[0]!.v).toBe(String(L(12_345)))
    })
  })

  it('computeTds subtracts the declared figure under the old regime only', () => {
    const slabs = [
      { income_from_paise: '0', income_to_paise: String(L(250_000)), rate: '0' },
      { income_from_paise: String(L(250_000)), income_to_paise: null, rate: '0.2' },
    ] as never
    const rules = { standard_deduction_paise: String(L(50_000)), rebate_limit_paise: '0',
      rebate_max_paise: '0', cess_rate: '0', surcharge_bands: [] } as never
    const base = { monthlyTaxableGrossPaise: BigInt(L(40_000)), monthsRemaining: 12 }
    const without = computeTds({ ...base, regime: 'old' }, slabs, rules)
    const withDecl = computeTds({ ...base, regime: 'old', declaredDeductionsPaise: BigInt(L(150_000)) }, slabs, rules)
    const newRegime = computeTds({ ...base, regime: 'new', declaredDeductionsPaise: BigInt(L(150_000)) }, slabs, rules)
    expect(withDecl.taxableIncomePaise).toBe(without.taxableIncomePaise - BigInt(L(150_000)))
    expect(newRegime.taxableIncomePaise).toBe(without.taxableIncomePaise)
  })
})
