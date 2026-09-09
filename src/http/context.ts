/**
 * The request path, in one place.
 *
 *   authenticate -> resolve tenant FROM THE SESSION (never a header or the body)
 *   -> BEGIN -> SET LOCAL app.tenant_id / app.user_id
 *   -> load the authorization context
 *   -> run the handler
 *   -> COMMIT
 *
 * There is no route that reaches Postgres any other way, which is what makes the
 * isolation guarantee hold for every endpoint rather than for the ones someone
 * remembered.
 */
import type { PoolClient } from 'pg'
import { HttpError, type Req, type Res } from './router.ts'
import { loadAuthzContext, resolveSession, type Session } from '../auth/index.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { assertPermission, type AuthzContext, type Permission } from '../authz/permissions.ts'
import { resolveConfig, type ResolvedConfig } from '../config/resolver.ts'

export interface Ctx {
  tx: PoolClient
  auth: AuthzContext
  session: Session
  config: ResolvedConfig
  req: Req
}

export type AuthedHandler = (ctx: Ctx) => Promise<Res> | Res

function bearer(req: Req): string {
  const header = req.headers.authorization ?? ''
  if (!header.startsWith('Bearer ')) {
    throw new HttpError(401, 'MISSING_TOKEN', 'an Authorization: Bearer <token> header is required')
  }
  return header.slice(7).trim()
}

/**
 * Wraps a handler with authentication, tenant context and authorization.
 * `permission` is asserted before the handler runs; scope checks belong inside,
 * where the target employee is known.
 */
export function authed(permission: Permission | null, handler: AuthedHandler) {
  return async (req: Req): Promise<Res> => {
    const session = await resolveSession(bearer(req))

    return withTenant(
      session.tenantId,
      async (tx) => {
        const auth = await loadAuthzContext(tx, session)
        if (permission) assertPermission(auth, permission)
        const config = await resolveConfig(tx, session.tenantId)
        return handler({ tx, auth, session, config, req })
      },
      { userId: session.userId },
    )
  }
}

/** A route reachable without a session (login, health). */
export function open(handler: (req: Req) => Promise<Res> | Res) {
  return handler
}

/** Refuses the request when the tenant has not enabled or bought the module. */
export function requireModule(ctx: Ctx, key: string): void {
  if (!ctx.config.isEnabled(key)) {
    throw new HttpError(
      403,
      'MODULE_NOT_AVAILABLE',
      `${key.split('.')[0]} is not enabled for this company, or is not included in the current plan`,
      { key },
    )
  }
}

export const ok = (body: unknown): Res => ({ status: 200, body })
export const created = (body: unknown): Res => ({ status: 201, body })
export const accepted = (body: unknown): Res => ({ status: 202, body })
export const noContent = (): Res => ({ status: 204, body: null })

/** Minimal validation helpers — enough to reject a bad request with a clear code. */
export function requireBody<T extends Record<string, unknown>>(req: Req, fields: (keyof T & string)[]): T {
  const body = (req.body ?? {}) as T
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '')
  if (missing.length) {
    throw new HttpError(422, 'VALIDATION_FAILED', `missing required field(s): ${missing.join(', ')}`,
      { missing })
  }
  return body
}

export function asDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new HttpError(422, 'VALIDATION_FAILED', `${field} must be a date in YYYY-MM-DD form`)
  }
  return value
}

export function asUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new HttpError(422, 'VALIDATION_FAILED', `${field} must be a UUID`)
  }
  return value
}

export function asInt(value: unknown, field: string, opts: { min?: number; max?: number } = {}): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) throw new HttpError(422, 'VALIDATION_FAILED', `${field} must be a number`)
  if (opts.min !== undefined && n < opts.min) {
    throw new HttpError(422, 'VALIDATION_FAILED', `${field} must be at least ${opts.min}`)
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new HttpError(422, 'VALIDATION_FAILED', `${field} must be at most ${opts.max}`)
  }
  return n
}
