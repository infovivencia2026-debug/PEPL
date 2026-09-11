/**
 * IMAP IDLE: new mail appears when it lands, not on the next five-minute poll.
 *
 * One connection per watched mailbox, held open on INBOX. When the server
 * announces new mail the mailbox is synced through the same `syncAccount` the
 * poll uses — IDLE is only a faster trigger, never a second code path with its
 * own idea of the watermark. The poll keeps running underneath, so a mailbox
 * that is not watched (over the connection cap, or on a server without IDLE)
 * is merely slower, and a watcher that silently wedges is caught within one
 * poll interval.
 *
 * Bounded: `maxConnections` sockets across all tenants, oldest accounts first.
 * A socket per employee is fine at fifty and a problem at five thousand.
 */
import { withTenant } from '../db/tenant-tx.ts'
import { syncAccount, syncableAccounts, type AccountRow, type Connector, type SyncResult } from './sync.ts'
import { connectImap, ImapError, type Connection } from './imap.ts'
import { decryptSecret } from '../comms/index.ts'

export interface IdleOptions {
  master: string
  tenants: () => Promise<string[]>
  storeBodies: (tenantId: string) => Promise<boolean>
  connect?: Connector
  sync?: (tenantId: string, account: AccountRow, storeBodies: boolean) => Promise<SyncResult>
  maxConnections?: number
  /** How often the set of watched mailboxes is reconciled with the database. */
  refreshMs?: number
  /** RFC 2177 says re-issue IDLE at least every 29 minutes. */
  idleTimeoutMs?: number
  /** Reconnect backoff after a dropped connection; doubles up to 16x. */
  backoffMs?: number
  log?: (entry: Record<string, unknown>) => void
}

export interface IdleStatus {
  watching: number
  synced: number
  reconnects: number
}

interface Watcher {
  start: () => void
  stop: () => Promise<void>
}

export function startIdleWatchers(opts: IdleOptions): { stop: () => Promise<void>; status: () => IdleStatus } {
  const connect = opts.connect ?? connectImap
  const sync = opts.sync ?? ((tenantId, account, storeBodies) =>
    syncAccount(tenantId, account, { master: opts.master, storeBodies, connect }))
  const max = opts.maxConnections ?? 50
  const idleTimeout = opts.idleTimeoutMs ?? 29 * 60_000
  const backoff = opts.backoffMs ?? 5_000
  const log = opts.log ?? ((e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })))

  const watchers = new Map<string, Watcher>()   // key: `${tenantId}:${accountId}`
  const status: IdleStatus = { watching: 0, synced: 0, reconnects: 0 }
  let stopped = false

  const watch = (tenantId: string, account: AccountRow): Watcher => {
    let alive = true
    let connection: Connection | null = null
    let wake: (() => void) | null = null

    const sleep = (ms: number): Promise<void> => new Promise((r) => {
      const t = setTimeout(() => { wake = null; r() }, ms)
      wake = () => { clearTimeout(t); wake = null; r() }
    })

    const run = async (): Promise<void> => {
      let attempt = 0
      while (alive) {
        try {
          const password = decryptSecret(account.secret_ciphertext!, tenantId, opts.master)
          connection = await connect({
            host: account.imap_host!, port: account.imap_port ?? 993,
            secure: account.imap_secure ?? true, username: account.username ?? account.email, password,
          })
          if (!connection.waitForNewMail) {
            // A connection that cannot push has nothing to watch; the poll covers it.
            await connection.close()
            connection = null
            return
          }
          await connection.select('INBOX')
          attempt = 0
          while (alive) {
            const r = await connection.waitForNewMail(idleTimeout)
            if (!alive) break
            if (r === 'closed') throw new ImapError('CONNECTION_FAILED', 'IDLE connection closed')
            if (r === 'new') {
              const storeBodies = await opts.storeBodies(tenantId)
              const result = await sync(tenantId, account, storeBodies)
              status.synced += result.messagesAdded
              log({ level: 'info', msg: 'idle sync', account: account.email, added: result.messagesAdded })
            }
          }
        } catch (err) {
          if (!alive) break
          const e = err as ImapError
          if (e.code === 'AUTH_FAILED' || e.code === 'INSECURE_AUTH') {
            // Permanent. The poll's quarantine logic owns the account from here.
            log({ level: 'warn', msg: 'idle gave up', account: account.email, err: e.message })
            return
          }
          status.reconnects++
          const wait = backoff * Math.min(16, 2 ** attempt++)
          log({ level: 'warn', msg: 'idle reconnecting', account: account.email, inMs: wait, err: e.message })
          await sleep(wait)
        } finally {
          await connection?.close().catch(() => { /* already gone */ })
          connection = null
        }
      }
    }

    const key = `${tenantId}:${account.id}`
    let done: Promise<void> = Promise.resolve()
    const self: Watcher = {
      start() {
        done = run().finally(() => {
          if (watchers.get(key) === self) watchers.delete(key)
          status.watching = watchers.size
        })
      },
      async stop() {
        alive = false
        wake?.()
        await connection?.close().catch(() => { /* already gone */ })
        await done
      },
    }
    return self
  }

  const reconcile = async (): Promise<void> => {
    if (stopped) return
    const wanted = new Map<string, { tenantId: string; account: AccountRow }>()
    for (const tenantId of await opts.tenants()) {
      const accounts = await withTenant(tenantId, (tx) => syncableAccounts(tx))
      for (const account of accounts) wanted.set(`${tenantId}:${account.id}`, { tenantId, account })
    }
    // Drop watchers whose account disconnected or was quarantined.
    for (const [key, w] of watchers) {
      if (!wanted.has(key)) await w.stop()
    }
    // Add up to the cap, in the database's order (oldest accounts first).
    for (const [key, { tenantId, account }] of wanted) {
      if (watchers.size >= max) break
      if (watchers.has(key)) continue
      const w = watch(tenantId, account)
      watchers.set(key, w)
      w.start()
    }
    status.watching = watchers.size
  }

  const timer = setInterval(() => { void reconcile().catch((err) =>
    log({ level: 'error', msg: 'idle reconcile failed', err: (err as Error).message })) },
    opts.refreshMs ?? 5 * 60_000)
  const first = reconcile().catch((err) =>
    log({ level: 'error', msg: 'idle reconcile failed', err: (err as Error).message }))

  return {
    status: () => ({ ...status }),
    async stop() {
      stopped = true
      clearInterval(timer)
      await first
      await Promise.all([...watchers.values()].map((w) => w.stop()))
    },
  }
}
