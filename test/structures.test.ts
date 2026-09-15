/**
 * Salary components and structures: formulas resolve to the rupee and add up,
 * a structure that cannot resolve is refused, hand-typed components are held
 * to the master once it exists, and the engine follows the master's flags.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { computePayroll, type EngineOptions } from '../src/payroll/engine.ts'
import {
  componentFlags, createComponent, createStructure, listStructures, normaliseComponents, resolveStructure,
  retireComponent, retireStructure, structureByCode, validateLines,
} from '../src/payroll/structures.ts'
import { changeCompensation } from '../src/people/history.ts'

const L = (r: number): number => r * 100
let A: Tenant
beforeAll(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

describe('resolveStructure (pure)', () => {
  const known = new Set(['BASIC', 'HRA', 'CONVEYANCE', 'SPECIAL'])
  const lines = validateLines([
    { component: 'basic', formula: { type: 'percent_of', of: 'CTC', pct: 50 } },
    { component: 'hra', formula: { type: 'percent_of', of: 'basic', pct: 40 } },
    { component: 'conveyance', formula: { type: 'fixed', paise: L(1_600) } },
    { component: 'special', formula: { type: 'balance' } },
  ], known)

  it('splits an annual figure into monthly rupees that add up exactly', () => {
    const m = resolveStructure(lines, L(600_000))          // 50,000 a month
    expect(m).toEqual({ BASIC: L(25_000), HRA: L(10_000), CONVEYANCE: L(1_600), SPECIAL: L(13_400) })
    expect(Object.values(m).reduce((n, v) => n + v, 0)).toBe(L(50_000))
    // an awkward figure: rounding lands in the balance, the total still matches
    const odd = resolveStructure(lines, 7_77_777_00)
    expect(Object.values(odd).reduce((n, v) => n + v, 0)).toBe(Math.round(7_77_777_00 / 12 / 100) * 100)
    expect(odd.BASIC! % 100).toBe(0)
  })

  it('refuses malformed lines: unknown component, reference to a later line, two balances, over-allocation', () => {
    expect(() => validateLines([{ component: 'BONUS', formula: { type: 'balance' } }], known)).toThrow(/not a defined/)
    expect(() => validateLines([
      { component: 'HRA', formula: { type: 'percent_of', of: 'BASIC', pct: 40 } },
      { component: 'BASIC', formula: { type: 'balance' } }], known)).toThrow(/listed above it/)
    expect(() => validateLines([
      { component: 'BASIC', formula: { type: 'balance' } }, { component: 'HRA', formula: { type: 'balance' } }], known)).toThrow(/exactly one/)
    expect(() => validateLines([{ component: 'BASIC', formula: { type: 'percent_of', of: 'CTC', pct: 150 } }, { component: 'HRA', formula: { type: 'balance' } }], known)).toThrow(/between 0 and 100/)
    const greedy = validateLines([
      { component: 'BASIC', formula: { type: 'percent_of', of: 'CTC', pct: 90 } },
      { component: 'HRA', formula: { type: 'fixed', paise: L(10_000) } },
      { component: 'SPECIAL', formula: { type: 'balance' } }], known)
    expect(() => resolveStructure(greedy, L(120_000))).toThrow(/above the/)     // 9,000 + 10,000 > 10,000
  })
})

describe('the master, in the database', () => {
  it('defines components, builds a structure from them, previews, and retires in the right order', async () => {
    await withTenant(A.id, async (tx) => {
      expect(await componentFlags(tx)).toBeNull()                       // no master yet: engine convention applies
      // before a master exists, free text stands
      expect(await normaliseComponents(tx, { basic: L(1) })).toEqual({ basic: L(1) })

      await createComponent(tx, { code: 'basic', name: 'Basic', kind: 'earning', pfWage: true })
      await createComponent(tx, { code: 'HRA', name: 'House rent', kind: 'earning' })
      await createComponent(tx, { code: 'FUEL', name: 'Fuel reimbursement', kind: 'earning', taxable: false, esiWage: false, billRequired: true })
      const special = await createComponent(tx, { code: 'SPECIAL', name: 'Special allowance', kind: 'earning' })
      await expect(createComponent(tx, { code: 'HRA', name: 'x', kind: 'earning' })).rejects.toMatchObject({ code: 'COMPONENT_EXISTS' })
      await expect(createComponent(tx, { code: '1BAD', name: 'x', kind: 'earning' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      // now hand-typed components are held to the master
      expect(await normaliseComponents(tx, { basic: L(1), hra: L(2) })).toEqual({ BASIC: L(1), HRA: L(2) })
      await expect(normaliseComponents(tx, { bonus: L(1) })).rejects.toMatchObject({ code: 'UNKNOWN_COMPONENT' })

      const std = await createStructure(tx, { code: 'std', name: 'Standard', gradeCodes: ['g1'], lines: [
        { component: 'BASIC', formula: { type: 'percent_of', of: 'CTC', pct: 50 } },
        { component: 'HRA', formula: { type: 'percent_of', of: 'BASIC', pct: 40 } },
        { component: 'FUEL', formula: { type: 'fixed', paise: L(2_000) } },
        { component: 'SPECIAL', formula: { type: 'balance' } },
      ] })
      expect(std.code).toBe('STD')
      expect(std.grade_codes).toEqual(['G1'])
      await expect(createStructure(tx, { code: 'BAD', name: 'x', lines: [{ component: 'GHOST', formula: { type: 'balance' } }] }))
        .rejects.toMatchObject({ code: 'UNKNOWN_COMPONENT' })

      const s = await structureByCode(tx, 'std')
      expect(resolveStructure(s.lines, L(600_000))).toEqual({ BASIC: L(25_000), HRA: L(10_000), FUEL: L(2_000), SPECIAL: L(13_000) })

      // a component in an active structure cannot be retired; the structure can, then the component
      await expect(retireComponent(tx, special.id)).rejects.toMatchObject({ code: 'COMPONENT_IN_USE' })
      await retireStructure(tx, std.id)
      expect(await listStructures(tx)).toEqual([])
      await retireComponent(tx, special.id)

      const flags = (await componentFlags(tx))!
      expect([...flags.pfWageCodes]).toEqual(['BASIC'])
      expect([...flags.nonTaxableCodes]).toEqual(['FUEL'])
      expect([...flags.nonEsiCodes]).toEqual(['FUEL'])

      // a compensation record can carry the structure it came from
      const recordId = await changeCompensation(tx, { employeeId: A.employeeId, annualCtcPaise: L(600_000),
        components: resolveStructure(s.lines, L(600_000)), structureCode: 'STD', effectiveFrom: '2026-11-01' })
      const rec = (await tx.query<{ structure_code: string; components: Record<string, number> }>(
        `SELECT structure_code, components FROM compensation_records WHERE id = $1`, [recordId])).rows[0]!
      expect(rec.structure_code).toBe('STD')
      expect(rec.components.BASIC).toBe(L(25_000))
    })
  })
})

describe('the engine follows the master', () => {
  const base: EngineOptions = {
    statutory: { pf_employee_rate: 0.12, pf_employer_rate: 0.12, pf_wage_ceiling_paise: BigInt(L(15_000)),
      esi_employee_rate: 0.0075, esi_employer_rate: 0.0325, esi_gross_threshold_paise: BigInt(L(21_000)) },
    ptAmountPaise: () => 0n, pfOnFullWage: false, lopBasis: 'calendar_days',
  }
  const input = {
    employeeId: 'e', calendarDays: 30, payableDays: 30, lopDays: 0, stateCode: 'TS',
    monthlyComponents: { BASIC: L(10_000), DA: L(2_000), FUEL: L(3_000), SPECIAL: L(5_000) },
    pfApplicable: true, esiApplicable: true, taxRegime: 'new' as const, adhoc: [],
  }

  it('by convention: basic + DA are PF wages, everything is taxable and ESI gross', () => {
    const seen: bigint[] = []
    const c = computePayroll(input, { ...base, computeTds: (a) => { seen.push(a.monthlyTaxableGrossPaise); return { monthlyTdsPaise: 0n, trace: {} } } })
    const pf = c.lines.find((l) => l.code === 'PF_EE')!
    expect(pf.note!.pfWage).toBe(L(12_000))
    expect(c.lines.find((l) => l.code === 'ESI_EE')!.note!.gross).toBe(L(20_000))
    expect(seen[0]).toBe(BigInt(L(20_000) - Math.round(L(12_000) * 0.12)))
  })

  it('with a master: only flagged codes are PF wages, FUEL is tax-free and outside ESI gross', () => {
    const seen: bigint[] = []
    const c = computePayroll(input, {
      ...base,
      components: { pfWageCodes: new Set(['BASIC']), nonTaxableCodes: new Set(['FUEL']), nonEsiCodes: new Set(['FUEL']) },
      computeTds: (a) => { seen.push(a.monthlyTaxableGrossPaise); return { monthlyTdsPaise: 0n, trace: {} } },
    })
    expect(c.lines.find((l) => l.code === 'PF_EE')!.note!.pfWage).toBe(L(10_000))
    expect(c.lines.find((l) => l.code === 'ESI_EE')!.note!.gross).toBe(L(17_000))
    expect(c.lines.find((l) => l.code === 'FUEL')!.note!.taxExempt).toBe(true)
    expect(seen[0]).toBe(BigInt(L(20_000) - L(1_200) - L(3_000)))
    expect(c.grossPaise).toBe(BigInt(L(20_000)))                 // still paid in full
  })
})
