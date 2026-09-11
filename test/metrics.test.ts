/**
 * /metrics: the counters move with traffic, the labels are patterns not paths,
 * and the endpoint is closed to anyone who is not the scraper.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { Router, createHandler } from '../src/http/router.ts'
import { handleMetrics, metricsAllowed } from '../src/http/metrics-endpoint.ts'
import { httpRequests, jobRuns, renderMetrics, resetMetrics } from '../src/lib/metrics.ts'

let server: Server
let base: string

beforeAll(async () => {
  resetMetrics()
  const router = new Router()
  router.get('/api/v1/things/:id', { summary: 't', tag: 'system', public: true },
    async () => ({ status: 200, body: { ok: true } }))
  const api = createHandler(router, { publicLimit: { max: 3, windowMs: 60_000 } })
  server = createServer((req, res) => {
    if (req.url === '/metrics') return handleMetrics(req, res)
    void api(req, res)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address() as { port: number }
  base = `http://127.0.0.1:${addr.port}`
})

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  delete process.env.PEPL_METRICS_TOKEN
})

describe('metrics', () => {
  it('counts requests by route PATTERN and status class, never by raw path', async () => {
    await fetch(`${base}/api/v1/things/11111111-1111-1111-1111-111111111111`)
    await fetch(`${base}/api/v1/things/22222222-2222-2222-2222-222222222222`)
    await fetch(`${base}/api/v1/nowhere`)
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toMatch(/pepl_http_requests_total\{method="GET",route="\/api\/v1\/things\/:id",status="2xx"\} 2/)
    expect(text).toMatch(/route="unmatched",status="4xx"\} 1/)
    expect(text).not.toMatch(/11111111/)
    expect(text).toMatch(/pepl_http_request_duration_seconds_bucket\{.*le="\+Inf"\}/)
    expect(text).toMatch(/pepl_sse_connections \d+/)
  })

  it('counts rate-limit rejections by limiter', async () => {
    // limit is 3/min per IP; the calls above used some of it — spend the rest
    for (let i = 0; i < 5; i++) await fetch(`${base}/api/v1/things/x`)
    const text = await (await fetch(`${base}/metrics`)).text()
    expect(text).toMatch(/pepl_http_rate_limited_total\{limiter="public"\} [1-9]/)
  })

  it('renders job outcomes and escapes label values', () => {
    jobRuns.inc({ job: 'mail.outbox', outcome: 'ok' })
    jobRuns.inc({ job: 'we"ird', outcome: 'failed' })
    const text = renderMetrics()
    expect(text).toContain('pepl_job_runs_total{job="mail.outbox",outcome="ok"} 1')
    expect(text).toContain('job="we\\"ird"')
    expect(text.endsWith('\n')).toBe(true)
  })

  it('is loopback-only without a token, and token-gated with one', () => {
    const req = (addr: string, auth?: string) =>
      ({ socket: { remoteAddress: addr }, headers: auth ? { authorization: auth } : {} }) as never
    expect(metricsAllowed(req('127.0.0.1'), undefined)).toBe(true)
    expect(metricsAllowed(req('10.0.0.9'), undefined)).toBe(false)
    expect(metricsAllowed(req('10.0.0.9', 'Bearer s3cret'), 's3cret')).toBe(true)
    expect(metricsAllowed(req('127.0.0.1'), 's3cret')).toBe(false)
    expect(metricsAllowed(req('127.0.0.1', 'Bearer wrong'), 's3cret')).toBe(false)
  })

  it('answers 404, not 401, to a stranger — the endpoint should not announce itself', async () => {
    process.env.PEPL_METRICS_TOKEN = 'scrape-me'
    const r = await fetch(`${base}/metrics`)
    expect(r.status).toBe(404)
    const ok = await fetch(`${base}/metrics`, { headers: { authorization: 'Bearer scrape-me' } })
    expect(ok.status).toBe(200)
    expect(httpRequests.render()).toContain('pepl_http_requests_total')
  })
})
