/**
 * Server-sent events.
 *
 * SSE rather than WebSocket: everything here travels server → client, EventSource
 * reconnects by itself with Last-Event-ID replay built into the protocol, and it
 * is ordinary HTTP, so proxies, cookies and the existing session handling all
 * work unchanged. A WebSocket would add a second auth path and a reconnect loop
 * to write and get wrong.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { resolveSession } from '../auth/index.ts'
import { replay, subscribe, type DeliveredEvent } from './bus.ts'

/**
 * Below any common proxy idle timeout (nginx and most load balancers default to
 * 60s), so a quiet connection is kept alive rather than silently reaped.
 */
const HEARTBEAT_MS = 25_000

/** How long a client should wait before reconnecting, per the SSE protocol. */
const RETRY_MS = 3_000

function token(req: IncomingMessage): string | null {
  const header = req.headers.authorization
  if (header?.startsWith('Bearer ')) return header.slice(7).trim()
  // EventSource cannot set headers, so a browser connection authenticates with
  // the session cookie it already has.
  const cookie = req.headers.cookie
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('pepl_session='))
    ?.slice('pepl_session='.length)
  return cookie && /^[A-Za-z0-9_-]+$/.test(cookie) ? cookie : null
}

function frame(event: DeliveredEvent): string {
  return `id: ${event.id}\nevent: ${event.type}\n` +
         `data: ${JSON.stringify({ ...event.data, at: event.at })}\n\n`
}

/**
 * Handles `GET /api/v1/events`.
 *
 * Returns true when it took the request, so the caller can fall through to the
 * JSON router for everything else.
 */
export async function handleEvents(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const raw = token(req)
  if (!raw) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: { code: 'MISSING_TOKEN', message: 'a session is required for the event stream' },
    }))
    return
  }

  let session: Awaited<ReturnType<typeof resolveSession>>
  try {
    session = await resolveSession(raw)
  } catch {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      error: { code: 'INVALID_SESSION', message: 'that session is not valid' },
    }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Nginx buffers proxied responses by default, which holds every event until
    // the buffer fills — for a live stream that is indistinguishable from broken.
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
  })
  res.write(`retry: ${RETRY_MS}\n\n`)

  // Replay what this connection missed while it was away.
  const lastSeen = Number(
    req.headers['last-event-id'] ??
    new URL(req.url ?? '/', 'http://localhost').searchParams.get('lastEventId') ??
    0,
  )
  if (Number.isFinite(lastSeen) && lastSeen > 0) {
    for (const missed of replay(session.tenantId, session.userId, lastSeen)) {
      res.write(frame(missed))
    }
  }

  const unsubscribe = subscribe(session.tenantId, session.userId, (event) => {
    res.write(frame(event))
  })

  // A comment line is a valid heartbeat: it keeps the socket warm and is ignored
  // by EventSource, so it never reaches application code.
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS)
  heartbeat.unref?.()

  const close = () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  }
  req.on('close', close)
  req.on('error', close)
}
