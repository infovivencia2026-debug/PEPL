/**
 * Network benchmarks (D4). Metrics are ratios, never money; a company under
 * 5 heads contributes nothing; the tenant id is hashed; a segment with fewer
 * than MIN_K contributors shows no quartile at all; with MIN_K it shows
 * p25/median/p75 beside the company's own value; opting out deletes the
 * company's samples.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { computeMetrics, contribute, compare, withdraw, sizeBand, MIN_K, METRICS } from '../src/control-plane/benchmarks.ts'

let A: Tenant
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await controlDb.query(`DELETE FROM control_plane.benchmark_samples`)
  await withTenant(A.id, async (tx) => {
    for (let i = 1; i <= 7; i++) {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining, date_of_exit, status) VALUES ($1,$2,$3,DATE '2025-01-01',$4::date,$5) RETURNING id`, [A.id, `A-B${i}`, `B${i}`, i === 7 ? '2026-09-15' : null, i === 7 ? 'exited' : 'active'])).rows[0]!.id
      for (let d = 1; d <= 4; d++) await tx.query(`INSERT INTO daily_attendance (tenant_id, employee_id, work_date, status, late_minutes, ot_minutes) VALUES ($1,$2,$3::date,$4,$5,$6)`, [A.id, id, `2026-09-0${d}`, d === 4 && i % 2 ? 'absent' : 'present', 10, 60])
    }
  })
})
afterAll(async () => { await closePools(); await controlPool.end(); await controlDb.end() })

describe('benchmarks', () => {
  it('ratios only; k-anonymity floor; withdraw deletes', async () => {
    expect(sizeBand(7)).toBe('1-19'); expect(sizeBand(150)).toBe('50-199')
    expect(METRICS.map((m) => m.key).join(' ')).not.toMatch(/ctc|salary|pay/)
    await withTenant(A.id, async (tx) => {
      const m = await computeMetrics(tx, '2026-09')
      expect(m.headcount).toBe(7)                                     // Rahul + 6 active
      expect(m.metrics.attendance_pct).toBe(Math.round(24 / 28 * 10000) / 100)   // 28 days, 4 absent
      expect(m.metrics.avg_late_min).toBe(10)
      expect(m.metrics.ot_hours_per_head).toBe(Math.round(28 * 60 / 60 / 7 * 100) / 100)
      expect(m.metrics.attrition_pct_12m).toBeGreaterThan(0)
      await contribute(tx, { tenantId: A.id, organisationType: 'office', month: '2026-09' })
      const rows = (await controlDb.query<{ tenant_hash: string; segment: string; metrics: Record<string, number> }>(`SELECT tenant_hash, segment, metrics FROM control_plane.benchmark_samples`)).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.tenant_hash).not.toContain(A.id.slice(0, 8))       // hashed, not the id
      expect(rows[0]!.segment).toBe('office:1-19')
      // alone in the segment: nothing shown
      let c = await compare(tx, { tenantId: A.id, organisationType: 'office', month: '2026-09' })
      expect(c.contributors).toBe(1)
      expect(c.metrics.every((x) => !x.shown && x.median === null)).toBe(true); expect(c.metrics.find((x) => x.key === 'attendance_pct')!.mine).not.toBeNull()
      // nine strangers join the segment → quartiles appear
      for (let i = 0; i < MIN_K - 1; i++) await controlDb.query(`INSERT INTO control_plane.benchmark_samples (tenant_hash, month, segment, metrics) VALUES ($1,'2026-09','office:1-19',$2::jsonb)`, [`stranger-${i}`, JSON.stringify({ attendance_pct: 80 + i, avg_late_min: 5 + i, attrition_pct_12m: 10 + i, leave_days_per_head: 1, ot_hours_per_head: 2, approval_turnaround_h: 12 })])
      c = await compare(tx, { tenantId: A.id, organisationType: 'office', month: '2026-09' })
      expect(c.contributors).toBe(MIN_K)
      const att = c.metrics.find((x) => x.key === 'attendance_pct')!
      expect(att.shown).toBe(true)
      expect(att.median).toBeGreaterThan(80); expect(att.p25).toBeLessThan(att.median!); expect(att.p75).toBeGreaterThan(att.median!)
      // a different segment sees none of it
      const other = await compare(tx, { tenantId: A.id, organisationType: 'manufacturing', month: '2026-09' })
      expect(other.contributors).toBe(0)
      // withdraw
      expect(await withdraw(A.id)).toBe(1)
      expect((await controlDb.query(`SELECT count(*)::int AS n FROM control_plane.benchmark_samples`)).rows[0].n).toBe(MIN_K - 1)
    })
  })
  it('a tiny company contributes nothing', async () => {
    const { b } = await resetAndSeed()
    await withTenant(b.id, (tx) => contribute(tx, { tenantId: b.id, organisationType: 'office', month: '2026-09' }))
    expect((await controlDb.query(`SELECT count(*)::int AS n FROM control_plane.benchmark_samples WHERE segment LIKE 'office:%' AND tenant_hash NOT LIKE 'stranger-%'`)).rows[0].n).toBe(0)
  })
})
