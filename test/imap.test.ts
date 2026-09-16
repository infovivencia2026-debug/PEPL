/**
 * The inbound sync.
 *
 * The IMAP protocol itself is imapflow's problem now, so nothing here speaks
 * it. What PEPL owns is the mapping — folder roles, the UID watermark, the
 * UIDVALIDITY rebuild, quarantine, and whether a body is allowed to be stored —
 * and that is what these drive, through an injected connection.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import {
  roleOf, ImapError, type Connection, type ImapEnvelope, type ImapFolder,
} from '../src/mail/imap.ts'
import { syncAccount, syncableAccounts, syncTenant } from '../src/mail/sync.ts'
import {
  ensureAccount, folderByRole, listEnvelopes, listFolders, openMessage,
} from '../src/mail/index.ts'
import { encryptSecret } from '../src/comms/index.ts'
import { subscribe, type DeliveredEvent } from '../src/realtime/bus.ts'

const MASTER = 'test-master-key-not-a-real-secret'
const ALICE = 'e0000000-0000-0000-0000-00000000000e'

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

// ---------------------------------------------------------------------------
// A stand-in mailbox
// ---------------------------------------------------------------------------

interface FakeMailbox {
  folders: ImapFolder[]
  messages: Record<string, ImapEnvelope[]>
  bodies?: Record<number, string>
  uidValidity?: number
  failWith?: ImapError
}

function fakeConnection(mailbox: FakeMailbox): () => Promise<Connection> {
  return async () => {
    if (mailbox.failWith) throw mailbox.failWith
    let current = 'INBOX'
    return {
      async listFolders() {
        return mailbox.folders
      },
      async select(path) {
        current = path
        const messages = mailbox.messages[path] ?? []
        return {
          exists: messages.length,
          uidValidity: mailbox.uidValidity ?? 1000,
          uidNext: messages.length + 1,
        }
      },
      async fetchSince(uid, limit) {
        return (mailbox.messages[current] ?? [])
          .filter((m) => m.uid > uid)
          .slice(0, limit)
      },
      async fetchBody(uid) {
        const body = mailbox.bodies?.[uid] ?? null
        return { source: body ? Buffer.from(`Content-Type: text/html; charset=utf-8\r\n\r\n${body}`) : null }
      },
      async setFlag() {},
      async moveTo() {},
      async close() {},
    }
  }
}

const envelope = (uid: number, subject: string, over: Partial<ImapEnvelope> = {}): ImapEnvelope => ({
  uid,
  messageId: `msg-${uid}@fake.test`,
  inReplyTo: null,
  subject,
  fromName: 'Accounts',
  fromAddress: 'accounts@vendor.example',
  to: ['alice@acme.test'],
  cc: [],
  date: '2026-09-01T10:00:00.000Z',
  size: 812,
  seen: false,
  flagged: false,
  answered: false,
  hasAttachment: false,
  ...over,
})

const STANDARD_FOLDERS: ImapFolder[] = [
  { path: 'INBOX', name: 'INBOX', role: 'inbox', selectable: true },
  { path: 'Sent Items', name: 'Sent Items', role: 'sent', selectable: true },
  { path: 'Folders', name: 'Folders', role: 'custom', selectable: false },
]

const MAILBOX = (): FakeMailbox => ({
  folders: STANDARD_FOLDERS,
  messages: {
    INBOX: [envelope(1, 'Invoice 4471'), envelope(2, 'Re: Statutory filing', { seen: true })],
    'Sent Items': [],
  },
  bodies: { 1: '<p>Payment due.</p>', 2: '<p>Filed.</p>' },
})

async function connectedMailbox(tenantId: string): Promise<string> {
  return withTenant(tenantId, async (tx) => {
    const account = await ensureAccount(tx, {
      userId: ALICE, email: 'alice@acme.test', displayName: 'Alice',
    })
    await tx.query(
      `UPDATE mail_accounts
          SET provider = 'imap_generic', imap_host = 'imap.example.test', imap_port = 993,
              imap_secure = true, username = 'alice', secret_ciphertext = $2
        WHERE id = $1`,
      [account.id, encryptSecret('hunter2', tenantId, MASTER)])
    return account.id
  })
}

const sync = async (tenantId: string, mailbox: FakeMailbox, storeBodies = false) => {
  const [account] = await withTenant(tenantId, (tx) => syncableAccounts(tx))
  return syncAccount(tenantId, account!, {
    master: MASTER, storeBodies, connect: fakeConnection(mailbox),
  })
}

// ---------------------------------------------------------------------------

describe('folder roles', () => {
  it('trusts the special-use flag where a server sends one', () => {
    expect(roleOf('Whatever', '\\Sent')).toBe('sent')
    expect(roleOf('Bin', '\\Trash')).toBe('trash')
  })

  it('falls back to the names servers actually ship', () => {
    expect(roleOf('INBOX', null)).toBe('inbox')
    expect(roleOf('Sent Items', null)).toBe('sent')
    expect(roleOf('Deleted Items', null)).toBe('trash')
    expect(roleOf('Spam', null)).toBe('junk')
    expect(roleOf('Drafts', undefined)).toBe('drafts')
  })

  it('leaves anything else as a custom folder', () => {
    expect(roleOf('Clients/Acme', null)).toBe('custom')
    expect(roleOf('2026 Archive of Invoices', null)).toBe('custom')
  })
})

describe('syncing a mailbox', () => {
  it('announces new mail to the mailbox owner only, once per folder, after commit', async () => {
    const accountId = await connectedMailbox(A.id)
    const mine: DeliveredEvent[] = []
    const theirs: DeliveredEvent[] = []
    const off1 = subscribe(A.id, ALICE, (e) => mine.push(e))
    const off2 = subscribe(A.id, 'f0000000-0000-0000-0000-00000000000f', (e) => theirs.push(e))
    try {
      const mailbox = MAILBOX()
      await sync(A.id, mailbox)
      const received = mine.filter((e) => e.type === 'mail.received')
      expect(received).toHaveLength(1)            // two messages, one INBOX pass
      expect(received[0]!.data).toMatchObject({ folder: 'inbox', added: 2 })
      expect(theirs.filter((e) => e.type === 'mail.received')).toHaveLength(0)
      // the envelopes it announces are already readable
      const folders = await withTenant(A.id, (tx) => listFolders(tx, accountId))
      expect(folders.find((f) => f.role === 'inbox')!.unread).toBeGreaterThan(0)

      mine.length = 0
      await sync(A.id, mailbox)                    // nothing new: no event
      expect(mine.filter((e) => e.type === 'mail.received')).toHaveLength(0)
    } finally {
      off1()
      off2()
    }
  })

  it('caches the envelopes and skips unselectable folders', async () => {
    const accountId = await connectedMailbox(A.id)
    const result = await sync(A.id, MAILBOX())

    expect(result.messagesAdded).toBe(2)
    expect(result.errors).toEqual([])

    const inbox = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, accountId, 'inbox') }))
    expect(inbox.envelopes.map((e) => e.subject).sort())
      .toEqual(['Invoice 4471', 'Re: Statutory filing'])
    expect(inbox.envelopes.find((e) => e.subject === 'Re: Statutory filing')!.is_seen).toBe(true)
    expect(inbox.envelopes[0]!.from_address).toBe('accounts@vendor.example')
  })

  it('adopts the local folder rather than creating a second Sent', async () => {
    const accountId = await connectedMailbox(A.id)
    await sync(A.id, MAILBOX())

    const folders = await withTenant(A.id, (tx) => listFolders(tx, accountId))
    const sent = folders.filter((f) => f.role === 'sent')
    expect(sent).toHaveLength(1)
    // and it now carries the server's name for it
    expect(sent[0]!.path).toBe('Sent Items')
  })

  it('adds only what is new on a second pass', async () => {
    await connectedMailbox(A.id)
    const mailbox = MAILBOX()
    await sync(A.id, mailbox)
    expect((await sync(A.id, mailbox)).messagesAdded).toBe(0)

    mailbox.messages.INBOX!.push(envelope(3, 'Reminder'))
    expect((await sync(A.id, mailbox)).messagesAdded).toBe(1)
  })

  it('keeps bodies out of the database unless the company asked for them', async () => {
    await connectedMailbox(A.id)
    await sync(A.id, MAILBOX(), false)

    const stored = await withTenant(A.id, async (tx) => {
      const r = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM mail_bodies`)
      return Number(r.rows[0]!.n)
    })
    expect(stored).toBe(0)
  })

  it('stores bodies when the company switched that on', async () => {
    const accountId = await connectedMailbox(A.id)
    await sync(A.id, MAILBOX(), true)

    const inbox = await withTenant(A.id, async (tx) =>
      listEnvelopes(tx, { folderId: await folderByRole(tx, accountId, 'inbox') }))
    const opened = await withTenant(A.id, (tx) =>
      openMessage(tx, inbox.envelopes.find((e) => e.subject === 'Invoice 4471')!.id))
    expect(opened!.body_html).toContain('Payment due')
  })

  it('rebuilds a folder when the server renumbers it', async () => {
    await connectedMailbox(A.id)
    const first = MAILBOX()
    first.uidValidity = 1
    await sync(A.id, first)

    const renumbered = MAILBOX()
    renumbered.uidValidity = 2
    const second = await sync(A.id, renumbered)

    expect(second.rebuilt).toContain('INBOX')
    expect(second.messagesAdded).toBe(2)
  })

  it('does not rebuild when the mailbox is unchanged', async () => {
    await connectedMailbox(A.id)
    const mailbox = MAILBOX()
    await sync(A.id, mailbox)
    expect((await sync(A.id, mailbox)).rebuilt).toEqual([])
  })

  it('clears the failure counters after a good pass', async () => {
    await connectedMailbox(A.id)
    await withTenant(A.id, (tx) =>
      tx.query(`UPDATE mail_accounts SET consecutive_failures = 2, last_error = 'earlier'`))

    await sync(A.id, MAILBOX())

    const account = await withTenant(A.id, async (tx) => {
      const r = await tx.query<{ consecutive_failures: number; last_error: string | null }>(
        `SELECT consecutive_failures, last_error FROM mail_accounts`)
      return r.rows[0]!
    })
    expect(account).toMatchObject({ consecutive_failures: 0, last_error: null })
  })
})

describe('a mailbox that will not talk to us', () => {
  it('quarantines an account whose login is rejected', async () => {
    await connectedMailbox(A.id)
    const mailbox = MAILBOX()
    mailbox.failWith = new ImapError('AUTH_FAILED', 'Invalid credentials')

    const results = await syncTenant(A.id, {
      master: MASTER, storeBodies: false, connect: fakeConnection(mailbox),
    })
    expect(results[0]!.errors[0]).toMatch(/Invalid credentials/)

    const account = await withTenant(A.id, async (tx) => {
      const r = await tx.query<{ status: string; quarantined_until: string | null }>(
        `SELECT status, quarantined_until FROM mail_accounts`)
      return r.rows[0]!
    })
    expect(account.status).toBe('auth_failed')
    expect(account.quarantined_until).not.toBeNull()

    // and it is not hammered again on the next pass
    expect(await withTenant(A.id, (tx) => syncableAccounts(tx))).toHaveLength(0)
  })

  it('tolerates a transient failure twice before quarantining', async () => {
    await connectedMailbox(A.id)
    const mailbox = MAILBOX()
    mailbox.failWith = new ImapError('CONNECTION_FAILED', 'ECONNRESET')
    const opts = { master: MASTER, storeBodies: false, connect: fakeConnection(mailbox) }

    await syncTenant(A.id, opts)
    expect(await withTenant(A.id, (tx) => syncableAccounts(tx))).toHaveLength(1)

    await syncTenant(A.id, opts)
    await syncTenant(A.id, opts)
    expect(await withTenant(A.id, (tx) => syncableAccounts(tx))).toHaveLength(0)
  })

  it('never syncs an internal-only mailbox', async () => {
    await withTenant(A.id, (tx) =>
      ensureAccount(tx, { userId: ALICE, email: 'alice@acme.test', displayName: 'Alice' }))
    expect(await withTenant(A.id, (tx) => syncableAccounts(tx))).toHaveLength(0)
  })
})

describe('isolation', () => {
  it('syncs one company without touching another', async () => {
    await connectedMailbox(A.id)
    await syncTenant(A.id, {
      master: MASTER, storeBodies: false, connect: fakeConnection(MAILBOX()),
    })

    const inB = await withTenant(B.id, async (tx) => {
      const r = await tx.query<{ n: string }>(`SELECT count(*) AS n FROM mail_envelopes`)
      return Number(r.rows[0]!.n)
    })
    expect(inB).toBe(0)
  })
})
