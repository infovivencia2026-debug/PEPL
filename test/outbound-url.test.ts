/**
 * The server must not be usable as a way to reach the inside of the network.
 *
 * Webhook and WhatsApp URLs come from a CUSTOMER'S ADMIN. The old check allowed
 * loopback outright and allowed https:// to any address at all, so a tenant
 * admin could point a webhook at 127.0.0.1:3000 -- one of thirteen other
 * applications on this box -- or at 169.254.169.254, the cloud metadata
 * service, and read the status back out of the delivery log.
 */
import { describe, it, expect } from 'vitest'
import { parseOutboundUrl, assertResolvesPublic, isBlockedAddress, OutboundUrlError } from '../src/net/outbound-url.ts'

const inProduction = (raw: string) => parseOutboundUrl(raw, false)

describe('in production', () => {
  it('refuses loopback', () => {
    for (const u of ['http://127.0.0.1:3000/hook', 'https://127.0.0.1/hook', 'http://localhost/hook', 'https://[::1]/hook']) {
      expect(() => inProduction(u), u).toThrow(OutboundUrlError)
    }
  })

  it('refuses the private ranges', () => {
    for (const u of ['https://10.0.0.5/hook', 'https://192.168.1.10/hook', 'https://172.16.5.4/hook', 'https://172.31.255.254/hook']) {
      expect(() => inProduction(u), u).toThrow(OutboundUrlError)
    }
  })

  it('refuses the cloud metadata address', () => {
    // The one that turns an SSRF into stolen credentials.
    expect(() => inProduction('https://169.254.169.254/latest/meta-data/')).toThrow(OutboundUrlError)
  })

  it('refuses IPv6 loopback, link-local and unique-local', () => {
    for (const u of ['https://[::1]/x', 'https://[fe80::1]/x', 'https://[fd00::1]/x', 'https://[::ffff:127.0.0.1]/x']) {
      expect(() => inProduction(u), u).toThrow(OutboundUrlError)
    }
  })

  it('refuses plain http even to a public host', () => {
    expect(() => inProduction('http://example.com/hook')).toThrow(OutboundUrlError)
  })

  it('refuses credentials embedded in the url', () => {
    // They would be written into the delivery log.
    expect(() => inProduction('https://user:pass@example.com/hook')).toThrow(OutboundUrlError)
  })

  it('allows an ordinary https endpoint', () => {
    expect(inProduction('https://hooks.example.com/pepl').hostname).toBe('hooks.example.com')
  })

  it('allows a public IP literal', () => {
    expect(inProduction('https://93.184.216.34/hook').hostname).toBe('93.184.216.34')
  })
})

describe('outside production', () => {
  it('still allows loopback, because the tests bind a real receiver', () => {
    expect(parseOutboundUrl('http://127.0.0.1:41234/hook', true).port).toBe('41234')
    expect(parseOutboundUrl('http://localhost:41234/hook', true).hostname).toBe('localhost')
  })
})

describe('what a name resolves to', () => {
  it('refuses a public NAME that resolves to loopback', async () => {
    // A hostname the customer controls can point anywhere, so the shape check
    // alone is not enough. localhost is the reliably-resolving case of this.
    await expect(assertResolvesPublic(new URL('https://localhost/hook'), false)).rejects.toThrow(OutboundUrlError)
  })

  it('accepts loopback when loopback is allowed', async () => {
    await expect(assertResolvesPublic(new URL('http://127.0.0.1:9/hook'), true)).resolves.toBeUndefined()
  })

  it('refuses a name that does not resolve at all', async () => {
    await expect(
      assertResolvesPublic(new URL('https://no-such-host.invalid/hook'), false),
    ).rejects.toThrow(OutboundUrlError)
  })
})

describe('the address ranges themselves', () => {
  it('blocks what it should', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12::1']) {
      expect(isBlockedAddress(ip), ip).toBe(true)
    }
  })

  it('allows what it should', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) {
      expect(isBlockedAddress(ip), ip).toBe(false)
    }
  })
})
