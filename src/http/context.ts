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
import { publish, type PeplEvent } from '../realtime/bus.ts'

export interface Ctx {
  tx: PoolClient
  auth: AuthzContext
  session: Session
  config: ResolvedConfig
  req: Req

  /**
   * Queues a live event for delivery AFTER this transaction commits.
   *
   * Publishing inline would announce a message that a later error rolls
   * back, and a browser cannot un-see it.
   */
  publish: (event: PeplEvent) => void
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
/** Routes a not-yet-verified (or not-yet-enrolled) session may still reach. */
const MFA_ALLOWED = /^\/api\/v1\/auth\/(mfa(\/|$)|logout$|me$)/
const ADMIN_ROLES = new Set(['org_admin', 'hr_admin', 'payroll_admin', 'finance'])

export function authed(permission: Permission | null, handler: AuthedHandler) {
  return async (req: Req): Promise<Res> => {
    const session = await resolveSession(bearer(req))
    const path = req.path
    if (session.mfaPending && !MFA_ALLOWED.test(path)) {
      throw new HttpError(401, 'MFA_REQUIRED', 'enter the code from your authenticator to finish signing in')
    }

    const pending: PeplEvent[] = []

    const result = await withTenant(
      session.tenantId,
      async (tx) => {
        const auth = await loadAuthzContext(tx, session)
        if (permission) assertPermission(auth, permission)
        const config = await resolveConfig(tx, session.tenantId)
        // The company can insist that admins carry a second factor: until they
        // enrol, every route but enrolment answers 403 with the reason.
        if (config.get<boolean>('security.mfa_required_for_admins') && !MFA_ALLOWED.test(path) && auth.roles.some((r) => ADMIN_ROLES.has(r))) {
          const on = (await tx.query<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL) AS on`, [session.userId])).rows[0]!.on
          if (!on) throw new HttpError(403, 'MFA_ENROLMENT_REQUIRED', 'this company requires administrators to set up two-factor authentication')
        }
        return handler({
          tx, auth, session, config, req,
          publish: (event) => { pending.push(event) },
        })
      },
      { userId: session.userId },
    )

    // Past this line the COMMIT has happened, so every event describes
    // something that is actually true.
    for (const event of pending) publish(session.tenantId, event)
    return result
  }
}

/**
 * For irreversible money actions: the session must have passed the second
 * factor within `withinMinutes` — when the user has one. A user without MFA
 * is not blocked (the company decides enrolment via the setting), so this
 * never locks payroll out; it makes a stolen cookie insufficient.
 */
export async function requireRecentMfa(ctx: Ctx, withinMinutes = 12 * 60): Promise<void> {
  const on = (await ctx.tx.query<{ on: boolean }>(`SELECT EXISTS (SELECT 1 FROM user_mfa WHERE user_id = $1 AND enabled_at IS NOT NULL) AS on`, [ctx.session.userId])).rows[0]!.on
  if (!on) return
  const at = ctx.session.mfaVerifiedAt?.getTime() ?? 0
  if (Date.now() - at > withinMinutes * 60_000) throw new HttpError(403, 'MFA_RECHECK_REQUIRED', 'confirm your authenticator code again before this action')
}

/** A route reachable without a session (login, health). */
export function open(handler: (req: Req) => Promise<Res> | Res) {
  return handler
}

/** Refuses the request when the tenant has not enabled or bought the module. */
export function requireModule(ctx: Ctx, key: string): void {
  if (ctx.config.isEnabled(key)) return
  const module = key.split('.')[0]
  // A module can be dark for two very different reasons, and collapsing them
  // leaves the browser unable to say which. "Switch it on in Settings" and
  // "this is sold on a higher plan" are not the same sentence, and only the
  // second one is a conversation with an account manager.
  if (!ctx.config.isEntitled(key)) {
    throw new HttpError(
      403,
      'PLAN_UPGRADE_REQUIRED',
      `${module} is not included in this company's plan`,
      { key, entitlement: ctx.config.entitlementOf(key) },
    )
  }
  throw new HttpError(
    403,
    'MODULE_NOT_AVAILABLE',
    `${module} is switched off for this company`,
    { key },
  )
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
