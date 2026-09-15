/**
 * Live events across instances, through Postgres.
 *
 * Two API processes behind a load balancer each hold their own SSE
 * connections. Without this, a chat message handled by instance A reaches
 * only the browsers connected to A, and the rest find out on refresh. Every
 * publish is therefore also `pg_notify`'d on one channel, and every instance
 * holds one dedicated connection that LISTENs and feeds foreign events into
 * its own bus. No Redis, no new secret: the database is already the one thing
 * every instance can reach.
 *
 * The payload is tagged with the origin instance so an event is not delivered
 * twice on the instance that published it. Tenant isolation is preserved
 * because the payload carries the tenant id and `deliver` is keyed by it — a
 * browser on instance B still only receives its own tenant's stream.
 */
import { randomUUID } from 'node:crypto'
import type { Pool, PoolClient } from 'pg'
import { deliver, setRelay, type DeliveredEvent } from './bus.ts'

const log = (entry: Record<string, unknown>): void =>
  console.log(JSON.stringify({ t: new Date().toISOString(), ...entry }))

export const CHANNEL = 'pepl_events'
/** pg_notify payloads are capped at 8000 bytes; events are meant to be small. */
const MAX_PAYLOAD = 7900
const RECONNECT_MS = 2_000

export const INSTANCE_ID: string = randomUUID()

interface Envelope {
  origin: string
  tenantId: string
  event: DeliveredEvent
}

export function encode(tenantId: string, event: DeliveredEvent, origin = INSTANCE_ID): string | null {
  const payload = JSON.stringify({ origin, tenantId, event } satisfies Envelope)
  if (Buffer.byteLength(payload) > MAX_PAYLOAD) return null
  return payload
}

/** Parses one notification. Returns null for anything malformed or our own. */
export function decode(payload: string, self = INSTANCE_ID): Envelope | null {
  try {
    const env = JSON.parse(payload) as Partial<Envelope>
    if (!env || env.origin === self) return null
    if (typeof env.tenantId !== 'string' || !env.tenantId) return null
    const ev = env.event
    if (!ev || typeof ev.type !== 'string' || typeof ev.id !== 'number' || typeof ev.at !== 'string') return null
    return { origin: String(env.origin), tenantId: env.tenantId, event: ev }
  } catch {
    return null
  }
}

/**
 * Starts forwarding local publishes and listening for foreign ones.
 * Returns a stop function. Safe to call in the scheduler too: a job that
 * publishes (mail sync, approvals) reaches browsers on every instance.
 */
export function startRelay(pool: Pool): { stop: () => Promise<void> } {
  let stopped = false
  let listener: PoolClient | null = null

  setRelay((tenantId, event) => {
    const payload = encode(tenantId, event)
    if (!payload) {
      log({ level: 'warn', msg: 'realtime relay: event too large to forward', type: event.type })
      return
    }
    pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch((err: Error) => {
      log({ level: 'warn', msg: 'realtime relay: notify failed', err: err.message })
    })
  })

  const listen = async (): Promise<void> => {
    if (stopped) return
    try {
      const client = await pool.connect()
      listener = client
      client.on('notification', (n) => {
        if (n.channel !== CHANNEL || !n.payload) return
        const env = decode(n.payload)
        if (env) deliver(env.tenantId, env.event)
      })
      client.on('error', (err: Error) => {
        log({ level: 'warn', msg: 'realtime relay: listener lost', err: err.message })
        client.release(err)
        listener = null
        if (!stopped) setTimeout(listen, RECONNECT_MS).unref()
      })
      await client.query(`LISTEN ${CHANNEL}`)
      log({ level: 'info', msg: 'realtime relay listening', channel: CHANNEL, instance: INSTANCE_ID })
    } catch (err) {
      log({ level: 'warn', msg: 'realtime relay: cannot listen yet', err: (err as Error).message })
      if (!stopped) setTimeout(listen, RECONNECT_MS).unref()
    }
  }
  void listen()

  return {
    stop: async () => {
      stopped = true
      setRelay(null)
      const client = listener
      listener = null
      if (client) {
        try { await client.query(`UNLISTEN ${CHANNEL}`) } catch { /* connection may be gone */ }
        client.release()
      }
    },
  }
}
