/**
 * Where this server is allowed to send an outbound request.
 *
 * Webhooks and the WhatsApp provider take a URL from a CUSTOMER'S ADMIN and the
 * server then calls it. Without a guard that is a request-forgery primitive
 * pointed at whatever the server can reach — and this server shares a box with
 * thirteen other applications listening on loopback ports, plus whatever the
 * private network holds. The old check was:
 *
 *     if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(url))
 *
 * which allows loopback outright, and allows `https://` to ANY address —
 * 10.0.0.0/8, 192.168.0.0/16, and 169.254.169.254, the cloud metadata service.
 * The delivery log records status and error, so even without a response body
 * the caller learns what is listening and can POST to it.
 *
 * Loopback stays allowed OUTSIDE production, because the webhook tests bind a
 * real receiver on 127.0.0.1 and testing against a fake would proves less.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export class OutboundUrlError extends Error {
  readonly code = 'VALIDATION_FAILED'
  constructor(message: string) {
    super(message)
    this.name = 'OutboundUrlError'
  }
}

/** Loopback, private, link-local, carrier-grade NAT, and the v6 equivalents. */
export function isBlockedAddress(ip: string): boolean {
  const v = isIP(ip)
  if (v === 4) {
    const [a = 0, b = 0] = ip.split('.').map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true          // link-local, incl. 169.254.169.254
    if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // 100.64.0.0/10, CGNAT
    if (a >= 224) return true                         // multicast and reserved
    return false
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '')
    if (s === '::1' || s === '::') return true
    if (s.startsWith('fe80')) return true             // link-local
    if (/^f[cd]/.test(s)) return true                 // unique local fc00::/7
    // IPv4-mapped. Node normalises `::ffff:127.0.0.1` to `::ffff:7f00:1`, so
    // matching only the dotted form let loopback straight through -- the test
    // for it failed on exactly that.
    const mapped = s.match(/^::ffff:(.+)$/)
    if (mapped) {
      const tail = mapped[1]!
      if (tail.includes('.')) return isBlockedAddress(tail)
      const [hi = '0', lo = '0'] = tail.split(':')
      const n = (parseInt(hi, 16) << 16) | parseInt(lo, 16)
      if (Number.isNaN(n)) return true  // unparseable: refuse rather than allow
      return isBlockedAddress([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'))
    }
    return false
  }
  return false
}

const loopbackHost = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'

/**
 * Shape check. Throws on anything this server must not be asked to call.
 * `allowLoopback` is for development and tests, never production.
 */
export function parseOutboundUrl(
  raw: string,
  allowLoopback = process.env.NODE_ENV !== 'production',
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new OutboundUrlError('that is not a URL')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowLoopback && loopbackHost(url.hostname))) {
    throw new OutboundUrlError('url must be https')
  }
  if (url.username || url.password) {
    // Credentials in the URL end up in delivery logs and in somebody's console.
    throw new OutboundUrlError('url must not contain credentials')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (loopbackHost(url.hostname) || loopbackHost(host)) {
    if (!allowLoopback) throw new OutboundUrlError('url must not point at this server')
    return url
  }
  if (isIP(host) && isBlockedAddress(host)) {
    throw new OutboundUrlError('url must not point at a private or link-local address')
  }
  return url
}

/**
 * Resolve and check where the name actually points.
 *
 * A hostname under the customer's control can resolve to 127.0.0.1 or to
 * 169.254.169.254, so the shape check alone is not enough. Called at DELIVERY
 * time as well as when the URL is saved, because what a name resolves to can
 * change after it was accepted.
 */
export async function assertResolvesPublic(
  url: URL,
  allowLoopback = process.env.NODE_ENV !== 'production',
): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (allowLoopback && loopbackHost(url.hostname)) return
  if (isIP(host)) {
    if (isBlockedAddress(host) && !allowLoopback) {
      throw new OutboundUrlError('url must not point at a private or link-local address')
    }
    return
  }
  let addresses: Array<{ address: string }>
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new OutboundUrlError('that host does not resolve')
  }
  // EVERY answer must be acceptable: one private address among several is
  // enough for the request to land somewhere it should not.
  for (const a of addresses) {
    if (isBlockedAddress(a.address) && !allowLoopback) {
      throw new OutboundUrlError('that host resolves to a private or link-local address')
    }
  }
}

/**
 * POST to a customer-supplied URL, validating the URL AND every redirect destination.
 *
 * fetch() follows redirects by itself, so a URL that passed `parseOutboundUrl` could answer
 * `302 -> http://169.254.169.254/...` (the cloud metadata service) or a private address and be
 * followed with no second check. Redirects are therefore followed here, by hand, each hop run through
 * the same shape and resolution checks, up to MAX_REDIRECTS.
 *
 * What comes back is deliberately thin: the status, and a fixed phrase for a failure. The response BODY
 * is never returned or stored -- it used to become the delivery error, i.e. a read of whatever the
 * server could reach -- and a network error never repeats the address or port it failed on.
 */
export const MAX_REDIRECTS = 3

export async function safePost(
  url: string,
  init: { headers: Record<string, string>; body: string },
  opts: { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; error?: string }> {
  let target = url
  let method = 'POST'
  let body: string | undefined = init.body
  const deadline = AbortSignal.timeout(opts.timeoutMs ?? 10_000)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    try {
      await assertResolvesPublic(parseOutboundUrl(target))
    } catch (e) {
      return { ok: false, status: 0, error: (e as Error).message }
    }
    let r: Response
    try {
      r = await fetch(target, { method, headers: init.headers, body, redirect: 'manual', signal: deadline })
    } catch {
      return { ok: false, status: 0, error: 'the destination could not be reached' }
    }
    await r.body?.cancel().catch(() => undefined)        // never read the body
    if (r.status >= 300 && r.status < 400 && r.headers.has('location')) {
      let next: URL
      try { next = new URL(r.headers.get('location')!, target) } catch { return { ok: false, status: r.status, error: 'the redirect target is not a URL' } }
      target = next.toString()
      // 301/302/303 turn a POST into a GET without a body; 307/308 repeat it as it was.
      if ([301, 302, 303].includes(r.status)) { method = 'GET'; body = undefined }
      continue
    }
    return { ok: r.ok, status: r.status, error: r.ok ? undefined : `the destination answered HTTP ${r.status}` }
  }
  return { ok: false, status: 0, error: 'too many redirects' }
}
