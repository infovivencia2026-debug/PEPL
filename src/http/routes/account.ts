/**
 * The account a person holds: forgotten password, changed password, devices
 * signed in. Public routes are rate-limited per IP by the handler; the
 * forgot-password answer is 202 whatever the email, so it enumerates nothing.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, open, noContent, requireBody, asUuid, emit, type Req } from './deps.ts'
import {
  changePassword, issueResetToken, listSessions, requestPasswordReset, resetPassword, revokeOwnSession,
  RESET_TTL_MINUTES,
} from '../../auth/reset.ts'

function baseUrl(req: Req): string {
  // Explicit beats inferred: a reverse proxy's Host header is not the address
  // an employee's browser will accept.
  return process.env.PEPL_PUBLIC_URL
    ?? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host ?? 'localhost')}`
}

export function register(router: Router): void {
  router.post('/api/v1/auth/forgot-password',
    { summary: 'Email a reset link if the address has an account (always 202)', tag: 'auth', public: true,
      requestExample: { email: 'rahul@acme.test' } },
    open(async (req: Req) => {
      const b = requireBody<{ email: string }>(req, ['email'])
      if (typeof b.email !== 'string' || !b.email.includes('@')) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'email is required')
      }
      await requestPasswordReset({ email: b.email.trim(), ip: req.ip, baseUrl: baseUrl(req) })
      return { status: 202, body: { accepted: true, ttlMinutes: RESET_TTL_MINUTES } }
    }))

  router.post('/api/v1/auth/reset-password',
    { summary: 'Set a new password with a reset token; signs out every session', tag: 'auth', public: true,
      requestExample: { token: '…', newPassword: 'a-long-new-passphrase' } },
    open(async (req: Req) => {
      const b = requireBody<{ token: string; newPassword: string }>(req, ['token', 'newPassword'])
      await resetPassword({ token: String(b.token), newPassword: String(b.newPassword), ip: req.ip })
      return ok({ reset: true })
    }))

  router.post('/api/v1/auth/change-password',
    { summary: 'Change my password (current required); signs out my other devices', tag: 'auth',
      requestExample: { currentPassword: '…', newPassword: '…' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ currentPassword: string; newPassword: string }>(ctx.req, ['currentPassword', 'newPassword'])
      const r = await changePassword(ctx.tx, {
        userId: ctx.auth.userId, sessionId: ctx.session.sessionId,
        currentPassword: String(b.currentPassword), newPassword: String(b.newPassword),
      })
      return ok(r)
    }))

  router.get('/api/v1/auth/sessions',
    { summary: 'Where I am signed in', tag: 'auth' },
    authed(null, async (ctx) => ok({ sessions: await listSessions(ctx.tx, ctx.auth.userId, ctx.session.sessionId) })))

  router.del('/api/v1/auth/sessions/:id',
    { summary: 'Sign out one of my devices', tag: 'auth' },
    authed(null, async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      if (!(await revokeOwnSession(ctx.tx, ctx.auth.userId, id))) {
        throw new HttpError(404, 'NOT_FOUND', 'no such active session of yours')
      }
      return noContent()
    }))

  router.post('/api/v1/users/:id/password-reset-link',
    { summary: 'Issue a reset link to hand to a locked-out person (when email is not set up)',
      tag: 'auth', permission: 'roles.write' },
    authed('roles.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const { rows } = await ctx.tx.query<{ status: string }>(`SELECT status FROM app_users WHERE id = $1`, [id])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such user')
      if (rows[0].status !== 'active') throw new HttpError(409, 'USER_INACTIVE', 'this account is not active')
      const { token, expiresAt } = await issueResetToken(ctx.tx, { userId: id, issuedByUserId: ctx.auth.userId, ip: ctx.req.ip })
      // The link is a credential. Issuing one is logged as such.
      await emit(ctx.tx, {
        action: 'security.password_reset.issued', entityType: 'user', entityId: id, actorUserId: ctx.auth.userId,
        metadata: { expiresAt: expiresAt.toISOString() },
      })
      return ok({ link: `${baseUrl(ctx.req)}/reset-password?token=${token}`, expiresAt: expiresAt.toISOString() })
    }))
}
