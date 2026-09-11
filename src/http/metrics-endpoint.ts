/**
 * GET /metrics — Prometheus scrape.
 *
 * Mounted in server.ts before the JSON router, because the body is text, not
 * JSON. Access: a bearer token from PEPL_METRICS_TOKEN when one is set;
 * otherwise loopback only, which is what a sidecar scraper sees. Never open —
 * request counts by route are a map of the product, and rate-limit counters
 * tell an attacker when they have been noticed.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { renderMetrics } from '../lib/metrics.ts'
import { connectionCount } from '../realtime/bus.ts'

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

export function metricsAllowed(req: IncomingMessage, token = process.env.PEPL_METRICS_TOKEN): boolean {
  if (token) {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '') ?? ''
    const a = Buffer.from(given), b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  return LOOPBACK.has(req.socket.remoteAddress ?? '')
}

export function handleMetrics(req: IncomingMessage, res: ServerResponse): void {
  if (!metricsAllowed(req)) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(renderMetrics({ sseConnections: () => connectionCount() }))
}
