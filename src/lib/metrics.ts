/**
 * Process metrics in Prometheus text exposition format.
 *
 * In-process counters and histograms, no dependency. Labels are kept to a
 * small fixed set (route pattern, method, status class, job name) — never a
 * tenant id, an email or a path with ids in it — so the series count stays
 * bounded and no personal data leaves through the scrape.
 */

type Labels = Record<string, string>

const key = (labels: Labels): string =>
  Object.keys(labels).sort().map((k) => `${k}="${escape(labels[k]!)}"`).join(',')

const escape = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')

class Counter {
  readonly name: string
  readonly help: string
  private readonly values = new Map<string, number>()
  constructor(name: string, help: string) {
    this.name = name
    this.help = help
  }
  inc(labels: Labels = {}, by = 1): void {
    const k = key(labels)
    this.values.set(k, (this.values.get(k) ?? 0) + by)
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`]
    for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`)
    return lines.join('\n')
  }
  reset(): void { this.values.clear() }
}

class Histogram {
  readonly name: string
  readonly help: string
  private readonly buckets: readonly number[]
  private readonly series = new Map<string, { counts: number[]; sum: number; count: number }>()
  constructor(name: string, help: string, buckets: readonly number[]) {
    this.name = name
    this.help = help
    this.buckets = buckets
  }
  observe(labels: Labels, value: number): void {
    const k = key(labels)
    let s = this.series.get(k)
    if (!s) {
      s = { counts: this.buckets.map(() => 0), sum: 0, count: 0 }
      this.series.set(k, s)
    }
    this.buckets.forEach((b, i) => { if (value <= b) s!.counts[i]!++ })
    s.sum += value
    s.count++
  }
  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`]
    for (const [k, s] of this.series) {
      const sep = k ? ',' : ''
      this.buckets.forEach((b, i) =>
        lines.push(`${this.name}_bucket{${k}${sep}le="${b}"} ${s.counts[i]}`))
      lines.push(`${this.name}_bucket{${k}${sep}le="+Inf"} ${s.count}`)
      lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${s.sum}`)
      lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${s.count}`)
    }
    return lines.join('\n')
  }
  reset(): void { this.series.clear() }
}

export const httpRequests = new Counter('pepl_http_requests_total',
  'HTTP requests by method, route pattern and status class')
export const httpDuration = new Histogram('pepl_http_request_duration_seconds',
  'HTTP request latency by route pattern', [0.005, 0.025, 0.1, 0.25, 0.5, 1, 2.5, 5])
export const rateLimited = new Counter('pepl_http_rate_limited_total',
  'Requests rejected by the rate limiter, by limiter')
export const jobRuns = new Counter('pepl_job_runs_total',
  'Scheduler job passes by job and outcome (ok, errors, failed)')
export const jobDuration = new Histogram('pepl_job_duration_seconds',
  'Scheduler job pass duration', [0.1, 0.5, 1, 5, 15, 60, 300])

const all = [httpRequests, httpDuration, rateLimited, jobRuns, jobDuration]

/** Gauges that are cheaper to read at scrape time than to track. */
export interface Gauges {
  sseConnections?: () => number
}

export function renderMetrics(gauges: Gauges = {}): string {
  const mem = process.memoryUsage()
  const out: string[] = [
    '# HELP pepl_process_uptime_seconds Seconds since the process started',
    '# TYPE pepl_process_uptime_seconds gauge',
    `pepl_process_uptime_seconds ${Math.floor(process.uptime())}`,
    '# HELP pepl_process_resident_memory_bytes Resident set size',
    '# TYPE pepl_process_resident_memory_bytes gauge',
    `pepl_process_resident_memory_bytes ${mem.rss}`,
    '# HELP pepl_process_heap_used_bytes V8 heap in use',
    '# TYPE pepl_process_heap_used_bytes gauge',
    `pepl_process_heap_used_bytes ${mem.heapUsed}`,
  ]
  if (gauges.sseConnections) {
    out.push('# HELP pepl_sse_connections Open event-stream connections',
      '# TYPE pepl_sse_connections gauge',
      `pepl_sse_connections ${gauges.sseConnections()}`)
  }
  for (const m of all) out.push(m.render())
  return out.join('\n') + '\n'
}

/** Tests only. */
export function resetMetrics(): void {
  for (const m of all) m.reset()
}
