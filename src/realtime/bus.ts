/**
 * The event bus behind live updates.
 *
 * Delivery is in-process: a subscriber is a live SSE connection on THIS
 * instance. What makes a second instance see the same events is the relay in
 * `relay.ts`, which forwards every published event through Postgres
 * LISTEN/NOTIFY and feeds the ones from elsewhere back in through `deliver`.
 * The bus itself never imports pg, so it stays testable without a database.
 *
 * Two rules hold the guarantees the rest of the system depends on:
 *
 *   1. An event is published AFTER the transaction commits. Telling a browser
 *      about a message that then rolls back is worse than telling it late.
 *   2. An event never crosses a tenant. Subscribers are keyed by tenant, and
 *      the tenant comes from the session, never from the client.
 */

export interface PeplEvent {
  /** e.g. 'chat.message', 'notification.created', 'approval.raised' */
  type: string
  /** Narrows delivery to these users. Omitted means everyone in the tenant. */
  userIds?: readonly string[]
  /** Small: an id and enough to update a badge. The client refetches detail. */
  data: Record<string, unknown>
}

export interface DeliveredEvent extends PeplEvent {
  id: number
  at: string
}

type Listener = (event: DeliveredEvent) => void

interface Subscriber {
  userId: string
  listener: Listener
}

/**
 * Recent events per tenant, for reconnect replay.
 *
 * A browser that loses its connection sends Last-Event-ID and expects what it
 * missed. Without this, every network blip silently drops messages and the only
 * symptom is a chat that is occasionally, unreproducibly wrong.
 */
const REPLAY_LIMIT = 200

const subscribers = new Map<string, Set<Subscriber>>()
const history = new Map<string, DeliveredEvent[]>()

/**
 * Event ids are milliseconds-since-epoch, bumped by one when two land in the
 * same millisecond. That keeps them monotonic on one instance AND comparable
 * across instances, so a browser that reconnects to a different instance can
 * still say "everything after this one" and get a sensible answer.
 */
let nextId = 1
function allocateId(): number {
  const id = Math.max(nextId, Date.now())
  nextId = id + 1
  return id
}

type Relay = (tenantId: string, event: DeliveredEvent) => void
let relay: Relay | null = null

/** Installed by relay.ts; called once per locally published event. */
export function setRelay(fn: Relay | null): void {
  relay = fn
}

/**
 * Hands an already-stamped event to this instance's subscribers and its
 * replay ring. Used for local publishes and for events arriving from another
 * instance, which keep the id they were given there.
 */
export function deliver(tenantId: string, delivered: DeliveredEvent): number {
  if (!tenantId) throw new Error('deliver: tenantId is required')
  if (delivered.id >= nextId) nextId = delivered.id + 1

  const ring = history.get(tenantId) ?? []
  ring.push(delivered)
  if (ring.length > REPLAY_LIMIT) ring.splice(0, ring.length - REPLAY_LIMIT)
  history.set(tenantId, ring)

  let sent = 0
  for (const sub of subscribers.get(tenantId) ?? []) {
    if (delivered.userIds && !delivered.userIds.includes(sub.userId)) continue
    try {
      sub.listener(delivered)
      sent++
    } catch {
      // A broken pipe on one connection must not stop delivery to the rest.
    }
  }
  return sent
}

/** Publishes to one tenant. Returns how many LOCAL connections received it. */
export function publish(tenantId: string, event: PeplEvent): number {
  if (!tenantId) throw new Error('publish: tenantId is required')
  const delivered: DeliveredEvent = { ...event, id: allocateId(), at: new Date().toISOString() }
  const sent = deliver(tenantId, delivered)
  relay?.(tenantId, delivered)
  return sent
}

/** Subscribes one connection. Call the returned function to detach. */
export function subscribe(
  tenantId: string,
  userId: string,
  listener: Listener,
): () => void {
  const set = subscribers.get(tenantId) ?? new Set<Subscriber>()
  const sub: Subscriber = { userId, listener }
  set.add(sub)
  subscribers.set(tenantId, set)

  return () => {
    set.delete(sub)
    if (set.size === 0) subscribers.delete(tenantId)
  }
}

/** Events this user missed since `afterId`, oldest first. */
export function replay(tenantId: string, userId: string, afterId: number): DeliveredEvent[] {
  return (history.get(tenantId) ?? []).filter(
    (e) => e.id > afterId && (!e.userIds || e.userIds.includes(userId)),
  )
}

/** Live connection count, for the health endpoint and for tests. */
export function connectionCount(tenantId?: string): number {
  if (tenantId) return subscribers.get(tenantId)?.size ?? 0
  let total = 0
  for (const set of subscribers.values()) total += set.size
  return total
}

/** Test seam: forget every subscriber and every replayable event. */
export function resetBus(): void {
  subscribers.clear()
  history.clear()
  nextId = 1
}
