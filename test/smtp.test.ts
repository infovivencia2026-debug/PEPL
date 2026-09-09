import { describe, it, expect, afterEach, beforeAll, afterAll, beforeEach } from 'vitest'
import { createServer, type Server, type Socket } from 'node:net'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { sendViaSmtp, SmtpError, dotStuff } from '../src/mail/smtp.ts'
import { buildMessage, encodeHeader, htmlToText } from '../src/mail/mime.ts'
import { backoffMinutes, runOutbox, MAX_ATTEMPTS } from '../src/mail/outbox.ts'
import { ensureAccount, sendMail } from '../src/mail/index.ts'
import { encryptSecret } from '../src/comms/index.ts'

const MASTER = 'test-master-key-not-a-real-secret'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'

// ---------------------------------------------------------------------------
// A fake SMTP server: enough of the protocol to hold a real conversation.
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Reply to send instead of 250 at the named stage. */
  failAt?: { stage: 'mail' | 'rcpt' | 'data' | 'auth'; reply: string }
  advertiseAuth?: boolean
}

interface Fake {
  port: number
  transcript: string[]
  messages: string[]
  close: () => Promise<void>
}

async function startFakeSmtp(options: FakeOptions = {}): Promise<Fake> {
  const transcript: string[] = []
  const messages: string[] = []

  const server: Server = createServer((socket: Socket) => {
    let inData = false
    let body = ''
    socket.setEncoding('utf8')
    socket.write('220 fake.smtp.test ESMTP ready\r\n')

    socket.on('data', (chunk: string) => {
      if (inData) {
        body += chunk
        const end = body.indexOf('\r\n.\r\n')
        if (end !== -1) {
          messages.push(body.slice(0, end))
          body = ''
          inData = false
          socket.write(
            options.failAt?.stage === 'data'
              ? `${options.failAt.reply}\r\n`
              : '250 2.0.0 Ok: queued as ABC123\r\n',
          )
        }
        return
      }

      for (const line of chunk.split('\r\n').filter(Boolean)) {
        transcript.push(line)
        const verb = line.split(' ')[0]!.toUpperCase()

        if (verb === 'EHLO') {
          socket.write('250-fake.smtp.test\r\n250-SIZE 35882577\r\n')
          if (options.advertiseAuth !== false) socket.write('250-AUTH LOGIN PLAIN\r\n')
          socket.write('250 HELP\r\n')
        } else if (verb === 'AUTH') {
          if (options.failAt?.stage === 'auth') socket.write(`${options.failAt.reply}\r\n`)
          else if (line.toUpperCase().startsWith('AUTH PLAIN')) socket.write('235 2.7.0 Accepted\r\n')
          else socket.write('334 VXNlcm5hbWU6\r\n')
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && transcript.some((t) => t.startsWith('AUTH LOGIN'))) {
          // base64 continuation of AUTH LOGIN
          const priorLines = transcript.filter((t) => /^[A-Za-z0-9+/=]+$/.test(t))
          socket.write(priorLines.length >= 2 ? '235 2.7.0 Accepted\r\n' : '334 UGFzc3dvcmQ6\r\n')
        } else if (verb === 'MAIL') {
          socket.write(options.failAt?.stage === 'mail'
            ? `${options.failAt.reply}\r\n` : '250 2.1.0 Ok\r\n')
        } else if (verb === 'RCPT') {
          socket.write(options.failAt?.stage === 'rcpt'
            ? `${options.failAt.reply}\r\n` : '250 2.1.5 Ok\r\n')
        } else if (verb === 'DATA') {
          inData = true
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n')
        } else if (verb === 'QUIT') {
          socket.write('221 2.0.0 Bye\r\n')
          socket.end()
        } else {
          socket.write('502 5.5.2 Command not implemented\r\n')
        }
      }
    })
    socket.on('error', () => {})
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    transcript,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

let fake: Fake | null = null
afterEach(async () => {
  await fake?.close()
  fake = null
})

// ---------------------------------------------------------------------------

describe('the MIME builder produces something a mail client can read', () => {
  it('writes the headers a threading client needs', () => {
    const raw = buildMessage({
      from: { name: 'Priya Sharma', address: 'priya@acme.test' },
      to: ['auditor@external.example'],
      subject: 'September filing',
      bodyHtml: '<p>Attached.</p>',
      messageId: 'abc@pepl.internal',
      inReplyTo: 'prior@pepl.internal',
    })
    expect(raw).toContain('From: Priya Sharma <priya@acme.test>')
    expect(raw).toContain('To: auditor@external.example')
    expect(raw).toContain('Message-ID: <abc@pepl.internal>')
    expect(raw).toContain('In-Reply-To: <prior@pepl.internal>')
    expect(raw).toContain('References: <prior@pepl.internal>')
    expect(raw).toContain('MIME-Version: 1.0')
  })

  it('sends text and HTML so a plain-text client is not left blank', () => {
    const raw = buildMessage({
      from: { address: 'a@b.test' }, to: ['c@d.test'], subject: 'Hi',
      bodyHtml: '<p>Hello <b>there</b></p>', messageId: 'm@pepl.internal',
    })
    expect(raw).toContain('multipart/alternative')
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8')
    const text = Buffer.from(
      /text\/plain[\s\S]*?\r\n\r\n([A-Za-z0-9+/=\r\n]+)/.exec(raw)![1]!.replace(/\r\n/g, ''),
      'base64').toString('utf8')
    expect(text).toBe('Hello there')
  })

  it('encodes a subject that is not plain ASCII', () => {
    expect(encodeHeader('Salary ₹12,000')).toMatch(/^=\?UTF-8\?B\?/)
    expect(encodeHeader('Plain subject')).toBe('Plain subject')
  })

  it('turns markup into readable text, not a wall of tags', () => {
    expect(htmlToText('<h1>Payroll</h1><p>Locks on the 25th.<br>Please review.</p>'))
      .toBe('Payroll\nLocks on the 25th.\nPlease review.')
  })

  it('only wraps in multipart/mixed when something is attached', () => {
    const plain = buildMessage({
      from: { address: 'a@b.test' }, to: ['c@d.test'], subject: 'No files',
      bodyHtml: '<p>x</p>', messageId: 'm1@pepl.internal',
    })
    expect(plain).not.toContain('multipart/mixed')

    const withFile = buildMessage({
      from: { address: 'a@b.test' }, to: ['c@d.test'], subject: 'With file',
      bodyHtml: '<p>x</p>', messageId: 'm2@pepl.internal',
      attachments: [{ fileName: 'payslip.pdf', contentType: 'application/pdf', bytes: Buffer.from('%PDF') }],
    })
    expect(withFile).toContain('multipart/mixed')
    expect(withFile).toContain('Content-Disposition: attachment; filename="payslip.pdf"')
  })

  it('never emits a base64 line long enough to be refused', () => {
    const raw = buildMessage({
      from: { address: 'a@b.test' }, to: ['c@d.test'], subject: 'Long',
      bodyHtml: '<p>' + 'x'.repeat(10_000) + '</p>', messageId: 'm@pepl.internal',
    })
    expect(raw.split('\r\n').every((line) => line.length <= 998)).toBe(true)
  })
})

describe('a line starting with a dot cannot end the message early', () => {
  it('stuffs it', () => {
    expect(dotStuff('line one\n.hidden\nline three'))
      .toBe('line one\r\n..hidden\r\nline three')
  })
})

describe('the SMTP client holds a real conversation', () => {
  it('walks EHLO, MAIL, RCPT, DATA, QUIT in order', async () => {
    fake = await startFakeSmtp()
    await sendViaSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false },
      { from: 'priya@acme.test', to: ['auditor@external.example'], raw: 'Subject: Test\r\n\r\nBody' },
    )

    const verbs = fake.transcript.map((l) => l.split(' ')[0]!.toUpperCase())
    expect(verbs).toEqual(['EHLO', 'MAIL', 'RCPT', 'DATA', 'QUIT'])
    expect(fake.messages[0]).toContain('Subject: Test')
  })

  it('names every recipient', async () => {
    fake = await startFakeSmtp()
    await sendViaSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false },
      { from: 'a@b.test', to: ['one@x.test', 'two@x.test'], raw: 'Body' },
    )
    expect(fake.transcript.filter((l) => l.startsWith('RCPT'))).toEqual([
      'RCPT TO:<one@x.test>', 'RCPT TO:<two@x.test>',
    ])
  })

  it('authenticates when the server offers it', async () => {
    fake = await startFakeSmtp()
    await sendViaSmtp(
      {
        host: '127.0.0.1', port: fake.port, secure: false,
        username: 'priya', password: 'hunter2', allowInsecureAuth: true,
      },
      { from: 'a@b.test', to: ['c@d.test'], raw: 'Body' },
    )
    const auth = fake.transcript.find((l) => l.startsWith('AUTH PLAIN'))!
    const decoded = Buffer.from(auth.split(' ')[2]!, 'base64').toString('utf8')
    expect(decoded).toBe('\0priya\0hunter2')
  })

  it('refuses to send a password over an unencrypted connection', async () => {
    fake = await startFakeSmtp({ advertiseAuth: false })
    await expect(sendViaSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false, username: 'priya', password: 'hunter2' },
      { from: 'a@b.test', to: ['c@d.test'], raw: 'Body' },
    )).rejects.toMatchObject({ code: 'INSECURE_AUTH' })
  })

  it('reports a permanent rejection as permanent', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'rcpt', reply: '550 5.1.1 No such user' } })
    await expect(sendViaSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false },
      { from: 'a@b.test', to: ['ghost@x.test'], raw: 'Body' },
    )).rejects.toMatchObject({ code: 'SMTP_REJECTED', replyCode: 550 })
  })

  it('reports a temporary rejection as temporary', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'mail', reply: '451 4.3.0 Try again later' } })
    await expect(sendViaSmtp(
      { host: '127.0.0.1', port: fake.port, secure: false },
      { from: 'a@b.test', to: ['c@d.test'], raw: 'Body' },
    )).rejects.toMatchObject({ code: 'SMTP_TEMPORARY', replyCode: 451 })
  })

  it('never puts the password in an error message', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'auth', reply: '535 5.7.8 Bad credentials' } })
    const error = await sendViaSmtp(
      {
        host: '127.0.0.1', port: fake.port, secure: false,
        username: 'priya', password: 'hunter2', allowInsecureAuth: true,
      },
      { from: 'a@b.test', to: ['c@d.test'], raw: 'Body' },
    ).then(() => null, (e: Error) => e)
    expect(error).toBeInstanceOf(SmtpError)
    expect(error!.message).not.toContain('hunter2')
    expect(error!.message).toContain('AUTH failed')
  })

  it('gives up on a host that is not there', async () => {
    await expect(sendViaSmtp(
      { host: '127.0.0.1', port: 9, secure: false, timeoutMs: 1500 },
      { from: 'a@b.test', to: ['c@d.test'], raw: 'Body' },
    )).rejects.toBeInstanceOf(SmtpError)
  })
})

// ---------------------------------------------------------------------------
// The worker
// ---------------------------------------------------------------------------

let A: Tenant
let B: Tenant

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

/** A mailbox with outgoing settings, and one message queued for outside. */
async function queueExternalMessage(
  tenantId: string,
  smtpPort: number,
  // Most cases send unauthenticated: PEPL refuses to put a password on a plain
  // connection, which is a rule worth keeping rather than working around here.
  withCredentials = false,
): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const account = await ensureAccount(tx, {
      userId: ALICE, email: 'alice@acme.test', displayName: 'Alice',
    })
    await tx.query(
      `UPDATE mail_accounts
          SET smtp_host = '127.0.0.1', smtp_port = $2, smtp_secure = false,
              username = CASE WHEN $4 THEN 'alice'::text END,
              secret_ciphertext = CASE WHEN $4 THEN $3::bytea END
        WHERE id = $1`,
      [account.id, smtpPort, encryptSecret('hunter2', tenantId, MASTER), withCredentials],
    )
    const result = await sendMail(tx, {
      account,
      userId: ALICE,
      idempotencyKey: `out-${Date.now()}-${Math.random()}`,
      allowExternal: true,
      draft: {
        to: ['auditor@external.example'],
        subject: 'September filing',
        bodyHtml: '<p>Attached for your review.</p>',
      },
    })
    return result.sentEnvelopeId
  })
}

const commands = (tenantId: string) =>
  withTenant(tenantId, async (tx) => {
    const r = await tx.query(
      `SELECT status, attempts, last_error FROM mail_commands ORDER BY created_at`)
    return r.rows as { status: string; attempts: number; last_error: string | null }[]
  })

describe('the outbox worker', () => {
  it('sends a queued message and marks it done', async () => {
    fake = await startFakeSmtp()
    await queueExternalMessage(A.id, fake.port)

    // No injected sender: this exercises the real SMTP client against the fake
    // server, which is the only way the client itself is covered.
    const run = await runOutbox(A.id, { master: MASTER })
    expect(run.sent).toBe(1)
    expect(run.abandoned).toBe(0)

    expect((await commands(A.id))[0]).toMatchObject({ status: 'done', attempts: 1 })
    expect(fake.messages[0]).toContain('Subject: September filing')
    expect(fake.messages[0]).toContain('From: Alice <alice@acme.test>')
  })

  it('leaves a temporary failure queued for another attempt', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'mail', reply: '451 4.3.0 Try again' } })
    await queueExternalMessage(A.id, fake.port)

    const run = await runOutbox(A.id, { master: MASTER })
    expect(run.sent).toBe(0)
    expect(run.retrying).toBe(1)

    const [row] = await commands(A.id)
    expect(row!.status).toBe('queued')
    expect(row!.attempts).toBe(1)
    expect(row!.last_error).toContain('451')
  })

  it('abandons a permanent rejection instead of retrying forever', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'rcpt', reply: '550 5.1.1 No such user' } })
    await queueExternalMessage(A.id, fake.port)

    const run = await runOutbox(A.id, { master: MASTER })
    expect(run.abandoned).toBe(1)
    expect((await commands(A.id))[0]).toMatchObject({ status: 'abandoned' })
  })

  it('abandons a message that has used up its attempts', async () => {
    fake = await startFakeSmtp({ failAt: { stage: 'mail', reply: '451 4.3.0 Try again' } })
    await queueExternalMessage(A.id, fake.port)
    await withTenant(A.id, (tx) =>
      tx.query(`UPDATE mail_commands SET attempts = $1`, [MAX_ATTEMPTS - 1]))

    const run = await runOutbox(A.id, { master: MASTER, now: new Date(Date.now() + 3_600_000) })
    expect(run.abandoned).toBe(1)
  })

  it('does not send the same message twice', async () => {
    fake = await startFakeSmtp()
    await queueExternalMessage(A.id, fake.port)

    await runOutbox(A.id, { master: MASTER })
    const second = await runOutbox(A.id, { master: MASTER })

    expect(second.claimed).toBe(0)
    expect(fake.messages).toHaveLength(1)
  })

  it('backs off further with each attempt, up to a ceiling', () => {
    expect([1, 2, 3, 4, 5, 9].map(backoffMinutes)).toEqual([1, 2, 4, 8, 16, 16])
  })

  it('touches only the caller company', async () => {
    fake = await startFakeSmtp()
    await queueExternalMessage(A.id, fake.port)

    const run = await runOutbox(B.id, { master: MASTER })
    expect(run.claimed).toBe(0)
    expect((await commands(A.id))[0]!.status).toBe('queued')
  })

  it('fails a mailbox with no outgoing server, rather than hanging', async () => {
    await withTenant(A.id, async (tx) => {
      const account = await ensureAccount(tx, {
        userId: ALICE, email: 'alice@acme.test', displayName: 'Alice',
      })
      await sendMail(tx, {
        account, userId: ALICE, idempotencyKey: 'no-smtp', allowExternal: true,
        draft: { to: ['outside@example.test'], subject: 'Nowhere', bodyHtml: '<p>x</p>' },
      })
    })

    const run = await runOutbox(A.id, { master: MASTER })
    expect(run.abandoned).toBe(1)
    expect(run.errors[0]).toContain('no outgoing server configured')
  })
})
