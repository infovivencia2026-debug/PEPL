/**
 * Rate limiting has to know who the caller is.
 *
 * The public limiter keyed on `socket.remoteAddress`, which behind a reverse
 * proxy is the proxy. Every unauthenticated request on production therefore
 * shared ONE bucket: one attacker could exhaust it and lock every customer out
 * of signing in, while per-attacker limiting did nothing.
 *
 * The header is only trusted from loopback -- our own proxy. A direct caller
 * who could set it would mint a fresh bucket per request and remove the limit
 * entirely, which is worse than the bug being fixed.
 */
import { describe, it, expect } from 'vitest'
import { clientIp } from '../src/http/router.ts'

const req = (remote: string, xff?: string) =>
  ({ socket: { remoteAddress: remote }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } })

describe('behind our own proxy', () => {
  it('uses the forwarded client, not the proxy', () => {
    expect(clientIp(req('127.0.0.1', '76.13.242.93'))).toBe('76.13.242.93')
  })

  it('takes the last entry, the one our proxy appended', () => {
    // Earlier entries can be supplied by the client and are not evidence.
    expect(clientIp(req('127.0.0.1', '1.2.3.4, 5.6.7.8'))).toBe('5.6.7.8')
  })

  it('falls back to the socket when the header is absent or empty', () => {
    expect(clientIp(req('127.0.0.1'))).toBe('127.0.0.1')
    expect(clientIp(req('127.0.0.1', '   '))).toBe('127.0.0.1')
  })
})

describe('from anywhere else', () => {
  it('ignores the header entirely', () => {
    // Otherwise anyone can claim a new identity per request and there is no
    // rate limit at all.
    expect(clientIp(req('203.0.113.9', '1.2.3.4'))).toBe('203.0.113.9')
  })

  it('ignores it for IPv6 callers too', () => {
    expect(clientIp(req('2606:4700::1111', '1.2.3.4'))).toBe('2606:4700::1111')
  })
})
