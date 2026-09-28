/**
 * The same-origin check on writes.
 *
 * This shipped comparing `Origin` against the `Host` header, which is correct
 * on a dev box and wrong behind a reverse proxy. OpenLiteSpeed rewrites Host to
 * the backend address, so production refused EVERY state-changing request --
 * including the login -- with "Request origin is not allowed". Nothing caught
 * it because no test exercised the proxied shape.
 */
import { describe, it, expect } from 'vitest'
import { originAllowed } from '../src/http/origin.ts'

const PUBLIC = 'https://pepl.onrol.in'

describe('behind a reverse proxy', () => {
  it('allows the browser origin when the proxy rewrote Host to the backend', () => {
    // The exact production failure: Host is 127.0.0.1:4010, Origin is the site.
    expect(originAllowed(PUBLIC, { host: '127.0.0.1:4010' }, PUBLIC)).toBe(true)
  })

  it('allows it via x-forwarded-host when no public url is configured', () => {
    expect(originAllowed(PUBLIC, { host: '127.0.0.1:4010', 'x-forwarded-host': 'pepl.onrol.in' }, undefined)).toBe(true)
  })

  it('takes only the first entry of a forwarded-host chain', () => {
    // A proxy chain appends; the last hop is the one nearest us and an
    // attacker upstream must not be able to append their own.
    expect(originAllowed('https://evil.test', { host: 'x', 'x-forwarded-host': 'pepl.onrol.in, evil.test' }, undefined)).toBe(false)
  })
})

describe('a repeated Origin header', () => {
  // OpenLiteSpeed forwards Origin TWICE and Node joins duplicates with ", ".
  // `new URL()` threw on that, so production refused every write including the
  // login. This is the exact value captured off the wire.
  it('accepts the duplicate the proxy produces', () => {
    expect(originAllowed('https://pepl.onrol.in, https://pepl.onrol.in', { host: 'pepl.onrol.in' }, PUBLIC)).toBe(true)
  })

  it('refuses a good origin with a bad one appended', () => {
    // Every value must pass. Taking only the first would let a caller prepend
    // a permitted origin to their own.
    expect(originAllowed('https://pepl.onrol.in, https://evil.test', { host: 'pepl.onrol.in' }, PUBLIC)).toBe(false)
  })

  it('refuses a bad origin with a good one appended', () => {
    expect(originAllowed('https://evil.test, https://pepl.onrol.in', { host: 'pepl.onrol.in' }, PUBLIC)).toBe(false)
  })
})

describe('what it still refuses', () => {
  it('a different site', () => {
    expect(originAllowed('https://evil.test', { host: '127.0.0.1:4010' }, PUBLIC)).toBe(false)
  })

  it('a lookalike host', () => {
    expect(originAllowed('https://pepl.onrol.in.evil.test', { host: 'pepl.onrol.in' }, PUBLIC)).toBe(false)
  })

  it('an unparseable Origin', () => {
    expect(originAllowed('not a url', { host: 'pepl.onrol.in' }, PUBLIC)).toBe(false)
  })

  it('a misconfigured public url does not lock everyone out', () => {
    // A typo in the env degrades to the old behaviour rather than refusing
    // every write on the platform.
    expect(originAllowed('https://pepl.onrol.in', { host: 'pepl.onrol.in' }, 'not-a-url')).toBe(true)
  })
})

describe('no Origin at all', () => {
  it('is allowed: that is not a browser form post', () => {
    expect(originAllowed(undefined, { host: 'pepl.onrol.in' }, PUBLIC)).toBe(true)
  })
})
