import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { createHandler } from './router.ts'
import { buildUiRouter } from './ui-routes.ts'
import { router } from './routes.ts'
import { handleEvents } from '../realtime/sse.ts'
import { installProcessGuards } from './process-guards.ts'
import { handleMetrics } from './metrics-endpoint.ts'
import { startRelay } from '../realtime/relay.ts'
import { appPool, closePools } from '../db/pool.ts'
import { applyServerTimeouts, gracefulShutdown } from './shutdown.ts'
import { preflight } from './preflight.ts'
import { originAllowed } from './origin.ts'

installProcessGuards()
// Live events reach browsers on every instance, not just the one that handled the request.
const relay = startRelay(appPool)

const handler = createHandler(buildUiRouter())
const domainHandler = createHandler(router)
const root = resolve('dist')
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}
const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'same-origin')
  res.setHeader('X-Frame-Options', 'DENY')
  // Only behind a proxy that terminated TLS, and only in production. Sent from
  // a plain-HTTP dev box it would pin localhost to https in the developer's
  // browser for a year, which is a genuinely annoying thing to undo.
  //
  // The proxy already answers 308 to plain HTTP; this closes the gap that a
  // redirect cannot -- the FIRST request of a session, which is still sent in
  // clear text and is therefore still interceptable. No `preload`: that is a
  // one-way door for the whole domain and onrol.in has thirteen other
  // applications on it.
  if (process.env.NODE_ENV === 'production' &&
      (req.headers['x-forwarded-proto'] === 'https' ||
       process.env.PEPL_PUBLIC_URL?.startsWith('https://'))) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
  if (req.url === '/metrics') {
    handleMetrics(req, res)
    return
  }
  // Both probes: /health (liveness) and /health/ready (readiness). The
  // container HEALTHCHECK uses the second; an exact match here once sent it to
  // the static handler and every container reported unhealthy.
  if (req.url === '/health' || req.url?.startsWith('/health/')) {
    await domainHandler(req, res)
    return
  }
  // The event stream is long-lived, so it is handled before the JSON router,
  // which assumes one response and ends it.
  if (req.url?.split('?')[0] === '/api/v1/events') {
    await handleEvents(req, res)
    return
  }
  if (req.url?.startsWith('/api/')) {
    if (!['GET', 'HEAD'].includes(req.method ?? 'GET')) {
      if (!originAllowed(req.headers.origin, req.headers)) {
        res.writeHead(403, { 'Content-Type': 'application/json' })
        res.end(
          JSON.stringify({
            error: { message: 'Request origin is not allowed' },
          }),
        )
        return
      }
      if (!req.headers['content-type']?.startsWith('application/json')) {
        res.writeHead(415)
        res.end(JSON.stringify({ error: { message: 'Use application/json' } }))
        return
      }
    }
    if (!req.headers.authorization) {
      const token = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('pepl_session='))
        ?.slice(13)
      if (token && /^[A-Za-z0-9_-]+$/.test(token))
        req.headers.authorization = `Bearer ${token}`
    }
    await (req.url.startsWith('/api/ui/') ? handler : domainHandler)(req, res)
    return
  }
  try {
    const pathname = decodeURIComponent(
      new URL(req.url ?? '/', 'http://localhost').pathname,
    )
    let path = resolve(root, `.${pathname}`)
    if (!path.startsWith(root + sep) && path !== root) {
      res.writeHead(404)
      res.end()
      return
    }
    if (!extname(path)) path = resolve(root, pathname === '/admin' || pathname.startsWith('/admin/') ? 'admin.html' : 'index.html')
    const body = await readFile(path)
    res.writeHead(200, {
      'Content-Type': mime[extname(path)] ?? 'application/octet-stream',
      'Cache-Control':
        extname(path) === '.html' ? 'no-cache' : 'public, max-age=3600',
    })
    res.end(body)
  } catch {
    res.writeHead(404)
    res.end('Page not found. Run npm run build to build the frontend.')
  }
})
applyServerTimeouts(server)

// SIGTERM is what `systemctl restart` and every deploy send. Without a handler the process
// ended where it stood and cut off whoever was mid-request. Installed BEFORE listen(), so every
// request is counted from the first one.
const shutdown = gracefulShutdown(server, {
  timeoutMs: 15_000,
  log: (message) => console.log(JSON.stringify({ t: new Date().toISOString(), level: 'info', msg: message })),
  onDrained: async () => {
    await relay.stop()
    await closePools()
  },
})
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown().then(() => process.exit(0)))
}

// Before the socket opens, not after: a server that has already accepted a
// request has already acted on whatever is misconfigured. In production this
// refuses to continue on a development password or a test database; elsewhere
// it says nothing at all.
preflight()

// 127.0.0.1 on purpose. In production a reverse proxy terminates TLS and
// forwards here, so binding the interface would publish an unencrypted API.
const port = Number(process.env.PORT ?? 3100)
server.listen(port, '127.0.0.1', () =>
  // The port, not a hardcoded one: deploy output that says 3100 while the
  // process listens on 4010 sends whoever reads it to the wrong place.
  console.log(`PEPL API + app: http://127.0.0.1:${port}`),
)
