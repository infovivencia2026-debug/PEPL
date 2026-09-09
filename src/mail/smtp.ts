/**
 * A minimal SMTP client.
 *
 * Enough of RFC 5321 to hand a message to the tenant's own mail server:
 * EHLO, STARTTLS, AUTH, MAIL FROM, RCPT TO, DATA, QUIT. Written here for the
 * same reason as the router and the PDF writer — this is the process that holds
 * customer mail credentials, and every dependency in it is one more thing whose
 * releases have to be watched for the life of the product.
 *
 * Deliberately not supported: connection pooling, pipelining, DSN, 8BITMIME
 * negotiation. One message per connection is slower and much easier to reason
 * about when a send fails.
 */
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'

export class SmtpError extends Error {
  readonly code: string
  /** The SMTP reply code. 4xx is worth retrying; 5xx is not. */
  readonly replyCode: number
  constructor(code: string, message: string, replyCode = 0) {
    super(message)
    this.code = code
    this.replyCode = replyCode
    this.name = 'SmtpError'
  }
}

export interface SmtpConfig {
  host: string
  port: number
  /** true = TLS from the first byte (465). false = plain, upgraded by STARTTLS (587). */
  secure: boolean
  username?: string
  password?: string
  /** Name sent in EHLO. Some servers reject a bare hostname they cannot resolve. */
  clientName?: string
  timeoutMs?: number
  /** Test seam only. Never set this against a real server. */
  allowInsecureAuth?: boolean
}

export interface SendArgs {
  from: string
  to: readonly string[]
  /** The full RFC 5322 message, headers included. */
  raw: string
}

/** One reply: the code, and every line of text that came with it. */
interface Reply {
  code: number
  text: string
}

/**
 * Wraps a socket in a line-oriented request/response conversation.
 *
 * SMTP replies can span lines (`250-SIZE` … `250 HELP`), so a reply is only
 * complete when a line has a space, not a hyphen, after the code.
 */
class Session {
  private socket: Socket | TLSSocket
  private buffer = ''
  private pending: ((reply: Reply | Error) => void) | null = null
  private closed = false

  constructor(socket: Socket | TLSSocket) {
    this.socket = socket
    this.attach()
  }

  private attach(): void {
    this.socket.setEncoding('utf8')
    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk
      this.drain()
    })
    this.socket.on('error', (err) => this.fail(err))
    this.socket.on('close', () => {
      this.closed = true
      this.fail(new SmtpError('CONNECTION_CLOSED', 'the server closed the connection'))
    })
  }

  private fail(err: Error): void {
    const waiting = this.pending
    this.pending = null
    waiting?.(err)
  }

  private drain(): void {
    if (!this.pending) return
    const lines = this.buffer.split(/\r?\n/)
    for (let i = 0; i < lines.length - 1; i++) {
      const line = lines[i]!
      // A complete reply ends with "NNN " — a hyphen means more lines follow.
      if (/^\d{3} /.test(line)) {
        const consumed = lines.slice(0, i + 1).join('\r\n')
        this.buffer = this.buffer.slice(consumed.length).replace(/^\r?\n/, '')
        const reply: Reply = { code: Number(line.slice(0, 3)), text: consumed }
        const waiting = this.pending
        this.pending = null
        waiting?.(reply)
        return
      }
    }
  }

  /** Waits for the next complete reply. */
  read(timeoutMs: number): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.closed) {
        reject(new SmtpError('CONNECTION_CLOSED', 'the connection is already closed'))
        return
      }
      const timer = setTimeout(() => {
        this.pending = null
        reject(new SmtpError('TIMEOUT', `the server did not reply within ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending = (result) => {
        clearTimeout(timer)
        if (result instanceof Error) reject(result)
        else resolve(result)
      }
      this.drain()
    })
  }

  write(line: string): void {
    this.socket.write(line + '\r\n')
  }

  /** Sends a command and returns the reply, throwing on an unexpected code. */
  async command(line: string, expect: number[], timeoutMs: number): Promise<Reply> {
    this.write(line)
    const reply = await this.read(timeoutMs)
    if (!expect.includes(reply.code)) {
      throw new SmtpError(
        reply.code >= 500 ? 'SMTP_REJECTED' : 'SMTP_TEMPORARY',
        // The command is included, but never the line that carries a password.
        `${line.startsWith('AUTH') ? 'AUTH' : line.split(' ')[0]} failed: ${reply.text}`,
        reply.code,
      )
    }
    return reply
  }

  raw(): Socket | TLSSocket {
    return this.socket
  }

  end(): void {
    this.closed = true
    this.socket.removeAllListeners()
    this.socket.destroy()
  }
}

function openSocket(config: SmtpConfig, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host })
      : netConnect({ host: config.host, port: config.port })

    const timer = setTimeout(() => {
      socket.destroy()
      reject(new SmtpError('TIMEOUT', `could not reach ${config.host}:${config.port}`))
    }, timeoutMs)

    socket.once(config.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer)
      resolve(socket)
    })
    socket.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(new SmtpError('CONNECTION_FAILED', err.message))
    })
  })
}

function upgrade(socket: Socket, host: string, timeoutMs: number): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    socket.removeAllListeners('data')
    socket.removeAllListeners('error')
    socket.removeAllListeners('close')
    const tls = tlsConnect({ socket, servername: host })
    const timer = setTimeout(() => reject(new SmtpError('TIMEOUT', 'the TLS handshake stalled')), timeoutMs)
    tls.once('secureConnect', () => {
      clearTimeout(timer)
      resolve(tls)
    })
    tls.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(new SmtpError('TLS_FAILED', err.message))
    })
  })
}

/** A line in the DATA body starting with "." would end the message early. */
export function dotStuff(message: string): string {
  return message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
}

/**
 * Delivers one message and closes the connection.
 *
 * Throws `SmtpError`. `replyCode` in the 400s means the server asked to be tried
 * again later; 500s mean it will never accept this message and retrying only
 * wastes the queue.
 */
export async function sendViaSmtp(config: SmtpConfig, args: SendArgs): Promise<void> {
  const timeoutMs = config.timeoutMs ?? 20_000
  const clientName = config.clientName ?? 'pepl.local'
  if (args.to.length === 0) throw new SmtpError('NO_RECIPIENTS', 'no recipients')

  let socket = await openSocket(config, timeoutMs)
  let session = new Session(socket)

  try {
    const greeting = await session.read(timeoutMs)
    if (greeting.code !== 220) {
      throw new SmtpError('SMTP_REJECTED', `unexpected greeting: ${greeting.text}`, greeting.code)
    }

    let capabilities = (await session.command(`EHLO ${clientName}`, [250], timeoutMs)).text

    // Upgrade a plain connection before anything secret crosses it.
    if (!config.secure && /STARTTLS/i.test(capabilities)) {
      await session.command('STARTTLS', [220], timeoutMs)
      const tls = await upgrade(socket as Socket, config.host, timeoutMs)
      socket = tls
      session = new Session(tls)
      capabilities = (await session.command(`EHLO ${clientName}`, [250], timeoutMs)).text
    }

    if (config.username && config.password) {
      const encrypted = config.secure || /STARTTLS/i.test(capabilities)
      if (!encrypted && !config.allowInsecureAuth) {
        throw new SmtpError(
          'INSECURE_AUTH',
          `${config.host} offered no TLS; PEPL will not send a mailbox password in the clear`,
        )
      }
      if (/AUTH[ =-].*PLAIN/i.test(capabilities)) {
        const token = Buffer.from(`\0${config.username}\0${config.password}`).toString('base64')
        await session.command(`AUTH PLAIN ${token}`, [235], timeoutMs)
      } else {
        await session.command('AUTH LOGIN', [334], timeoutMs)
        await session.command(Buffer.from(config.username).toString('base64'), [334], timeoutMs)
        await session.command(Buffer.from(config.password).toString('base64'), [235], timeoutMs)
      }
    }

    await session.command(`MAIL FROM:<${args.from}>`, [250], timeoutMs)
    for (const recipient of args.to) {
      await session.command(`RCPT TO:<${recipient}>`, [250, 251], timeoutMs)
    }
    await session.command('DATA', [354], timeoutMs)
    session.raw().write(dotStuff(args.raw) + '\r\n.\r\n')

    const accepted = await session.read(timeoutMs)
    if (accepted.code !== 250) {
      throw new SmtpError(
        accepted.code >= 500 ? 'SMTP_REJECTED' : 'SMTP_TEMPORARY',
        `the server refused the message: ${accepted.text}`,
        accepted.code,
      )
    }

    // A failed QUIT after a 250 does not un-send anything.
    try {
      await session.command('QUIT', [221], 2_000)
    } catch {
      // accepted is accepted
    }
  } finally {
    session.end()
  }
}
