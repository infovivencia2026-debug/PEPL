/**
 * A restart must not cut off the request it interrupts.
 *
 * The API had no signal handling: `systemctl restart pepl` killed the process where it
 * stood, so whoever was mid-request -- approving a payroll, uploading a document -- got a
 * reset connection and no way to know whether it had happened. It also set no server
 * timeouts of its own, and its unhandledRejection handler logged and carried on, so a bug
 * in our own code left the process running on whatever state it had corrupted. Found by an
 * audit; the shutdown logic is a function so it can be exercised without signals (Windows
 * cannot deliver SIGTERM to a child in a way a handler can catch).
 */
import { describe, it, expect } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'
import { gracefulShutdown, applyServerTimeouts } from '../src/http/shutdown.ts'
import { isFatalRejection } from '../src/http/process-guards.ts'

const listen = (server: Server): Promise<number> =>
  new Promise((r) => server.listen(0, '127.0.0.1', () => r((server.address() as AddressInfo).port)))

const get = (port: number, path = '/', agent = false): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, agent: agent ? undefined : false }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })

describe('graceful shutdown', () => {
  it('lets an in-flight request finish, then closes', async () => {
    const server = createServer((_req, res) => setTimeout(() => { res.writeHead(200); res.end('done') }, 300))
    const shutdown = gracefulShutdown(server, { timeoutMs: 5_000 })   // installed at startup, as server.ts does
    const port = await listen(server)
    const inFlight = get(port)
    await new Promise((r) => setTimeout(r, 50))               // the request has arrived and is being served

    const [response] = await Promise.all([inFlight, shutdown()])

    expect(response).toEqual({ status: 200, body: 'done' })   // NOT a reset connection
    expect(server.listening).toBe(false)
  })

  it('refuses new connections once it has started', async () => {
    const server = createServer((_req, res) => setTimeout(() => { res.writeHead(200); res.end('x') }, 300))
    const shutdown = gracefulShutdown(server, { timeoutMs: 5_000 })
    const port = await listen(server)
    const inFlight = get(port)
    await new Promise((r) => setTimeout(r, 50))

    const done = shutdown()
    await new Promise((r) => setTimeout(r, 20))
    await expect(get(port)).rejects.toThrow(/ECONNREFUSED/)
    await Promise.all([inFlight, done])
  })

  it('runs its cleanup (closing the database pools) after the requests drain, not before', async () => {
    const order: string[] = []
    const server = createServer((_req, res) => setTimeout(() => { order.push('request done'); res.writeHead(200); res.end('x') }, 200))
    const shutdown = gracefulShutdown(server, { timeoutMs: 5_000, onDrained: async () => { order.push('cleanup') } })
    const port = await listen(server)
    const inFlight = get(port)
    await new Promise((r) => setTimeout(r, 30))
    await Promise.all([inFlight, shutdown()])
    expect(order).toEqual(['request done', 'cleanup'])
  })

  it('does not wait forever for a connection that never finishes', async () => {
    // A stalled client, or a stream that never ends: shutdown has to be bounded.
    const server = createServer(() => { /* never responds */ })
    const shutdown = gracefulShutdown(server, { timeoutMs: 300 })
    const port = await listen(server)
    const socket = connect(port, '127.0.0.1')
    socket.on('error', () => {})
    socket.write('GET / HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise((r) => setTimeout(r, 50))

    const started = Date.now()
    await shutdown()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(server.listening).toBe(false)
    socket.destroy()
  })

  it('does not treat a long-lived event stream as work to wait for', async () => {
    // /api/v1/events is open for as long as a browser tab is. Waiting for it would make every
    // restart take the full timeout; browsers reconnect on their own.
    const server = createServer((req, res) => {
      if (req.url === '/api/v1/events') { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': hi\n\n'); return }
      res.writeHead(200); res.end('ok')
    })
    const shutdown = gracefulShutdown(server, { timeoutMs: 10_000 })
    const port = await listen(server)
    const stream = connect(port, '127.0.0.1')
    stream.on('error', () => {})
    stream.write('GET /api/v1/events HTTP/1.1\r\nHost: x\r\n\r\n')
    await new Promise((r) => setTimeout(r, 50))

    const started = Date.now()
    await shutdown()
    expect(Date.now() - started).toBeLessThan(1_500)
    stream.destroy()
  })

  it('is safe to call twice', async () => {
    const server = createServer((_r, res) => { res.writeHead(200); res.end() })
    await listen(server)
    const shutdown = gracefulShutdown(server, { timeoutMs: 1_000 })
    await Promise.all([shutdown(), shutdown()])
    await shutdown()
  })
})

describe('server timeouts', () => {
  it('are set explicitly, and the keep-alive outlives a reverse proxy\'s idle timeout', () => {
    const server = createServer()
    applyServerTimeouts(server)
    expect(server.headersTimeout).toBeGreaterThan(0)
    expect(server.headersTimeout).toBeLessThanOrEqual(30_000)      // slow-header attacks
    expect(server.requestTimeout).toBeGreaterThan(0)
    expect(server.requestTimeout).toBeLessThanOrEqual(120_000)
    // The proxy (OpenLiteSpeed / nginx) idles a connection at ~60s; if this server hung up first
    // the proxy would forward a request onto a closed socket and answer 502.
    expect(server.keepAliveTimeout).toBeGreaterThanOrEqual(65_000)
    expect(server.headersTimeout).toBeGreaterThan(0)
    server.close()
  })
})

describe('an unhandled rejection', () => {
  it('is fatal when it is our own bug, and survivable when it is a network or mail fault', () => {
    expect(isFatalRejection(new Error('cannot read properties of undefined'))).toBe(true)
    expect(isFatalRejection('a string')).toBe(true)
    expect(isFatalRejection(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))).toBe(false)
    expect(isFatalRejection(Object.assign(new Error('x'), { stack: 'Error: x\n    at file:///app/src/mail/imap.ts:10:1' }))).toBe(false)
  })
})

describe('server.ts wiring', () => {
  // server.ts starts listening at import, so it cannot be imported by a test (see CLAUDE.md).
  // The logic above is exercised directly; this pins that the entry point actually uses it,
  // and installs it BEFORE listen() so the first request is counted.
  it('applies the timeouts and handles SIGTERM and SIGINT before it listens', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/http/server.ts', 'utf8')
    const listenAt = src.indexOf('server.listen(')
    expect(listenAt).toBeGreaterThan(-1)
    for (const needle of ['applyServerTimeouts(server)', 'gracefulShutdown(server', "'SIGTERM'", "'SIGINT'", 'closePools()', 'relay.stop()']) {
      const at = src.indexOf(needle)
      expect(at, needle).toBeGreaterThan(-1)
      expect(at, `${needle} must come before listen()`).toBeLessThan(listenAt)
    }
  })
})
