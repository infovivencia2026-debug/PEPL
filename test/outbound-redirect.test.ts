/**
 * A webhook may not be used to reach the internal network, by redirect or by error text.
 *
 * Both senders validated the URL they were given and then called fetch(), which follows redirects on
 * its own: a public-looking URL answering 302 -> http://169.254.169.254/ (the cloud metadata service)
 * or a private address was followed without a second check. Failed responses also stored the first 300
 * characters of the BODY as the delivery error, shown back to the customer: a read of whatever the
 * server could reach. Network errors repeated the internal address and port.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { httpPoster } from '../src/control-plane/integrations.ts'
import { httpSender } from '../src/comms/whatsapp.ts'
import { safePost, parseOutboundUrl } from '../src/net/outbound-url.ts'

const servers: Server[] = []
const serve = (handler: Parameters<typeof createServer>[1]): Promise<string> => new Promise((resolve) => {
  const s = createServer(handler); servers.push(s)
  s.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}/hook`))
})
afterAll(() => { for (const s of servers) s.closeAllConnections?.(), s.close() })

const redirectTo = (location: string, code = 302) => serve((_q, r) => { r.writeHead(code, { location }); r.end() })
const BLOCKED = [
  'http://169.254.169.254/latest/meta-data/', 'https://169.254.169.254/', 'https://10.0.0.5/x', 'https://192.168.1.1/',
  'https://172.16.0.9/', 'https://[fd00::1]/', 'https://[fe80::1]/', 'https://[::ffff:10.0.0.1]/', 'https://100.64.0.1/',
]

describe('a redirect to an internal address is refused', () => {
  for (const target of BLOCKED) {
    it(`webhook: ${target}`, async () => {
      const r = await httpPoster(await redirectTo(target), '{}', {})
      expect(r.ok).toBe(false)
      expect(r.error ?? '').toMatch(/private|link-local|not a URL|must/i)
    })
  }
  it('whatsapp: 307 to metadata', async () => {
    const r = await httpSender(await redirectTo('http://169.254.169.254/', 307), {}, null)
    expect(r.ok).toBe(false)
    expect(r.error ?? '').toMatch(/private|link-local|must be https/i)
  })
  it('loopback is refused outright in production, including IPv6', () => {
    for (const u of ['https://localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'http://127.0.0.1/']) expect(() => parseOutboundUrl(u, false), u).toThrow()
  })
  it('a redirect CHAIN is checked at every hop, and is bounded', async () => {
    const last = await redirectTo('https://10.0.0.5/')
    const mid = await redirectTo(last)
    expect((await safePost(await redirectTo(mid), { headers: {}, body: '{}' })).ok).toBe(false)
    let u = await redirectTo(await redirectTo(await redirectTo(await redirectTo(await redirectTo(await redirectTo(await serve((_q, r) => { r.writeHead(200); r.end('fine') })))))))
    const deep = await safePost(u, { headers: {}, body: '{}' })
    expect(deep.ok).toBe(false)
    expect(deep.error ?? '').toMatch(/redirect/i)
  })
})

describe('a harmless redirect still works', () => {
  it('follows a redirect to a permitted destination', async () => {
    const target = await serve((_q, r) => { r.writeHead(200); r.end('fine') })
    expect((await httpPoster(await redirectTo(target, 307), '{}', {})).ok).toBe(true)
  })
})

describe('what a failure reveals', () => {
  it('never includes the response body', async () => {
    const url = await serve((_q, r) => { r.writeHead(500); r.end('SECRET-INTERNAL-CONFIG password=hunter2') })
    for (const r of [await httpPoster(url, '{}', {}), await httpSender(url, {}, null)]) {
      expect(r.ok).toBe(false)
      expect(r.status).toBe(500)
      expect(r.error ?? '').not.toContain('SECRET')
      expect(r.error ?? '').not.toContain('hunter2')
    }
  })
  it('never repeats an internal address from a network error', async () => {
    const r = await httpPoster('http://127.0.0.1:1/hook', '{}', {})
    expect(r.ok).toBe(false)
    expect(r.error ?? '').not.toMatch(/127\.0\.0\.1|ECONNREFUSED|:1\b/)
  })
})
