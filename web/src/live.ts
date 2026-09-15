/// <reference lib="dom" />
/**
 * The live connection.
 *
 * One EventSource for the whole app, shared by every screen. Opening one per
 * component would burn a server connection each — browsers allow six per origin,
 * and a chat screen plus a mail screen plus a notification bell would exhaust
 * them and quietly stall ordinary requests.
 *
 * EventSource handles reconnection and Last-Event-ID by itself; the server
 * replays what was missed. There is nothing to retry here by hand.
 */

export type LiveEvent = {
  type: string
  data: Record<string, unknown>
}

type Handler = (event: LiveEvent) => void

const handlers = new Map<string, Set<Handler>>()
let source: EventSource | null = null

/** Event types the server publishes. Subscribe with `on(type, fn)`. */
export const LIVE_EVENTS = [
  'chat.message',
  'chat.conversation',
  'mail.delivered',
  'mail.received',
  'approval.decided',
  'announcement.published',
] as const

function ensureConnected(): void {
  if (source) return
  // Same-origin, so the session cookie authenticates it — EventSource cannot
  // set an Authorization header.
  source = new EventSource('/api/v1/events', { withCredentials: true })

  for (const type of LIVE_EVENTS) {
    source.addEventListener(type, (e) => {
      const raw = (e as MessageEvent).data
      let data: Record<string, unknown> = {}
      try {
        data = JSON.parse(raw)
      } catch {
        return // a frame we cannot read is not worth crashing a screen over
      }
      for (const handler of handlers.get(type) ?? []) handler({ type, data })
    })
  }
}

/**
 * Subscribes to one event type. Returns an unsubscribe function — call it from
 * a `useEffect` cleanup, or the handler outlives the screen that made it.
 */
export function on(type: string, handler: Handler): () => void {
  ensureConnected()
  const set = handlers.get(type) ?? new Set<Handler>()
  set.add(handler)
  handlers.set(type, set)

  return () => {
    set.delete(handler)
    if (set.size === 0) handlers.delete(type)
    if (handlers.size === 0) disconnect()
  }
}

/** Closes the connection. Called automatically when the last handler detaches. */
export function disconnect(): void {
  source?.close()
  source = null
}

/** True while the stream is open. For a "reconnecting…" indicator. */
export function isConnected(): boolean {
  return source?.readyState === EventSource.OPEN
}
