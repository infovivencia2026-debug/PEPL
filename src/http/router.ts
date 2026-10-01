/**
 * A small HTTP router over node:http.
 *
 * No framework: routing, JSON handling and error mapping are ~150 lines, and a
 * dependency here would be one more thing to audit in a product that holds
 * payroll data.
 */
import { isIP } from 'node:net'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PUBLIC_LIMIT, RateLimiter, SESSION_LIMIT, sessionKey, type Limit, type Verdict } from './rate-limit.ts'
import { PgRateLimiter } from './rate-limit-pg.ts'
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
  STATUTORY_CHANGED: 409,
  MODULE_NOT_AVAILABLE: 403,
  PLAN_UPGRADE_REQUIRED: 403,
  EMPLOYEE_LIMIT_REACHED: 403,
  NO_EMPLOYEE_RECORD: 422,
  LOCATION_REQUIRED: 422,
  CATEGORY_NOT_FOUND: 404,
  RUN_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  PERIOD_NOT_FOUND: 404,
  // conflicts with the state of the world, not with the request
  PERIOD_CLOSED: 409,
  DATE_OUT_OF_WINDOW: 422,
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
  TEMPLATE_EXISTS: 409,
  TEMPLATE_NOT_FOUND: 404,
  TEMPLATE_RETIRED: 409,
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
  CONTENT_CORRUPT: 500,
  PUSH_NOT_CONFIGURED: 503,
  RUN_NOT_LOCKED_FOR_FILING: 409,
  INVALID_QUARTER: 422,
  NO_PAY_IN_YEAR: 404,
  NO_TAX_RULES: 422,
  DUPLICATE_IDENTIFIER: 409,
  ALREADY_EXITED: 409,
  SEPARATION_OPEN: 409,
  SEPARATION_NOT_OPEN: 409,
  NO_COMPENSATION: 422,
  WEAK_PASSWORD: 422,
  NOT_ERASABLE: 409,
  UNIT_EXISTS: 409,
  UNIT_RETIRED: 409,
  UNIT_HAS_CHILDREN: 409,
  UNKNOWN_UNIT: 422,
  OUTSIDE_GEOFENCE: 422,
  SITE_EXISTS: 409,
  SHIFT_EXISTS: 409,
  COMPONENT_EXISTS: 409,
  COMPONENT_IN_USE: 409,
  STRUCTURE_EXISTS: 409,
  UNKNOWN_COMPONENT: 422,
  PLAN_NOT_BACKDATABLE: 422,
  POLICY_EXISTS: 409,
  ROLE_EXISTS: 409,
  ROLE_RETIRED: 409,
  UNKNOWN_ROLE: 422,
  SELF_ROLE_CHANGE: 403,
  LAST_ADMIN: 409,
  UNKNOWN_CHAIN: 422,
  PLAN_NOT_IN_FORCE: 422,
  PERIOD_EXISTS: 409,
  STRUCTURE_EXCEEDS_PAY: 422,
  ROSTER_NOT_AFTER_CURRENT: 422,
  SITE_RETIRED: 409,
  RESET_TOKEN_INVALID: 400,
  USER_INACTIVE: 409,
  VAPID_MISCONFIGURED: 500,
  VAPID_KEYS_INVALID: 500,
  SUBSCRIPTION_KEYS_INVALID: 422,
  PAYLOAD_TOO_LARGE: 422,
  PUSH_SERVICE_UNREACHABLE: 503,
  PUSH_REJECTED: 502,
  OBJECT_STORE_MISCONFIGURED: 500,
  OBJECT_STORE_UNREACHABLE: 503,
  OBJECT_STORE_WRITE_FAILED: 502,
  OBJECT_STORE_READ_FAILED: 502,
  OBJECT_STORE_DELETE_FAILED: 502,
  INVALID_LEAVE_CODE: 422,
  RUN_NOT_LOCKED: 409,
  MISSING_BANK_DETAILS: 422,
  MANAGER_IS_SELF: 422,
  COMP_OFF_EXISTS: 409,
  REMOTE_OVERLAP: 409,
  NOT_APPLICABLE: 403,
  REPORT_EXISTS: 409,
  ANOMALIES_OPEN: 409,
  SANDBOX_EXISTS: 409,
  SANDBOX_OF_SANDBOX: 422,
  RUN_NOT_CALCULATED: 409,
  DOMAIN_TAKEN: 409,
  GROUP_EXISTS: 409,
  NOT_GROUP_ADMIN: 403,
  RESELLER_NO_SNAPSHOT: 403,
  NOT_RESELLER: 403,
  NOT_CONTRACTOR: 422,
  CONTRACTOR_NOT_ON_PAYROLL: 422,
  DUPLICATE_INVOICE: 409,
  INVOICE_STATE: 409,
  INVOICES_OPEN: 409,
  ROUND_OPEN: 409,
  ROUND_CLOSED: 409,
  FEEDBACK_STATE: 409,
  RECOMMENDATION_OPEN: 409,
  NO_CURRENT_COMPENSATION: 422,
  NOMINATION_STATE: 409,
  BADGE_MANAGER_ONLY: 403,
  RECOGNITION_TOO_SOON: 429,
  INSUFFICIENT_POINTS: 409,
  JOURNAL_UNBALANCED: 422,
  PER_DIEM_RATE_MISSING: 422,
  POSITION_OCCUPIED: 409,
  POSITION_STATE: 409,
  POSITION_FULL: 409,
  TRANSFER_OPEN: 409,
  CHANGE_REQUEST_OPEN: 409,
  CHANGE_REQUEST_DECIDED: 409,
  POLICY_STATE: 409,
  SURVEY_STATE: 409,
  ALREADY_RESPONDED: 409,
  ASSET_TAG_TAKEN: 409,
  ASSET_ISSUED: 409,
  ASSET_UNAVAILABLE: 409,
  ASSETS_OUTSTANDING: 409,
  SHIFT_NOT_FOUND: 404,
  PERIOD_FROZEN: 409,
  SWAP_OPEN: 409,
  SWAP_STATE: 409,
  OPTIONAL_HOLIDAYS_OFF: 422,
  OPTIONAL_HOLIDAY_CAP: 422,
  OT_REQUEST_OPEN: 409,
  PRESET_NOT_FOUND: 404,
  PRESET_INVALID: 500,
  MERGE_INCOMPLETE: 422,
  REVIEW_DECIDED: 409,
  NOT_PUNCHED_IN: 409,
  BREAK_OPEN: 409,
  NO_OPEN_BREAK: 409,
  NOT_LATE: 409,
  QR_INVALID: 422,
  QR_EXPIRED: 422,
  SITE_NOT_FOUND: 404,
  CYCLE_EXISTS: 409,
  CYCLE_NOT_DRAFT: 409,
  CYCLE_STATE: 409,
  RATINGS_PENDING: 409,
  WEIGHT_OVER: 422,
  GOAL_CLOSED: 409,
  NOT_YOURS: 403,
  NOT_REVIEWER: 403,
  APPRAISAL_STATE: 409,
  PIP_OPEN: 409,
  PIP_CLOSED: 409,
  WFH_CAP: 422,
  VISIT_OPEN: 409,
  REQUISITION_NOT_OPEN: 409,
  CANDIDATE_EXISTS: 409,
  BAD_STAGE_MOVE: 409,
  NOT_INTERVIEWER: 403,
  OVER_BAND: 422,
  OFFER_OPEN: 409,
  OFFER_NOT_APPROVED: 409,
  OFFER_NOT_SENT: 409,
  OFFER_NOT_LIVE: 409,
  OFFER_NOT_ACCEPTED: 409,
  ALREADY_CONVERTED: 409,
  RESIGNATION_OPEN: 409,
  RESIGNATION_NOT_OPEN: 409,
  CLEARANCE_PENDING: 409,
  NOT_SETTLED: 409,
  TIMESHEET_LOCKED: 409,
  TIMESHEET_EMPTY: 422,
  PROJECT_NOT_FOUND: 422,
  PROJECT_INACTIVE: 422,
  NOT_ALLOCATED: 422,
  OVER_24_HOURS: 422,
  OVER_ALLOCATED: 422,
  NO_CO_LEAVE_TYPE: 422,
  EXPENSE_CATEGORY_NOT_FOUND: 422,
  CLAIM_TOO_OLD: 422,
  OVER_CLAIM_LIMIT: 422,
  OVER_MONTHLY_LIMIT: 422,
  RECEIPT_REQUIRED: 422,
  DUPLICATE_CLAIM: 409,
  TRAVEL_NOT_APPROVED: 422,
  CLAIM_NOT_CANCELLABLE: 409,
  TRIP_NOT_SETTLEABLE: 409,
  TRIP_HAS_OPEN_CLAIMS: 409,
  WORK_EMAIL_TAKEN: 409,
  UNKNOWN_FIELD: 422,
  UNKNOWN_MODEL: 422,
  MANAGER_NOT_FOUND: 422,
  MANAGER_EXITED: 422,
  MANAGER_CYCLE: 422,
  EMPLOYEE_EXITED: 409,
  PRIVILEGED_LOGIN: 403,
  ADDRESS_NOT_YOURS: 403,
  LOGIN_NOT_ACTIVE: 409,
  NOT_READY: 503,
  RATE_LIMITED: 429,
  // documents
  FILE_TOO_LARGE: 413,
  // Not 413: the file is fine, the account is full. 409 so a client can tell
  // "try a smaller file" apart from "you are out of space".
  STORAGE_LIMIT_REACHED: 409,
  EMPTY_FILE: 422,
  PERIOD_LOCKED: 409,
  PLAN_NOT_FOUND: 404,
  OVER_PLAN_LIMIT: 409,
  NO_SUBSCRIPTION: 404,
  INVOICE_NOT_FOUND: 404,
  PERIOD_IN_USE: 409,
  INVALID_CATEGORY: 422,
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
  FOLDER_EXISTS: 409,
  EMAIL_TAKEN: 409,
  LAST_MAILBOX: 409,
  MAIL_KEY_MISSING: 503,
  ATTACHMENT_TOO_LARGE: 413,
  ATTACHMENT_NOT_YOURS: 422,
  // import
  IMPORT_INVALID: 422,
  IMPORT_HAS_ERRORS: 422,
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

  /**
   * The most specific match wins, not the first registered: a literal segment
   * beats a parameter at the same position. Without this, /org/:kind (masters,
   * registered early) swallowed /org/chart (registered later) and answered
   * "kind must be one of department, location…" to a chart request.
   */
  match(method: string, path: string): { route: Route; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean)
    let best: { route: Route; params: Record<string, string>; literals: number } | undefined
    for (const route of this.routes) {
      if (route.method !== method) continue
      if (route.segments.length !== parts.length) continue
      const params: Record<string, string> = {}
      let ok = true
      let literals = 0
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!
        const part = parts[i]!
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part)
        else if (seg !== part) { ok = false; break }
        else literals++
      }
      if (ok && (!best || literals > best.literals)) best = { route, params, literals }
    }
    return best && { route: best.route, params: best.params }
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
  /**
   * 'memory' (default) is exact for one instance. 'postgres' shares counts
   * across instances behind a balancer at one round-trip per request.
   * Defaults from PEPL_RATE_LIMIT_STORE.
   */
  store?: 'memory' | 'postgres'
}

interface Limiter { check(key: string, now?: number): Verdict | Promise<Verdict> }

/**
 * Who this request is really from, for rate limiting.
 *
 * `socket.remoteAddress` is the PROXY behind a reverse proxy, so every
 * unauthenticated request on this deployment shared one bucket: one attacker
 * could exhaust it and lock every customer out of signing in, and per-attacker
 * limiting did nothing at all.
 *
 * `x-forwarded-for` is only trusted when the connection came from loopback --
 * i.e. from our own proxy. A direct caller can put anything in that header, so
 * trusting it unconditionally would let an attacker mint a fresh bucket per
 * request and remove the limit entirely. The LAST entry is the one our own
 * proxy appended; earlier ones may have come from the client.
 */
const isLoopbackAddr = (ip: string): boolean =>
  ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1'

export const clientIp = (req: { socket: { remoteAddress?: string | undefined }; headers: Record<string, unknown> }): string => {
  const remote = req.socket.remoteAddress ?? 'unknown'
  if (!isLoopbackAddr(remote)) return remote
  const raw = req.headers['x-forwarded-for']
  const chain = String(Array.isArray(raw) ? raw[0] ?? '' : raw ?? '')
    .split(',').map((p) => p.trim()).filter(Boolean)
  const last = chain.length ? chain[chain.length - 1]! : undefined
  // Only a real address. The value is stored in an inet column, so a header that is
  // not one would make the insert throw and read as a 500 on the login page.
  return last && isIP(last) ? last : remote
}

export function createHandler(router: Router, options: HandlerOptions = {}) {
  const store = options.store ?? (process.env.PEPL_RATE_LIMIT_STORE === 'postgres' ? 'postgres' : 'memory')
  const make = (limit: Limit): Limiter => store === 'postgres' ? new PgRateLimiter(limit) : new RateLimiter(limit)
  const publicLimiter = make(options.publicLimit ?? PUBLIC_LIMIT)
  const sessionLimiter = make(options.sessionLimit ?? SESSION_LIMIT)

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
      // Chosen by the ROUTE, not by whether a header happens to be present. It was
      // chosen by the header: a junk `Authorization: Bearer x` on the login route
      // moved the request into a private bucket keyed on that junk, and a fresh value
      // each time meant the per-IP limit never applied -- login spraying and reset-mail
      // bombing were unlimited. A public route has no session to be limited by, so it
      // is limited by address, whatever it carries.
      const publicRoute = router.match(req.method ?? 'GET', url.pathname)?.route.meta.public === true
      const bySession = Boolean(token) && !publicRoute
      const verdict = await (bySession
        ? sessionLimiter.check(sessionKey(token!))
        : publicLimiter.check(`ip:${clientIp(req)}`))
      if (!verdict.allowed) {
        rateLimited.inc({ limiter: bySession ? 'session' : 'public' })
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
        ip: clientIp(req),
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
