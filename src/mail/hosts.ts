/**
 * Where a mailbox may connect, what a failure may say, and when it may authenticate.
 *
 * An employee supplies the IMAP and SMTP host for their own mailbox, and the server then connects
 * to it. Unchecked, that is a way to make the server connect to anything it can reach -- loopback,
 * the other applications on this box, the cloud metadata address -- and the server's reply was
 * stored and shown back as the "last error", so a connection attempt doubled as a port scanner.
 */
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isBlockedAddress, OutboundUrlError } from '../net/outbound-url.ts'

/** The ports mail actually uses. Anything else (SSH, Redis, Postgres, memcached...) is not mail. */
export const IMAP_PORTS: readonly number[] = [143, 993]
export const SMTP_PORTS: readonly number[] = [25, 465, 587, 2525]

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i

const loopback = (host: string): boolean => host === 'localhost' || host === '127.0.0.1' || host === '::1'

/**
 * Throws when this host and port are not somewhere a mailbox may connect. Called when the mailbox
 * is saved AND before every connection: what a name resolves to can change after it was accepted.
 *
 * Loopback is allowed outside production only, because the mail tests run real servers on it.
 */
export async function assertMailEndpoint(kind: 'imap' | 'smtp', host: string, port: number): Promise<void> {
  const h = (host ?? '').trim()
  if (!HOSTNAME.test(h) && isIP(h.replace(/^\[|\]$/g, '')) === 0) {
    throw new OutboundUrlError('that is not a valid mail server host name')
  }
  const devLoopback = process.env.NODE_ENV !== 'production' && loopback(h)
  if (!devLoopback) {
    const allowed = kind === 'imap' ? IMAP_PORTS : SMTP_PORTS
    if (!allowed.includes(port)) {
      throw new OutboundUrlError(`${kind.toUpperCase()} uses port ${allowed.join(', ')}; ${port} is not a mail port`)
    }
  }
  // EVERY address the name resolves to must be public. (assertResolvesPublic allows every private
  // range outside production, which is right for webhooks' tests but not for a mailbox.)
  const bare = h.replace(/^\[|\]$/g, '')
  let addresses: string[]
  try {
    addresses = isIP(bare) ? [bare] : (await lookup(bare, { all: true })).map((a) => a.address)
  } catch {
    // A name that does not resolve is not a target. Production still refuses it at save time (a
    // mailbox that cannot be reached is useless); development tolerates it so tests can use
    // made-up hosts. Either way the check runs again at every connection.
    if (process.env.NODE_ENV !== 'production') return
    throw new OutboundUrlError('that mail server does not resolve')
  }
  for (const a of addresses) {
    const isLoopbackAddr = a === '::1' || a.startsWith('127.')
    if (isBlockedAddress(a) && !(devLoopback && isLoopbackAddr)) {
      throw new OutboundUrlError('that mail server is on a private or link-local address')
    }
  }
}

/**
 * A failure as it may be shown to the person and stored: what KIND of problem, never what the
 * server said. The raw text can carry a banner, a version string or an internal host name.
 */
export function publicMailError(raw: string): string {
  const s = String(raw ?? '')
  if (/INSECURE_AUTH|without TLS|offered no TLS/i.test(s)) {
    return 'the server offers no TLS, so the password was not sent; use the TLS port'
  }
  if (/auth|credential|login|password|535|invalid user/i.test(s)) return 'the server rejected the sign-in; check the username and password'
  if (/tls|ssl|certificate|handshake|secure/i.test(s)) return 'a secure connection to the server could not be established'
  if (/timeout|timed out|stalled/i.test(s)) return 'the server did not respond in time'
  if (/ECONN|ENOTFOUND|EHOST|ENET|EAI_|resolve|reach|refused|reset/i.test(s)) return 'the server could not be reached'
  return 'the mail server reported an error'
}

/**
 * May a password be sent now? Decided from what THIS client did -- the connection was implicit TLS,
 * or it completed a STARTTLS upgrade -- and never from the server's capability list. After an
 * upgrade a server must NOT advertise STARTTLS (RFC 3207), so reading it from there called a
 * correctly encrypted connection insecure and refused to authenticate on it.
 */
export function smtpMayAuthenticate(s: { secure: boolean; upgraded: boolean; allowInsecureAuth?: boolean }): boolean {
  return s.secure || s.upgraded || s.allowInsecureAuth === true
}
