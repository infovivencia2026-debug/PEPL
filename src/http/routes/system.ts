/** Health and identity. */
import type { Router } from '../router.ts'
import { PT_EXEMPT_STATES, PT_STATES } from '../../../db/reference/pt-slabs.ts'
import {
  type Req,
  authed,
  open,
  ok,
  noContent,
  HttpError,
  requireBody,
  login,
  revokeAllSessions,
  revokeSession,
  REGISTRY,
} from './deps.ts'
import { appPool } from '../../db/pool.ts'
import { mfaStatus, beginSetup, enable as enableMfa, verify as verifyMfa, disable as disableMfa, adminReset } from '../../auth/mfa.ts'
import { emit, asUuid, can } from './deps.ts'

export function register(router: Router): void {
  router.get('/health', { summary: 'Liveness probe', tag: 'system', public: true },
    open(() => ok({ status: 'ok', time: new Date().toISOString() })))

  /**
   * Readiness, which is a different question from liveness.
   *
   * Liveness asks whether the process is running; a load balancer that routes
   * on it will happily send traffic to an instance whose database is
   * unreachable or whose migrations have not been applied. This asks whether
   * the instance can actually serve, and says which part failed.
   *
   * It reports the migration count rather than comparing against a number
   * compiled in: during a rolling deploy the old and new images disagree about
   * what "current" means, and an instance refusing traffic for that reason is
   * an outage of its own making.
   */
  router.get('/health/ready',
    { summary: 'Readiness probe: database reachable, schema applied', tag: 'system', public: true },
    open(async () => {
      const started = Date.now()
      try {
        const { rows } = await appPool.query<{ migrations: string; db: string }>(
          `SELECT (SELECT count(*) FROM _migrations)::text AS migrations,
                  current_database() AS db`,
        )
        return ok({
          status: 'ready',
          database: rows[0]?.db,
          migrations: Number(rows[0]?.migrations ?? 0),
          checkMs: Date.now() - started,
        })
      } catch (err) {
        throw new HttpError(503, 'NOT_READY', 'the database is not reachable from this instance', {
          detail: (err as Error).message,
          checkMs: Date.now() - started,
        })
      }
    }))

  router.get('/api/v1/statutory/pt-states',
    { summary: 'Professional-tax coverage: states with slabs (and when they were checked), and states that levy none',
      tag: 'system' },
    authed(null, async (ctx) => {
      const { rows } = await ctx.tx.query<{ state_code: string; n: string; since: string }>(
        `SELECT state_code, count(*)::text AS n, min(effective_from)::text AS since FROM pt_slabs
          WHERE effective_from <= CURRENT_DATE AND (effective_to IS NULL OR effective_to >= CURRENT_DATE) GROUP BY state_code`)
      const loaded = new Map(rows.map((r) => [r.state_code, r]))
      return ok({
        states: PT_STATES.map((s) => ({ code: s.code, name: s.name, verifiedOn: s.verifiedOn, note: s.note ?? null,
          loaded: loaded.has(s.code), slabs: Number(loaded.get(s.code)?.n ?? 0), since: loaded.get(s.code)?.since ?? null })),
        exempt: PT_EXEMPT_STATES,
      })
    }))

  router.post('/api/v1/auth/login',
    { summary: 'Exchange email and password for a session token', tag: 'auth', public: true,
      requestExample: { email: 'admin@acme.com', password: 'correct-horse-battery' } },
    open(async (req: Req) => {
      const body = requireBody<{ email: string; password: string }>(req, ['email', 'password'])
      const result = await login({
        email: body.email, password: body.password,
        ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
      })
      return ok({
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
        user: { id: result.userId, roles: result.roles },
        mfaRequired: result.mfaRequired,
      })
    }))

  // ── two-factor authentication ──
  router.get('/api/v1/auth/mfa', { summary: 'My second-factor status', tag: 'auth' },
    authed(null, async (ctx) => ok({ ...(await mfaStatus(ctx.tx, ctx.auth.userId)), sessionVerifiedAt: ctx.session.mfaVerifiedAt?.toISOString() ?? null })))

  router.post('/api/v1/auth/mfa/setup', { summary: 'Start enrolling an authenticator app: returns the otpauth URI to show as a QR and the secret to type', tag: 'auth' },
    authed(null, async (ctx) => {
      const email = (await ctx.tx.query<{ email: string }>(`SELECT email FROM app_users WHERE id = $1`, [ctx.auth.userId])).rows[0]!.email
      const company = (await ctx.tx.query<{ d: string }>(`SELECT display_name AS d FROM tenants`)).rows[0]?.d ?? 'PEPL'
      return ok(await beginSetup(ctx.tx, { userId: ctx.auth.userId, email, issuer: `PEPL · ${company}` }))
    }))

  router.post('/api/v1/auth/mfa/enable', { summary: 'Finish enrolment with a code from the app; returns 8 recovery codes, shown once', tag: 'auth', requestExample: { code: '123456' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ code: string }>(ctx.req, ['code'])
      const r = await enableMfa(ctx.tx, { userId: ctx.auth.userId, code: b.code, sessionId: ctx.session.sessionId })
      await emit(ctx.tx, { action: 'security.mfa.enabled', entityType: 'user', entityId: ctx.auth.userId, actorUserId: ctx.auth.userId })
      return ok(r)
    }))

  router.post('/api/v1/auth/mfa/verify', { summary: 'Second step of login (or a re-check before a sensitive action): an authenticator code or a recovery code', tag: 'auth', requestExample: { code: '123456' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ code: string }>(ctx.req, ['code'])
      return ok(await verifyMfa(ctx.tx, { userId: ctx.auth.userId, sessionId: ctx.session.sessionId, code: b.code }))
    }))

  router.post('/api/v1/auth/mfa/disable', { summary: 'Turn the second factor off (needs a current code)', tag: 'auth', requestExample: { code: '123456' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ code: string }>(ctx.req, ['code'])
      await disableMfa(ctx.tx, { userId: ctx.auth.userId, sessionId: ctx.session.sessionId, code: b.code })
      await emit(ctx.tx, { action: 'security.mfa.disabled', entityType: 'user', entityId: ctx.auth.userId, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.post('/api/v1/auth/mfa/reset/:userId', { summary: 'Admin: remove a colleague\'s second factor after a lost phone and sign them out everywhere', tag: 'auth', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const userId = asUuid(ctx.req.params.userId, 'userId')
      if (userId === ctx.auth.userId) throw new HttpError(422, 'VALIDATION_FAILED', 'use /auth/mfa/disable for your own account')
      await adminReset(ctx.tx, userId)
      await emit(ctx.tx, { action: 'security.mfa.reset', entityType: 'user', entityId: userId, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.post('/api/v1/auth/logout', { summary: 'Revoke the current session', tag: 'auth' },
    authed(null, async (ctx) => {
      await revokeSession(ctx.tx, ctx.session.sessionId)
      return noContent()
    }))

  router.post('/api/v1/auth/logout-everywhere',
    { summary: 'Revoke every session for the current user', tag: 'auth' },
    authed(null, async (ctx) => {
      const n = await revokeAllSessions(ctx.tx, ctx.auth.userId)
      return ok({ revoked: n })
    }))

  router.get('/api/v1/me',
    { summary: 'Current user, permissions, data scope and enabled modules', tag: 'auth' },
    authed(null, async (ctx) => ok({
      userId: ctx.auth.userId,
      employeeId: ctx.auth.employeeId ?? null,
      roles: ctx.auth.roles,
      permissions: [...ctx.auth.permissions].sort(),
      scope: ctx.auth.scope,
      modules: Object.keys(REGISTRY)
        .filter((k) => k.endsWith('.enabled'))
        .reduce<Record<string, boolean>>((acc, k) => {
          acc[k.split('.')[0]!] = ctx.config.isEnabled(k)
          return acc
        }, {}),
      limits: { employees: ctx.config.limit('employees') },
      configVersion: String(ctx.config.version),
    })))
}
