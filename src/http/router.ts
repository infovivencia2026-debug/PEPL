/**
 * A small HTTP router over node:http.
 *
 * No framework: routing, JSON handling and error mapping are ~150 lines, and a
 * dependency here would be one more thing to audit in a product that holds
 * payroll data.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PUBLIC_LIMIT, RateLimiter, SESSION_LIMIT, sessionKey, type Limit } from './rate-limit.ts'
import { httpDuration, httpRequests, rateLimited } from '../lib/metrics.ts'

export type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'

export interface Req {
  method: Method
  path: string
  params: Record<string, string>
  query: URLSearchParams
  body: unknown
  headers: IncomingMessage['headers']
  ip?: string
}

export interface Res {
  status: number
  body: unknown
  headers?: Record<string, string>
}

export type Handler = (req: Req) => Promise<Res> | Res

interface Route {
  method: Method
  segments: string[]
  handler: Handler
  /** Documented for the OpenAPI spec. */
  meta: RouteMeta
}

export interface RouteMeta {
  summary: string
  tag: string
  permission?: string
  /** Endpoints reachable without a session. */
  public?: boolean
  requestExample?: Record<string, unknown>
}

export class HttpError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: unknown
  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
    this.name = 'HttpError'
  }
}

/**
 * Maps a domain error code to a status. Domain modules throw typed errors with
 * stable codes; the transport decides the number. A code the client can switch
 * on matters more than the status — "something went wrong" is unactionable and
 * unsupportable.
 */
const STATUS_BY_CODE: Record<string, number> = {
  NO_TENANT_CONTEXT: 500,
  INVALID_CREDENTIALS: 401,
  INVALID_SESSION: 401,
  ACCOUNT_LOCKED: 429,
  PASSWORD_TOO_SHORT: 400,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  RECORD_NOT_FOUND: 404,
  UNKNOWN_CONFIG_KEY: 404,
  UNKNOWN_PERMISSION: 422,
  NO_STATUTORY_CONFIG: 409,
  MODULE_NOT_AVAILABLE: 403,
  EMPLOYEE_LIMIT_REACHED: 403,
  NO_EMPLOYEE_RECORD: 422,
  LOCATION_REQUIRED: 422,
  CATEGORY_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  PERIOD_NOT_FOUND: 404,
  // conflicts with the state of the world, not with the request
  PERIOD_CLOSED: 409,
  PERIOD_FROZEN_NO_TARGET: 409,
  CONFIG_LOCKED_PERIOD: 409,
  RUN_NOT_DRAFT: 409,
  INPUTS_NOT_FROZEN: 409,
  NOT_CALCULATED: 409,
  NOT_VALIDATED: 409,
  NOT_APPROVED: 409,
  NOT_LOCKED: 409,
  CANNOT_UNFREEZE: 409,
  PERIOD_OPEN: 409,
  ALREADY_PUBLISHED: 409,
  SEPARATION_OF_DUTY: 409,
  INSUFFICIENT_BALANCE: 409,
  ASSIGNMENT_NOT_AFTER_CURRENT: 409,
  COMPENSATION_NOT_AFTER_CURRENT: 409,
  // the request itself is wrong
  CONFIG_INVALID_VALUE: 422,
  CONFIG_EFFECTIVE_DATE_REQUIRED: 422,
  CONFIG_REASON_REQUIRED: 422,
  CONFIG_NOT_SCOPABLE: 422,
  CORRECTION_REASON_REQUIRED: 422,
  REVISION_REASON_REQUIRED: 422,
  REASON_REQUIRED: 422,
  UNKNOWN_ACTION: 422,
  INVALID_DAYS: 422,
  INVALID_AMOUNT: 422,
  NOT_IN_AUDIENCE: 403,
  NOT_A_PARTICIPANT: 403,
  NOT_APPROVER: 403,
  NOT_REQUESTER: 403,
  TEMPLATE_EMPTY: 422,
  VALIDATION_FAILED: 422,
  CORRECTION_WINDOW_CLOSED: 409,
  REMOTE_NOT_ALLOWED: 403,
  LEAVE_UNIT_NOT_ALLOWED: 422,
  LEAVE_DAYS_MISMATCH: 422,
  HOLIDAY_EXISTS: 409,
  LEAVE_TYPE_EXISTS: 409,
  LEAVE_TYPE_RETIRED: 409,
  POLICY_NOT_BACKDATABLE: 422,
  DECLARATION_NOT_EDITABLE: 409,
  DECLARATION_NOT_SUBMITTED: 409,
  INVALID_LEAVE_CODE: 422,
  RUN_NOT_LOCKED: 409,
  MISSING_BANK_DETAILS: 422,
  NOT_READY: 503,
  RATE_LIMITED: 429,
  // documents
  FILE_TOO_LARGE: 413,
  EMPTY_FILE: 422,
  INVALID_FILE_NAME: 422,
  CONTENT_MISSING: 500,
  // chat
  CONVERSATION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  CONVERSATION_READONLY: 409,
  NO_PARTICIPANTS: 422,
  // mail
  MAILBOX_NOT_FOUND: 404,
  FOLDER_NOT_FOUND: 404,
  NOT_A_DRAFT: 409,
  NO_RECIPIENTS: 422,
  // import
  IMPORT_INVALID: 422,
}

export class Router {
  private routes: Route[] = []

  add(method: Method, pattern: string, meta: RouteMeta, handler: Handler): this {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler, meta })
    return this
  }

  get(p: string, m: RouteMeta, h: Handler): this { return this.add('GET', p, m, h) }
  post(p: string, m: RouteMeta, h: Handler): this { return this.add('POST', p, m, h) }
  patch(p: string, m: RouteMeta, h: Handler): this { return this.add('PATCH', p, m, h) }
  del(p: string, m: RouteMeta, h: Handler): this { return this.add('DELETE', p, m, h) }

  list(): { method: Method; path: string; meta: RouteMeta }[] {
    return this.routes.map((r) => ({
      method: r.method,
      path: '/' + r.segments.join('/'),
      meta: r.meta,
    }))
  }

  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean)
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!
        const part = parts[i]!
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part)
        else if (seg !== part) { ok = false; break }
      }
      if (ok) return { route, params }
    }
    return undefined
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 5_000_000) throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'request body exceeds 5MB')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw.trim()) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'request body is not valid JSON')
  }
}

export interface HandlerOptions {
  /** Override the defaults; tests set these low to exercise the 429 path. */
  publicLimit?: Limit
  sessionLimit?: Limit
}

export function createHandler(router: Router, options: HandlerOptions = {}) {
  const publicLimiter = new RateLimiter(options.publicLimit ?? PUBLIC_LIMIT)
  const sessionLimiter = new RateLimiter(options.sessionLimit ?? SESSION_LIMIT)

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const started = Date.now()
    const requestId = crypto.randomUUID()

    // The route PATTERN (`/api/v1/employees/:id`), so ids never become label values.
    let routeLabel = 'unmatched'

    const send = (status: number, body: unknown, headers: Record<string, string> = {}): void => {
      const payload = JSON.stringify(body ?? null)
      const labels = { method: req.method ?? 'GET', route: routeLabel, status: `${Math.floor(status / 100)}xx` }
      httpRequests.inc(labels)
      httpDuration.observe({ method: labels.method, route: routeLabel }, (Date.now() - started) / 1000)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'x-request-id': requestId,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        ...headers,
      })
      res.end(payload)
    }

    // Rate limits, before any work is done on the request. Public routes are
    // limited per IP — the per-email lockout stops a brute force against one
    // account and does nothing against a spray across five hundred. Everything
    // with a session is limited per session, so a leaked token degrades to 429s
    // rather than taking the database with it. Probes and the event stream are
    // exempt: a balancer polling readiness must never be told to back off.
    if (!url.pathname.startsWith('/health') && url.pathname !== '/api/v1/events') {
      const auth = req.headers.authorization
      const token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : null
      const verdict = token
        ? sessionLimiter.check(sessionKey(token))
        : publicLimiter.check(`ip:${req.socket.remoteAddress ?? 'unknown'}`)
      if (!verdict.allowed) {
        rateLimited.inc({ limiter: token ? 'session' : 'public' })
        send(429, {
          error: {
            code: 'RATE_LIMITED',
            message: `too many requests; try again in ${verdict.retryAfterSeconds} second(s)`,
            requestId,
          },
        }, { 'retry-after': String(verdict.retryAfterSeconds) })
        return
      }
    }

    try {
      const hit = router.match(req.method ?? 'GET', url.pathname)
      if (!hit) {
        send(404, { error: { code: 'ROUTE_NOT_FOUND', message: `no route for ${req.method} ${url.pathname}` } })
        return
      }

      routeLabel = '/' + hit.route.segments.join('/')
      const body = await readBody(req)
      const result = await hit.route.handler({
        method: req.method as Method,
        path: url.pathname,
        params: hit.params,
        query: url.searchParams,
        body,
        headers: req.headers,
        ip: req.socket.remoteAddress ?? undefined,
      })
      send(result.status, result.body, result.headers)
    } catch (err) {
      const e = err as { code?: string; status?: number; message?: string; details?: unknown }
      const status = e.status ?? (e.code ? STATUS_BY_CODE[e.code] ?? 400 : 500)

      if (status >= 500) {
        console.error(`[${requestId}] ${req.method} ${url.pathname}`, err)
      }
      send(status, {
        error: {
          // a stable machine code, because support cannot triage "something went wrong"
          code: e.code ?? 'INTERNAL_ERROR',
          message: status >= 500 ? 'an unexpected error occurred' : e.message ?? 'request failed',
          ...(e.details ? { details: e.details } : {}),
          requestId,
        },
      })
    } finally {
      const ms = Date.now() - started
      if (ms > 1000) console.warn(`[${requestId}] slow ${req.method} ${url.pathname} ${ms}ms`)
    }
  }
}
