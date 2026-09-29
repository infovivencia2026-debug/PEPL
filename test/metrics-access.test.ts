/**
 * /metrics must not be readable by the internet.
 *
 * With no PEPL_METRICS_TOKEN the endpoint fell back to "loopback only" and
 * asked the SOCKET. Behind a reverse proxy the socket is always 127.0.0.1, so
 * the check passed for every external request and the endpoint was public:
 * request counts by route are a map of the product, and the rate-limit
 * counters tell an attacker when they have been noticed.
 */
import { describe, it, expect } from 'vitest'
import { metricsAllowed } from '../src/http/metrics-endpoint.ts'

const req = (remote: string, headers: Record<string, string> = {}) =>
  ({ socket: { remoteAddress: remote }, headers }) as never

describe('with no token configured', () => {
  it('refuses a proxied request even though the socket says loopback', () => {
    expect(metricsAllowed(req('127.0.0.1', { 'x-forwarded-for': '203.0.113.9' }), undefined)).toBe(false)
    expect(metricsAllowed(req('127.0.0.1', { 'x-forwarded-proto': 'https' }), undefined)).toBe(false)
    expect(metricsAllowed(req('127.0.0.1', { 'x-forwarded-host': 'pepl.onrol.in' }), undefined)).toBe(false)
  })

  it('still allows a sidecar scraper that connects directly', () => {
    expect(metricsAllowed(req('127.0.0.1'), undefined)).toBe(true)
    expect(metricsAllowed(req('::1'), undefined)).toBe(true)
  })

  it('refuses a remote caller', () => {
    expect(metricsAllowed(req('203.0.113.9'), undefined)).toBe(false)
  })
})

describe('with a token configured', () => {
  const TOKEN = 'a-long-metrics-token-value'
  it('accepts the right one and refuses the rest', () => {
    expect(metricsAllowed(req('203.0.113.9', { authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true)
    expect(metricsAllowed(req('203.0.113.9', { authorization: 'Bearer wrong' }), TOKEN)).toBe(false)
    expect(metricsAllowed(req('203.0.113.9'), TOKEN)).toBe(false)
  })

  it('a token beats the proxy question entirely', () => {
    expect(metricsAllowed(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4', authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true)
  })
})
