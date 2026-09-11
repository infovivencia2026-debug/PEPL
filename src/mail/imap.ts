/**
 * The IMAP client.
 *
 * This wraps `imapflow` rather than speaking the protocol directly, which is a
 * deliberate exception to the no-dependency stance the router, the PDF writer
 * and the SMTP client follow. SMTP is a dozen line-oriented commands; IMAP is
 * not. Literals (`{1234}` followed by raw octets that may contain CRLF), modified
 * UTF-7 mailbox names, sequence-versus-UID numbering and a long tail of server
 * quirks mean a hand-rolled client passes against a friendly fake and mis-frames
 * the first real mailbox it meets.
 *
 * The same library is already in production in the sibling ONROL deployment,
 * which is better evidence than anything written here from scratch.
 *
 * What PEPL still owns is everything above the protocol: the folder mapping,
 * the UID watermark, the UIDVALIDITY rebuild and the quarantine policy, all in
 * sync.ts. That is the part with our semantics in it.
 */
import { ImapFlow } from 'imapflow'

export class ImapError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ImapError'
  }
}

export interface ImapConfig {
  host: string
  port: number
  /** true = TLS from the first byte (993). false = plain, upgraded by STARTTLS (143). */
  secure: boolean
  username: string
  password: string
  timeoutMs?: number
  /** Test seam only. Never set this against a real server. */
  allowInsecureAuth?: boolean
}

export interface ImapFolder {
  path: string
  name: string
  /** inbox | sent | drafts | trash | junk | archive | custom */
  role: string
  selectable: boolean
}

export interface ImapEnvelope {
  uid: number
  messageId: string | null
  inReplyTo: string | null
  subject: string | null
  fromName: string | null
  fromAddress: string | null
  to: string[]
  cc: string[]
  date: string | null
  size: number
  seen: boolean
  flagged: boolean
  answered: boolean
  hasAttachment: boolean
}

export interface Connection {
  listFolders(): Promise<ImapFolder[]>
  select(path: string): Promise<{ exists: number; uidValidity: number; uidNext: number }>
  fetchSince(uid: number, limit: number): Promise<ImapEnvelope[]>
  fetchBody(uid: number): Promise<{ html: string | null; text: string | null }>
  setFlag(uid: number, flag: '\\Seen' | '\\Flagged', on: boolean): Promise<void>
  moveTo(uid: number, path: string): Promise<void>
  /**
   * IDLE on the selected folder until the server announces new mail, the
   * timeout passes, or the connection drops. Optional: a connector that cannot
   * push (the test fake by default) simply has no IDLE and is polled.
   */
  waitForNewMail?(timeoutMs: number): Promise<'new' | 'timeout' | 'closed'>
  close(): Promise<void>
}

/**
 * Maps a server folder to the role the UI understands.
 *
 * The RFC 6154 special-use flag is authoritative where a server sends one;
 * plenty do not, so the names servers actually ship with are the fallback.
 */
export function roleOf(path: string, specialUse?: string | null): string {
  const flag = (specialUse ?? '').toLowerCase()
  if (path.toUpperCase() === 'INBOX' || flag === '\\inbox') return 'inbox'
  for (const [special, role] of [
    ['\\sent', 'sent'], ['\\drafts', 'drafts'], ['\\trash', 'trash'],
    ['\\junk', 'junk'], ['\\archive', 'archive'],
  ] as const) {
    if (flag === special) return role
  }
  const leaf = path.split(/[/.]/).pop()?.toLowerCase() ?? ''
  if (/^sent/.test(leaf)) return 'sent'
  if (/^draft/.test(leaf)) return 'drafts'
  if (/^(trash|deleted)/.test(leaf)) return 'trash'
  if (/^(junk|spam)/.test(leaf)) return 'junk'
  if (/^archive/.test(leaf)) return 'archive'
  return 'custom'
}

function addressList(list: { address?: string; name?: string }[] | undefined): string[] {
  return (list ?? []).map((a) => a.address ?? a.name ?? '').filter(Boolean)
}

/**
 * Connects and authenticates.
 *
 * `disableAutoIdle` so IDLE is something the caller ASKS for (idle.ts holds a
 * bounded number of connections open) rather than something every sync
 * connection drifts into between commands.
 */
export async function connectImap(config: ImapConfig): Promise<Connection> {
  /**
   * imapflow authenticates inside connect(), and on a plain port it will fall
   * back to sending LOGIN in the clear when the server offers no STARTTLS. By
   * then the password has left the building, so the decision has to be made
   * here rather than checked afterwards: implicit TLS (993) unless a caller
   * explicitly accepts the risk.
   */
  if (!config.secure && !config.allowInsecureAuth) {
    throw new ImapError(
      'INSECURE_AUTH',
      `${config.host} is configured without TLS; PEPL will not risk sending a mailbox ` +
      'password in the clear. Use the TLS port (usually 993).',
    )
  }

  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: { user: config.username, pass: config.password },
    logger: false,
    disableAutoIdle: true,
    socketTimeout: config.timeoutMs ?? 20_000,
    greetingTimeout: 10_000,
  })

  /**
   * A socket reset surfaces as an 'error' EVENT, not a rejected promise, so the
   * try/catch around connect() cannot see it. With no listener, EventEmitter
   * rethrows it as an uncaught exception and takes the process down — in the
   * ONROL deployment one slow IMAP handshake stopped attendance and payroll for
   * everyone. Mail is auxiliary and must never be able to do that.
   */
  client.on('error', () => { /* surfaced by the awaited call that follows */ })

  try {
    await client.connect()
    if (config.secure && !client.secureConnection) {
      throw new ImapError('INSECURE_AUTH', 'the connection did not negotiate TLS')
    }
  } catch (err) {
    if (err instanceof ImapError) throw err
    const message = (err as Error).message ?? String(err)
    throw new ImapError(
      /auth|credential|login/i.test(message) ? 'AUTH_FAILED' : 'CONNECTION_FAILED',
      message,
    )
  }

  let open: { path: string; lock: { release: () => void } } | null = null

  const release = (): void => {
    open?.lock.release()
    open = null
  }

  const openFolder = async (path: string): Promise<void> => {
    if (open?.path === path) return
    release()
    open = { path, lock: await client.getMailboxLock(path) }
  }

  return {
    async listFolders() {
      const list = await client.list()
      return list.map((box) => ({
        path: box.path,
        name: box.name ?? box.path.split(/[/.]/).pop() ?? box.path,
        role: roleOf(box.path, box.specialUse),
        selectable: !box.flags?.has('\\Noselect'),
      }))
    },

    async select(path) {
      await openFolder(path)
      const mailbox = client.mailbox
      if (!mailbox || typeof mailbox === 'boolean') {
        throw new ImapError('COMMAND_FAILED', `could not open ${path}`)
      }
      return {
        exists: mailbox.exists ?? 0,
        uidValidity: Number(mailbox.uidValidity ?? 0),
        uidNext: Number(mailbox.uidNext ?? 0),
      }
    },

    /** Everything above the watermark. `uid+1:*` is the standard idiom. */
    async fetchSince(uid, limit) {
      const envelopes: ImapEnvelope[] = []
      for await (const message of client.fetch(
        { uid: `${uid + 1}:*` },
        { uid: true, envelope: true, flags: true, size: true, bodyStructure: true },
      )) {
        // The server may include the watermark itself in an open-ended range.
        if (message.uid <= uid) continue
        const envelope = message.envelope
        const from = envelope?.from?.[0]
        envelopes.push({
          uid: message.uid,
          messageId: envelope?.messageId?.replace(/[<>]/g, '') ?? null,
          inReplyTo: envelope?.inReplyTo?.replace(/[<>]/g, '') ?? null,
          subject: envelope?.subject ?? null,
          fromName: from?.name ?? null,
          fromAddress: from?.address ?? null,
          to: addressList(envelope?.to),
          cc: addressList(envelope?.cc),
          date: envelope?.date ? new Date(envelope.date).toISOString() : null,
          size: Number(message.size ?? 0),
          seen: message.flags?.has('\\Seen') ?? false,
          flagged: message.flags?.has('\\Flagged') ?? false,
          answered: message.flags?.has('\\Answered') ?? false,
          hasAttachment: (message.bodyStructure?.childNodes ?? []).some(
            (node) => node.disposition === 'attachment',
          ),
        })
        if (envelopes.length >= limit) break
      }
      return envelopes
    },

    async fetchBody(uid) {
      const message = await client.fetchOne(String(uid), { source: true }, { uid: true })
      if (!message || typeof message === 'boolean' || !message.source) {
        return { html: null, text: null }
      }
      const source = message.source.toString('utf8')
      const separator = source.indexOf('\r\n\r\n')
      const body = separator === -1 ? source : source.slice(separator + 4)
      return /<[a-z][\s\S]*>/i.test(body) ? { html: body, text: null } : { html: null, text: body }
    },

    async setFlag(uid, flag, on) {
      const change = { uid: String(uid) }
      if (on) await client.messageFlagsAdd(change, [flag], { uid: true })
      else await client.messageFlagsRemove(change, [flag], { uid: true })
    },

    async moveTo(uid, path) {
      await client.messageMove({ uid: String(uid) }, path, { uid: true })
    },

    waitForNewMail(timeoutMs) {
      return new Promise((resolve) => {
        let done = false
        const finish = (r: 'new' | 'timeout' | 'closed'): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          client.off('exists', onExists)
          client.off('close', onClose)
          // Any command ends IDLE; NOOP is the one that changes nothing.
          if (r !== 'closed') client.noop().catch(() => { /* the socket is gone; caller sees it next */ })
          resolve(r)
        }
        const onExists = (): void => finish('new')
        const onClose = (): void => finish('closed')
        const timer = setTimeout(() => finish('timeout'), timeoutMs)
        client.on('exists', onExists)
        client.on('close', onClose)
        // imapflow ends IDLE itself every maxIdleTime; re-enter until we are done.
        const loop = (): void => {
          client.idle().then(() => { if (!done) loop() }).catch(() => finish('closed'))
        }
        loop()
      })
    },

    async close() {
      release()
      try {
        await client.logout()
      } catch {
        // A failed logout does not undo anything that already happened.
      }
    },
  }
}
