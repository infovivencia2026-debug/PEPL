/**
 * Password reset and password change.
 *
 * forgot-password is tenant-agnostic at the door like login: an email in, a
 * 202 out whether or not the account exists, so the endpoint cannot be used
 * to enumerate accounts. The token travels in a notification email through
 * the company's own sender mailbox — the only email path PEPL has — so a
 * company that has not connected one gets the admin-issued link instead.
 *
 * Every successful reset or change revokes every other session: the point of
 * changing a password is usually that someone else has it.
 */
import { randomBytes, createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import { appPool } from '../db/pool.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { notify } from '../comms/index.ts'
import { emit } from '../audit/index.ts'
import { AuthError, hashPassword, revokeAllSessions, verifyPassword } from './index.ts'

export const RESET_TTL_MINUTES = 30
const MIN_PASSWORD = 10

const hashToken = (t: string): string => createHash('sha256').update(t).digest('hex')

export function checkPasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    throw new AuthError('WEAK_PASSWORD', `use at least ${MIN_PASSWORD} characters`, 422)
  }
  if (/^(.)\1+$/.test(password) || /^(0123456789|1234567890|password|qwertyuiop)/i.test(password)) {
    throw new AuthError('WEAK_PASSWORD', 'that password is too easy to guess', 422)
  }
}

/** Writes a reset row and returns the raw token. Only the hash is stored. */
export async function issueResetToken(
  tx: PoolClient,
  args: { userId: string; ip?: string; issuedByUserId?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + RESET_TTL_MINUTES * 60_000)
  // One live token per person: a new request invalidates the old link.
  await tx.query(`UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL`, [args.userId])
  await tx.query(
    `INSERT INTO password_resets (tenant_id, user_id, token_hash, expires_at, requested_ip, issued_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tid, args.userId, hashToken(token), expiresAt, args.ip ?? null, args.issuedByUserId ?? null])
  return { token, expiresAt }
}

/**
 * The public front door. Resolves the email across tenants the way login does,
 * and if it names exactly one active account, issues a token and queues the
 * email. Returns nothing either way.
 */
export async function requestPasswordReset(args: { email: string; ip?: string; baseUrl: string }): Promise<void> {
  const client = await appPool.connect()
  let user: { tenant_id: string; id: string; status: string } | undefined
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.bypass_reason', 'login_lookup', true)`)
    const { rows } = await client.query<{ tenant_id: string; id: string; status: string }>(
      `SELECT tenant_id, id, status FROM auth_user_by_email($1)`, [args.email])
    await client.query('COMMIT')
    user = rows[0]
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
  if (!user || user.status !== 'active') return

  await withTenant(user.tenant_id, async (tx) => {
    const { token, expiresAt } = await issueResetToken(tx, { userId: user!.id, ip: args.ip })
    const link = `${args.baseUrl.replace(/\/$/, '')}/reset-password?token=${token}`
    await notify(tx, {
      userId: user!.id, eventType: 'security.password_reset',
      title: 'Reset your PEPL password',
      body: `Someone — hopefully you — asked to reset the password for this account. ` +
        `Use this link within ${RESET_TTL_MINUTES} minutes: ${link}\n\n` +
        `If you did not ask, ignore this; your password has not changed.`,
      channels: ['email'],
      dedupeKey: `reset:${expiresAt.getTime()}`,
    })
    await emit(tx, { action: 'security.password_reset.requested', entityType: 'user', entityId: user!.id, actorUserId: user!.id,
      metadata: { ip: args.ip ?? null } })
  })
}

/** Consumes a token. Cross-tenant lookup by hash, then everything inside the tenant. */
export async function resetPassword(args: { token: string; newPassword: string; ip?: string }): Promise<{ tenantId: string; userId: string }> {
  checkPasswordStrength(args.newPassword)
  const client = await appPool.connect()
  let hit: { tenant_id: string; user_id: string; id: string } | undefined
  try {
    const { rows } = await client.query<{ tenant_id: string; user_id: string; id: string }>(
      `SELECT * FROM auth_reset_by_hash($1)`, [hashToken(args.token)])
    hit = rows[0]
  } finally {
    client.release()
  }
  if (!hit) throw new AuthError('RESET_TOKEN_INVALID', 'this reset link is invalid, used, or has expired', 400)

  const hash = await hashPassword(args.newPassword)
  await withTenant(hit.tenant_id, async (tx) => {
    // Mark used FIRST with a guard, so two racing submissions cannot both win.
    const used = await tx.query(
      `UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL`, [hit!.id])
    if (!used.rowCount) throw new AuthError('RESET_TOKEN_INVALID', 'this reset link has already been used', 400)
    await tx.query(`UPDATE app_users SET password_hash = $2 WHERE id = $1`, [hit!.user_id, hash])
    const revoked = await revokeAllSessions(tx, hit!.user_id)
    await emit(tx, { action: 'security.password.changed', entityType: 'user', entityId: hit!.user_id, actorUserId: hit!.user_id,
      metadata: { via: 'reset_link', sessionsRevoked: revoked, ip: args.ip ?? null } })
  })
  return { tenantId: hit.tenant_id, userId: hit.user_id }
}

/** A signed-in person changes their own password; every OTHER session is revoked. */
export async function changePassword(
  tx: PoolClient,
  args: { userId: string; sessionId: string; currentPassword: string; newPassword: string },
): Promise<{ sessionsRevoked: number }> {
  checkPasswordStrength(args.newPassword)
  const { rows } = await tx.query<{ password_hash: string | null }>(
    `SELECT password_hash FROM app_users WHERE id = $1`, [args.userId])
  if (!rows[0]?.password_hash || !(await verifyPassword(args.currentPassword, rows[0].password_hash))) {
    throw new AuthError('INVALID_CREDENTIALS', 'the current password is incorrect', 401)
  }
  await tx.query(`UPDATE app_users SET password_hash = $2 WHERE id = $1`, [args.userId, await hashPassword(args.newPassword)])
  const r = await tx.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [args.userId, args.sessionId])
  await emit(tx, { action: 'security.password.changed', entityType: 'user', entityId: args.userId, actorUserId: args.userId,
    metadata: { via: 'change', sessionsRevoked: r.rowCount ?? 0 } })
  return { sessionsRevoked: r.rowCount ?? 0 }
}

export interface SessionRow {
  id: string
  issued_at: string
  last_seen_at: string
  expires_at: string
  ip: string | null
  user_agent: string | null
  current: boolean
}

export async function listSessions(tx: PoolClient, userId: string, currentSessionId: string): Promise<SessionRow[]> {
  const { rows } = await tx.query<SessionRow>(
    `SELECT id, issued_at::text, last_seen_at::text, expires_at::text, ip::text, user_agent, (id = $2) AS current
       FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY (id = $2) DESC, last_seen_at DESC`, [userId, currentSessionId])
  return rows
}

/** Revoke one of MY sessions. Someone else's id is simply not found. */
export async function revokeOwnSession(tx: PoolClient, userId: string, sessionId: string): Promise<boolean> {
  const r = await tx.query(
    `UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL`, [sessionId, userId])
  return (r.rowCount ?? 0) > 0
}
