/** Health and identity. */
import type { Router } from '../router.ts'
import {
  type Req,
  authed,
  open,
  ok,
  noContent,
  requireBody,
  login,
  revokeAllSessions,
  revokeSession,
  REGISTRY,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/health', { summary: 'Liveness probe', tag: 'system', public: true },
    open(() => ok({ status: 'ok', time: new Date().toISOString() })))

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
      })
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
