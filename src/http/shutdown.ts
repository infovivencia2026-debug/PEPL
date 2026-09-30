/**
 * Stopping the HTTP server without cutting anyone off, and the timeouts it runs with.
 *
 * `systemctl restart` and every deploy send SIGTERM. Left to the default, the process ends
 * where it stands: a request that was approving a payroll or saving a document gets a reset
 * connection and cannot know whether it happened. The order here is the point:
 *
 *   1. stop accepting connections            (a new request goes to the instance that replaces us)
 *   2. let the requests already being served finish
 *   3. then release the database pools       (never before: a request still holds a connection)
 *   4. whatever is still open after the grace period is closed -- shutdown is bounded
 *
 * The event stream is deliberately not waited for. It is open for as long as a browser tab is,
 * so waiting would make every restart cost the full timeout; EventSource reconnects by itself
 * and replays from Last-Event-ID.
 */
import type { Server } from 'node:http'

export interface ShutdownOptions {
  /** How long in-flight requests get before their connections are closed. */
  timeoutMs: number
  /** Runs once the requests have drained (close pools, stop the relay). Errors are logged, not thrown. */
  onDrained?: () => Promise<void>
  log?: (message: string) => void
}

const STREAM_PATH = '/api/v1/events'

export function gracefulShutdown(server: Server, opts: ShutdownOptions): () => Promise<void> {
  const log = opts.log ?? (() => {})
  let inFlight = 0
  let idle: (() => void) | null = null
  let shuttingDown: Promise<void> | null = null

  // Count the requests being served. A stream is not "work": see the header.
  server.on('request', (req, res) => {
    if ((req.url ?? '').split('?')[0] === STREAM_PATH) return
    inFlight++
    let done = false
    const finished = (): void => {
      if (done) return
      done = true
      inFlight--
      if (inFlight === 0) idle?.()
    }
    res.on('finish', finished)
    res.on('close', finished)
  })

  return (): Promise<void> => {
    if (shuttingDown) return shuttingDown
    shuttingDown = new Promise<void>((resolve) => {
      log('shutting down: no longer accepting connections')
      const closed = new Promise<void>((r) => server.close(() => r()))
      server.closeIdleConnections()   // keep-alive sockets with nothing on them

      const drained = new Promise<void>((r) => {
        if (inFlight === 0) r()
        else idle = r
      })
      let timer: NodeJS.Timeout
      const timedOut = new Promise<'timeout'>((r) => { timer = setTimeout(() => r('timeout'), opts.timeoutMs) })

      void Promise.race([drained.then(() => 'drained' as const), timedOut]).then(async (outcome) => {
        clearTimeout(timer)
        if (outcome === 'timeout') log(`grace period of ${opts.timeoutMs}ms elapsed with ${inFlight} request(s) still open; closing them`)
        server.closeAllConnections()  // streams, stalled clients, anything left
        await closed
        try {
          await opts.onDrained?.()
        } catch (err) {
          log(`cleanup failed: ${(err as Error).message}`)
        }
        log('shutdown complete')
        resolve()
      })
    })
    return shuttingDown
  }
}

/**
 * Explicit timeouts. Node's defaults are generous and change between versions, and a public
 * server should not depend on them.
 */
export function applyServerTimeouts(server: Server): void {
  // Slow-header attacks (slowloris): a client that dribbles its headers holds a socket.
  server.headersTimeout = 15_000
  // The whole request must arrive within this. It bounds receiving, not responding, so a
  // long response or the event stream is unaffected.
  server.requestTimeout = 60_000
  // Must exceed the reverse proxy's idle timeout (~60s). If this side hung up first the proxy
  // would send the next request down a closed socket and answer 502.
  server.keepAliveTimeout = 65_000
}
