/**
 * Network benchmarks. Opt-in; anonymous by construction.
 *
 * Contribution: a nightly job computes six operational ratios for each
 * opted-in company and writes them under a keyed hash of the tenant id, with
 * a coarse segment. Reading: a company that contributes sees its own value
 * beside the segment's p25 / median / p75, and only when at least MIN_K
 * companies contributed to that segment for that month. No money metric is
 * collected, so nothing here can leak a salary.
 */
import { createHmac } from 'node:crypto'
import type { PoolClient } from 'pg'
import { controlDb } from './index.ts'

export const MIN_K = 10
export const METRICS = [
  { key: 'attrition_pct_12m', label: 'Attrition, trailing 12 months (%)', lowerIsBetter: true },
  { key: 'attendance_pct', label: 'Attendance (% of working days present)', lowerIsBetter: false },
  { key: 'avg_late_min', label: 'Average late arrival (minutes)', lowerIsBetter: true },
  { key: 'leave_days_per_head', label: 'Leave days per head (month)', lowerIsBetter: null },
  { key: 'ot_hours_per_head', label: 'Overtime hours per head (month)', lowerIsBetter: true },
  { key: 'approval_turnaround_h', label: 'Approval turnaround (hours)', lowerIsBetter: true },
] as const
export type MetricKey = (typeof METRICS)[number]['key']

const hashTenant = (tenantId: string): string => createHmac('sha256', process.env.PEPL_BENCHMARK_SALT ?? 'pepl-benchmarks').update(tenantId).digest('hex').slice(0, 32)
export const sizeBand = (heads: number): string => heads < 20 ? '1-19' : heads < 50 ? '20-49' : heads < 200 ? '50-199' : heads < 1000 ? '200-999' : '1000+'

/** The six ratios for one company for a month, computed in its own tenant context. */
export async function computeMetrics(tx: PoolClient, month: string): Promise<{ metrics: Record<MetricKey, number | null>; headcount: number }> {
  const start = `${month}-01`
  const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
  const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[]): Promise<T> => (await tx.query<T>(sql, params)).rows[0]!
  const hc = await one<{ heads: string; exits: string; avg_heads: string }>(
    `SELECT count(*) FILTER (WHERE status = 'active')::text AS heads,
            count(*) FILTER (WHERE date_of_exit BETWEEN $1::date - interval '12 months' AND $1::date)::text AS exits,
            greatest(1, count(*) FILTER (WHERE date_of_joining <= $1::date AND (date_of_exit IS NULL OR date_of_exit > $1::date - interval '12 months')))::text AS avg_heads
       FROM employees WHERE erased_at IS NULL`, [end])
  const att = await one<{ days: string; present: string; late: string | null; ot: string }>(
    `SELECT count(*) FILTER (WHERE status IN ('present','absent','on_leave'))::text AS days, count(*) FILTER (WHERE status = 'present')::text AS present,
            avg(late_minutes) FILTER (WHERE status = 'present')::text AS late, coalesce(sum(ot_minutes), 0)::text AS ot
       FROM daily_attendance WHERE work_date BETWEEN $1::date AND $2::date`, [start, end])
  const leave = await one<{ days: string }>(`SELECT coalesce(sum(total_days), 0)::text AS days FROM leave_requests WHERE status = 'approved' AND start_date BETWEEN $1::date AND $2::date`, [start, end])
  const appr = await one<{ h: string | null }>(`SELECT avg(extract(epoch FROM (closed_at - created_at)) / 3600.0)::text AS h FROM approval_requests WHERE closed_at IS NOT NULL AND created_at::date BETWEEN $1::date AND $2::date`, [start, end])
  const heads = Number(hc.heads)
  const r = (v: number | null, d = 2): number | null => v === null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d
  return { headcount: heads, metrics: {
    attrition_pct_12m: r(Number(hc.exits) / Number(hc.avg_heads) * 100),
    attendance_pct: Number(att.days) ? r(Number(att.present) / Number(att.days) * 100) : null,
    avg_late_min: att.late === null ? null : r(Number(att.late), 1),
    leave_days_per_head: heads ? r(Number(leave.days) / heads) : null,
    ot_hours_per_head: heads ? r(Number(att.ot) / 60 / heads) : null,
    approval_turnaround_h: appr.h === null ? null : r(Number(appr.h), 1),
  } }
}

export async function contribute(tx: PoolClient, args: { tenantId: string; organisationType: string | null; month: string }): Promise<void> {
  const { metrics, headcount } = await computeMetrics(tx, args.month)
  if (headcount < 5) return   // too small to be anonymous even in aggregate
  const segment = `${args.organisationType ?? 'office'}:${sizeBand(headcount)}`
  await controlDb.query(`INSERT INTO control_plane.benchmark_samples (tenant_hash, month, segment, metrics) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (tenant_hash, month) DO UPDATE SET segment = EXCLUDED.segment, metrics = EXCLUDED.metrics, sampled_at = now()`,
    [hashTenant(args.tenantId), args.month, segment, JSON.stringify(metrics)])
}
export async function withdraw(tenantId: string): Promise<number> {
  return (await controlDb.query(`DELETE FROM control_plane.benchmark_samples WHERE tenant_hash = $1`, [hashTenant(tenantId)])).rowCount ?? 0
}

export interface Benchmark { key: MetricKey; label: string; lowerIsBetter: boolean | null; mine: number | null; p25: number | null; median: number | null; p75: number | null; contributors: number; shown: boolean }
/** Own value beside the segment's quartiles — or `shown: false` with the reason when the segment is too small. */
export async function compare(tx: PoolClient, args: { tenantId: string; organisationType: string | null; month: string }): Promise<{ segment: string; month: string; contributors: number; minimum: number; metrics: Benchmark[] }> {
  const { metrics: mine, headcount } = await computeMetrics(tx, args.month)
  const segment = `${args.organisationType ?? 'office'}:${sizeBand(headcount)}`
  const contributors = Number((await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM control_plane.benchmark_samples WHERE segment = $1 AND month = $2`, [segment, args.month])).rows[0]!.n)
  const out: Benchmark[] = []
  for (const m of METRICS) {
    let q: { p25: string | null; med: string | null; p75: string | null } | undefined
    if (contributors >= MIN_K) {
      q = (await controlDb.query<{ p25: string | null; med: string | null; p75: string | null }>(
        `SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY v)::text AS p25, percentile_cont(0.5) WITHIN GROUP (ORDER BY v)::text AS med, percentile_cont(0.75) WITHIN GROUP (ORDER BY v)::text AS p75
           FROM (SELECT (metrics ->> $3)::numeric AS v FROM control_plane.benchmark_samples WHERE segment = $1 AND month = $2 AND metrics ->> $3 IS NOT NULL) x`, [segment, args.month, m.key])).rows[0]
    }
    const n = (v: string | null | undefined): number | null => v === null || v === undefined ? null : Math.round(Number(v) * 100) / 100
    out.push({ key: m.key, label: m.label, lowerIsBetter: m.lowerIsBetter, mine: mine[m.key], p25: n(q?.p25), median: n(q?.med), p75: n(q?.p75), contributors, shown: contributors >= MIN_K })
  }
  return { segment, month: args.month, contributors, minimum: MIN_K, metrics: out }
}
