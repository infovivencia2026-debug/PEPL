/**
 * Professional-tax reference data: every state's slabs tile from zero with
 * no gaps or overlaps, monthly amounts never exceed the constitutional cap
 * over a year, the month-specific slabs resolve, and the seed is idempotent.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { PT_EXEMPT_STATES, PT_STATES } from '../db/reference/pt-slabs.ts'
import { ptFor, type PtSlab } from '../src/payroll/statutory.ts'
import { seedPtSlabs } from '../scripts/seed-statutory.ts'
import { controlDb } from '../src/control-plane/index.ts'

afterAll(async () => { await controlDb.end() })

describe('the reference file', () => {
  it('tiles from 0 with no gaps or overlaps, per state, ignoring month-specific rows', () => {
    for (const st of PT_STATES) {
      const general = st.slabs.filter((s) => s.month === undefined).sort((a, b) => a.from - b.from)
      expect(general[0]!.from, st.code).toBe(0)
      for (let i = 1; i < general.length; i++) expect(general[i]!.from, `${st.code} slab ${i}`).toBe(general[i - 1]!.to)
      expect(general[general.length - 1]!.to, st.code).toBeNull()
      for (const m of st.slabs.filter((s) => s.month !== undefined)) {
        expect(m.month, st.code).toBeGreaterThanOrEqual(1)
        expect(m.month, st.code).toBeLessThanOrEqual(12)
        // a month-specific slab sits on a general slab's range
        expect(general.some((g) => g.from === m.from && g.to === m.to), `${st.code} month slab ${m.from}`).toBe(true)
      }
    }
  })

  it('never exceeds ₹2,500 a year for any income (Article 276)', () => {
    for (const st of PT_STATES) {
      const top = st.slabs.filter((s) => s.to === null)
      const general = top.find((s) => s.month === undefined)!
      const special = top.filter((s) => s.month !== undefined)
      const year = general.amount * (12 - special.length) + special.reduce((n, s) => n + s.amount, 0)
      expect(year, `${st.code} pays ${year} a year`).toBeLessThanOrEqual(2_500)
    }
  })

  it('codes are unique across levying and exempt lists, and cover the usual 36', () => {
    const codes = [...PT_STATES.map((s) => s.code), ...PT_EXEMPT_STATES.map((s) => s.code)]
    expect(new Set(codes).size).toBe(codes.length)
    expect(codes.length).toBe(36)
  })
})

describe('ptFor with the reference slabs', () => {
  const toSlabs = (code: string): PtSlab[] => PT_STATES.find((s) => s.code === code)!.slabs.map((s) => ({
    state_code: code, gross_from_paise: String(s.from * 100), gross_to_paise: s.to === null ? null : String(s.to * 100),
    amount_paise: String(s.amount * 100), month_override: s.month ?? null,
  })) as PtSlab[]

  it('Karnataka: nothing under 25,000, 200 normally, 300 in February', () => {
    const ka = toSlabs('KA')
    expect(ptFor(ka, 'KA', BigInt(24_999_00), 5)).toBe(0n)
    expect(ptFor(ka, 'KA', BigInt(40_000_00), 5)).toBe(BigInt(200_00))
    expect(ptFor(ka, 'KA', BigInt(40_000_00), 2)).toBe(BigInt(300_00))
  })

  it('West Bengal steps through its five bands; an unknown state pays nothing', () => {
    const wb = toSlabs('WB')
    expect(ptFor(wb, 'WB', BigInt(12_000_00), 6)).toBe(BigInt(110_00))
    expect(ptFor(wb, 'WB', BigInt(30_000_00), 6)).toBe(BigInt(150_00))
    expect(ptFor(wb, 'DL', BigInt(99_000_00), 6)).toBe(0n)
  })
})

describe('the seed', () => {
  it('is idempotent per effective date and closes the previous set', async () => {
    const a = await seedPtSlabs('2030-04-01')
    const b = await seedPtSlabs('2030-04-01')
    expect(a).toEqual(b)
    const { rows } = await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM pt_slabs WHERE effective_from = DATE '2030-04-01'`)
    expect(Number(rows[0]!.n)).toBe(a.slabs)
    const prev = await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM pt_slabs WHERE state_code = 'KA' AND effective_from < DATE '2030-04-01' AND effective_to IS NULL`)
    expect(Number(prev.rows[0]!.n)).toBe(0)
    // leave the test database as the suites expect: drop the future set
    await controlDb.query(`DELETE FROM pt_slabs WHERE effective_from = DATE '2030-04-01'`)
    await controlDb.query(`UPDATE pt_slabs SET effective_to = NULL WHERE effective_to = DATE '2030-03-31'`)
  })
})
