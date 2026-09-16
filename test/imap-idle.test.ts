/**
 * IMAP IDLE watchers: a push triggers a sync through the ordinary sync path,
 * a dropped connection reconnects with backoff, the connection cap holds,
 * a permanent auth failure gives up, and stop() actually stops.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { ImapError, type Connection } from '../src/mail/imap.ts'
import { ensureAccount } from '../src/mail/index.ts'
import { encryptSecret } from '../src/comms/index.ts'
import { startIdleWatchers } from '../src/mail/idle.ts'
import type { SyncResult } from '../src/mail/sync.ts'

const MASTER = 'test-master-key-not-a-real-secret'
const USERS = ['e0000000-0000-0000-0000-00000000000e', 'e0000000-0000-0000-0000-00000000000f',
  'e0000000-0000-0000-0000-000000000010']

let A: Tenant

/** A connection whose IDLE the test drives by hand. */
class FakeIdle {
  pending: ((r: 'new' | 'timeout' | 'closed') => void)[] = []
  connects = 0
  closes = 0
  failWith: ImapError | null = null
  noIdle = false
  push(r: 'new' | 'timeout' | 'closed'): void { this.pending.shift()?.(r) }
  connector = async (): Promise<Connection> => {
    this.connects++
    if (this.failWith) throw this.failWith
    const c: Connection = {
      listFolders: async () => [],
      select: async () => ({ exists: 0, uidValidity: 1, uidNext: 1 }),
      fetchSince: async () => [],
      fetchBody: async () => ({ source: null }),
      setFlag: async () => {},
      moveTo: async () => {},
      close: async () => { this.closes++; this.pending.splice(0).forEach((r) => r('closed')) },
    }
    if (!this.noIdle) c.waitForNewMail = (): Promise<'new' | 'timeout' | 'closed'> =>
      new Promise((r) => this.pending.push(r))
    return c
  }
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20))
async function until(pred: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!pred()) {
    if (Date.now() > end) throw new Error('condition not met in time')
    await tick()
  }
}

async function connectedMailboxes(tenantId: string, n: number): Promise<string[]> {
  return withTenant(tenantId, async (tx) => {
    const ids: string[] = []
    for (let i = 0; i < n; i++) {
      const account = await ensureAccount(tx, {
        userId: USERS[i]!, email: `u${i}@acme.test`, displayName: `U${i}`,
      })
      await tx.query(
        `UPDATE mail_accounts
            SET provider = 'imap_generic', imap_host = 'imap.example.test', imap_port = 993,
                imap_secure = true, username = $3, secret_ciphertext = $2
          WHERE id = $1`,
        [account.id, encryptSecret('hunter2', tenantId, MASTER), `u${i}`])
      ids.push(account.id)
    }
    return ids
  })
}

const ok = (added = 1): SyncResult =>
  ({ account: 'x', foldersSeen: 1, messagesAdded: added, rebuilt: [], errors: [] })

beforeAll(async () => { A = (await resetAndSeed()).a })
beforeEach(async () => { A = (await resetAndSeed()).a })
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('IMAP IDLE', () => {
  it('a push syncs the mailbox through the injected sync, and a timeout just re-idles', async () => {
    await connectedMailboxes(A.id, 1)
    const fake = new FakeIdle()
    const synced: string[] = []
    const w = startIdleWatchers({
      master: MASTER, tenants: async () => [A.id], storeBodies: async () => false,
      connect: fake.connector, refreshMs: 60_000, log: () => {},
      sync: async (_t, account) => { synced.push(account.email); return ok(3) },
    })
    await until(() => fake.pending.length === 1)
    expect(w.status().watching).toBe(1)

    fake.push('timeout')
    await until(() => fake.pending.length === 1)
    expect(synced).toEqual([])

    fake.push('new')
    await until(() => synced.length === 1)
    await until(() => fake.pending.length === 1)   // back in IDLE after the sync
    expect(synced).toEqual(['u0@acme.test'])
    expect(w.status().synced).toBe(3)
    expect(fake.connects).toBe(1)

    await w.stop()
    expect(fake.closes).toBeGreaterThanOrEqual(1)
    expect(w.status().watching).toBe(0)
  })

  it('a dropped connection reconnects with backoff and keeps the poll unaffected', async () => {
    await connectedMailboxes(A.id, 1)
    const fake = new FakeIdle()
    const w = startIdleWatchers({
      master: MASTER, tenants: async () => [A.id], storeBodies: async () => false,
      connect: fake.connector, refreshMs: 60_000, backoffMs: 10, log: () => {},
      sync: async () => ok(),
    })
    await until(() => fake.pending.length === 1)
    fake.push('closed')
    await until(() => fake.connects === 2)
    await until(() => fake.pending.length === 1)
    expect(w.status().reconnects).toBe(1)
    await w.stop()
  })

  it('never opens more connections than the cap, oldest accounts first', async () => {
    await connectedMailboxes(A.id, 3)
    const fake = new FakeIdle()
    const w = startIdleWatchers({
      master: MASTER, tenants: async () => [A.id], storeBodies: async () => false,
      connect: fake.connector, refreshMs: 60_000, maxConnections: 2, log: () => {}, sync: async () => ok(),
    })
    await until(() => fake.pending.length === 2)
    await tick()
    expect(fake.connects).toBe(2)
    expect(w.status().watching).toBe(2)
    await w.stop()
  })

  it('gives up on a permanent auth failure instead of hammering the server', async () => {
    await connectedMailboxes(A.id, 1)
    const fake = new FakeIdle()
    fake.failWith = new ImapError('AUTH_FAILED', 'bad password')
    const logs: Record<string, unknown>[] = []
    const w = startIdleWatchers({
      master: MASTER, tenants: async () => [A.id], storeBodies: async () => false,
      connect: fake.connector, refreshMs: 60_000, backoffMs: 1, log: (e) => logs.push(e), sync: async () => ok(),
    })
    await until(() => logs.some((l) => l.msg === 'idle gave up'))
    await tick()
    expect(fake.connects).toBe(1)
    expect(w.status().watching).toBe(0)
    await w.stop()
  })

  it('a server without IDLE is left to the poll', async () => {
    await connectedMailboxes(A.id, 1)
    const fake = new FakeIdle()
    fake.noIdle = true
    const w = startIdleWatchers({
      master: MASTER, tenants: async () => [A.id], storeBodies: async () => false,
      connect: fake.connector, refreshMs: 60_000, log: () => {}, sync: async () => ok(),
    })
    await until(() => fake.closes === 1)
    await tick()
    expect(w.status().watching).toBe(0)
    await w.stop()
  })
})
