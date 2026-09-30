/**
 * Who the PEPL staff are, and how they prove it.
 *
 * This identity stands OUTSIDE tenant isolation: an operator session reaches
 * every customer's billing. Everything here is shaped by that one fact.
 *
 *   - Separate tables from `app_users`/`sessions`, so a bug cannot confuse a
 *     customer with an operator in either direction.
 *   - A second factor is REQUIRED, not offered. An account that can see every
 *     company's payroll is not protected by a password alone, and "we will
 *     turn MFA on later" is how that stops being true.
 *   - Sessions last hours, not the thirty days a customer's own session gets.
 *   - Every sign-in, and every refusal, lands in platform_audit.
 *
 * It runs on the control connection. `pepl_app` — the role every customer
 * request uses — has no grant on these tables and must never be given one.
 */
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { controlDb, ControlPlaneError } from './index.ts'
import { hashPassword, verifyPassword } from '../auth/index.ts'
import { totp, stepAt } from '../auth/mfa.ts'

/** Hours, not days. This identity is the highest-value credential in the system. */
const SESSION_HOURS = 8
const MAX_FAILED = 5
const LOCKOUT_MINUTES = 15

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

export class PlatformAuthError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 401) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'PlatformAuthError'
  }
}

export interface PlatformUser {
  id: string
  email: string
  full_name: string
  status: string
  mfa_enabled: boolean
}

export interface PlatformSession {
  token: string
  expiresAt: Date
  user: PlatformUser
  /** True until the second factor is verified; the session opens nothing before then. */
  mfaPending: boolean
}

async function audit(action: string, detail: Record<string, unknown>, tenantId: string | null = null): Promise<void> {
  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ($1, $2, $3::jsonb)`,
    [action, tenantId, JSON.stringify(detail)])
}

/** Creates or updates an operator. Called from the CLI, never from a route. */
export async function upsertPlatformUser(args: {
  email: string; fullName: string; password: string
}): Promise<{ id: string; created: boolean }> {
  const email = args.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ControlPlaneError('VALIDATION_FAILED', 'email must be an address')
  }
  // Longer than a customer's 10: this one opens every company.
  if ((args.password ?? '').length < 14) {
    throw new ControlPlaneError('WEAK_PASSWORD', 'a platform password must be at least 14 characters')
  }
  const hash = await hashPassword(args.password)
  const { rows } = await controlDb.query<{ id: string; created: boolean }>(
    `INSERT INTO control_plane.platform_users (email, full_name, password_hash)
     VALUES ($1,$2,$3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, full_name = EXCLUDED.full_name
     RETURNING id, (xmax = 0) AS created`,
    [email, args.fullName.trim(), hash])
  await audit('platform.user.upserted', { email, created: rows[0]!.created })
  return rows[0]!
}

export async function listPlatformUsers(): Promise<Array<PlatformUser & { last_login_at: string | null }>> {
  const { rows } = await controlDb.query<PlatformUser & { last_login_at: string | null }>(
    `SELECT id, email, full_name, status, (mfa_secret IS NOT NULL) AS mfa_enabled, last_login_at::text
       FROM control_plane.platform_users ORDER BY created_at`)
  return rows
}

export async function setPlatformUserStatus(email: string, status: 'active' | 'suspended'): Promise<void> {
  const { rowCount } = await controlDb.query(
    `UPDATE control_plane.platform_users SET status = $2 WHERE lower(email) = lower($1)`, [email, status])
  if (!rowCount) throw new ControlPlaneError('NOT_FOUND', 'no such platform user')
  // Suspending must also end their sessions, or they keep working until expiry.
  if (status === 'suspended') {
    await controlDb.query(
      `UPDATE control_plane.platform_sessions s SET revoked_at = now()
         FROM control_plane.platform_users u
        WHERE s.user_id = u.id AND lower(u.email) = lower($1) AND s.revoked_at IS NULL`, [email])
  }
  await audit('platform.user.status_changed', { email, status })
}

export async function platformLogin(args: {
  email: string; password: string; ip?: string; userAgent?: string
}): Promise<PlatformSession> {
  const email = args.email.trim().toLowerCase()

  const recent = await controlDb.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM control_plane.platform_audit
      WHERE action = 'platform.login.failed' AND detail->>'email' = $1
        AND occurred_at > now() - ($2 || ' minutes')::interval`, [email, LOCKOUT_MINUTES])
  if (Number(recent.rows[0]!.n) >= MAX_FAILED) {
    throw new PlatformAuthError('ACCOUNT_LOCKED',
      `too many failed attempts; try again in ${LOCKOUT_MINUTES} minutes`, 429)
  }

  const { rows } = await controlDb.query<{
    id: string; email: string; full_name: string; status: string
    password_hash: string | null; mfa_secret: string | null
  }>(
    `SELECT id, email, full_name, status, password_hash, mfa_secret
       FROM control_plane.platform_users WHERE lower(email) = $1`, [email])
  const user = rows[0]

  // Constant-ish work whether or not the account exists, so response time does
  // not enumerate operators.
  const ok = user?.password_hash
    ? await verifyPassword(args.password, user.password_hash)
    : await verifyPassword(args.password, await hashPassword('dummy-password-value'))

  if (!user || !ok || user.status !== 'active') {
    await audit('platform.login.failed', { email, reason: !user ? 'no such user' : !ok ? 'bad password' : user.status })
    throw new PlatformAuthError('INVALID_CREDENTIALS', 'email or password is incorrect')
  }

  const token = randomBytes(32).toString('base64url')
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3_600_000)
  // Enrolled operators must clear the second factor before the session opens
  // anything. An operator who has not enrolled yet gets a usable session only
  // so they can enrol — see requirePlatformSession.
  const mfaPending = user.mfa_secret !== null

  await controlDb.query(
    `INSERT INTO control_plane.platform_sessions (user_id, token_hash, expires_at, ip, user_agent, mfa_verified_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [user.id, hashToken(token), expiresAt, args.ip ?? null, args.userAgent ?? null, mfaPending ? null : new Date()])
  await controlDb.query(
    `UPDATE control_plane.platform_users SET last_login_at = now() WHERE id = $1`, [user.id])
  await audit('platform.login', { email, mfaPending })

  return {
    token, expiresAt, mfaPending,
    user: { id: user.id, email: user.email, full_name: user.full_name, status: user.status, mfa_enabled: user.mfa_secret !== null },
  }
}

export interface ResolvedPlatformSession {
  sessionId: string
  user: PlatformUser
  mfaPending: boolean
}

export async function resolvePlatformSession(token: string): Promise<ResolvedPlatformSession> {
  const { rows } = await controlDb.query<{
    session_id: string; mfa_verified_at: Date | null
    id: string; email: string; full_name: string; status: string; mfa_secret: string | null
  }>(
    `SELECT s.id AS session_id, s.mfa_verified_at,
            u.id, u.email, u.full_name, u.status, u.mfa_secret
       FROM control_plane.platform_sessions s
       JOIN control_plane.platform_users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()`,
    [hashToken(token)])
  const row = rows[0]
  if (!row) throw new PlatformAuthError('INVALID_SESSION', 'sign in again')
  if (row.status !== 'active') throw new PlatformAuthError('INVALID_SESSION', 'sign in again')
  return {
    sessionId: row.session_id,
    mfaPending: row.mfa_verified_at === null,
    user: { id: row.id, email: row.email, full_name: row.full_name, status: row.status, mfa_enabled: row.mfa_secret !== null },
  }
}

/**
 * The gate every operator route goes through. A session whose second factor is
 * still pending opens nothing except the enrolment and verification routes.
 */
export async function requirePlatformSession(token: string | undefined): Promise<ResolvedPlatformSession> {
  if (!token) throw new PlatformAuthError('MISSING_TOKEN', 'sign in first')
  const session = await resolvePlatformSession(token)
  // Never enrolled at all. This used to leave the session fully open so the
  // operator could go and enrol -- which meant an operator who simply never
  // enrolled kept password-only access to every customer's payroll, for ever.
  // The console's UI pushed them into enrolment, but a UI is not a guard.
  //
  // The enrolment and verification routes do NOT come through here (they
  // resolve the session directly), so enrolling is still reachable; nothing
  // else is.
  if (!session.user.mfa_enabled) {
    throw new PlatformAuthError('MFA_ENROLMENT_REQUIRED', 'set up your second factor before using the console', 403)
  }
  if (session.mfaPending) {
    throw new PlatformAuthError('MFA_REQUIRED', 'verify your second factor to continue', 403)
  }
  return session
}

export async function revokePlatformSession(sessionId: string): Promise<void> {
  await controlDb.query(
    `UPDATE control_plane.platform_sessions SET revoked_at = now() WHERE id = $1`, [sessionId])
}

// ── second factor ────────────────────────────────────────────────────────────

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32Encode = (buf: Buffer): string => {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}
const base32Decode = (s: string): Buffer => {
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

/**
 * Starts enrolment: returns the secret to put in an authenticator.
 *
 * Three properties, each of which was missing:
 *
 *  - It REFUSES an account that already has a second factor. This route is
 *    reachable from a session that has cleared only the password (enrolling is
 *    what such a session is for), so if it could overwrite an enrolled secret,
 *    knowing a password would be enough to enrol your own authenticator and
 *    then "verify" with it. Replacing an enrolled factor is an operator reset
 *    from the shell, never a request.
 *  - It is IDEMPOTENT while enrolment is unfinished. Refreshing the page used
 *    to mint a new secret and strand the QR code already on the person's phone.
 *  - The secret is only PENDING. It becomes the account's second factor when a
 *    code proves it was scanned, so abandoning the page cannot enrol an account
 *    with a secret nobody holds.
 */
export async function beginPlatformMfa(userId: string, email: string): Promise<{ secret: string; otpauth: string }> {
  const candidate = base32Encode(randomBytes(20))
  // One statement, so two concurrent calls cannot each store a different secret:
  // coalesce keeps whichever pending secret won.
  const { rows } = await controlDb.query<{ mfa_pending_secret: string }>(
    `UPDATE control_plane.platform_users
        SET mfa_pending_secret = coalesce(mfa_pending_secret, $2)
      WHERE id = $1 AND mfa_secret IS NULL
      RETURNING mfa_pending_secret`, [userId, candidate])
  const secret = rows[0]?.mfa_pending_secret
  if (!secret) {
    await audit('platform.mfa.reenrol_refused', { email })
    throw new PlatformAuthError('MFA_ALREADY_ENROLLED',
      'a second factor is already set up for this account; ask another operator to reset it', 409)
  }
  if (secret === candidate) await audit('platform.mfa.enrolment_started', { email })
  return { secret, otpauth: `otpauth://totp/PEPL%20staff:${encodeURIComponent(email)}?secret=${secret}&issuer=PEPL` }
}

/**
 * Verifies a code and opens the session. Accepts one step either side for
 * clock drift. The first valid code on an unfinished enrolment also PROMOTES the
 * pending secret to the account's second factor -- that is what "enrolled"
 * means.
 */
export async function verifyPlatformMfa(args: { token: string; code: string }): Promise<void> {
  const session = await resolvePlatformSession(args.token)

  // Six digits, three accepted at a time: unlimited guesses from a session that
  // has cleared only the password is a brute force. The lock holds even for the
  // RIGHT code, or it would only slow the guessing down.
  const recent = await controlDb.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM control_plane.platform_audit
      WHERE action = 'platform.mfa.failed' AND detail->>'email' = $1
        AND occurred_at > now() - ($2 || ' minutes')::interval`, [session.user.email, LOCKOUT_MINUTES])
  if (Number(recent.rows[0]!.n) >= MAX_FAILED) {
    throw new PlatformAuthError('ACCOUNT_LOCKED',
      `too many wrong codes; try again in ${LOCKOUT_MINUTES} minutes`, 429)
  }

  const { rows } = await controlDb.query<{ mfa_secret: string | null; mfa_pending_secret: string | null }>(
    `SELECT mfa_secret, mfa_pending_secret FROM control_plane.platform_users WHERE id = $1`, [session.user.id])
  const enrolled = rows[0]?.mfa_secret ?? null
  const secret = enrolled ?? rows[0]?.mfa_pending_secret ?? null
  if (!secret) throw new PlatformAuthError('MFA_NOT_ENROLLED', 'set up your second factor first', 400)

  const key = base32Decode(secret)
  const code = args.code.replace(/\s/g, '')
  const s = stepAt()
  const matched = [s, s - 1, s + 1].some((candidate) => {
    const expected = totp(key, candidate)
    return expected.length === code.length &&
      timingSafeEqual(Buffer.from(expected), Buffer.from(code))
  })
  if (!matched) {
    await audit('platform.mfa.failed', { email: session.user.email })
    // 422, NOT 401. A wrong code is not an invalid session, and the console
    // treats every 401 as "sign in again": it wiped the token, sent the person
    // to the login page, and signing in again generated a fresh secret --
    // making every retry fail against a QR code that was already stale.
    throw new PlatformAuthError('MFA_CODE_INVALID',
      'that code is not right. Codes change every 30 seconds, so enter the one showing now.', 422)
  }

  if (enrolled === null) {
    // Promote only if the pending secret is still the one that just verified.
    const promoted = await controlDb.query(
      `UPDATE control_plane.platform_users
          SET mfa_secret = mfa_pending_secret, mfa_pending_secret = NULL
        WHERE id = $1 AND mfa_secret IS NULL AND mfa_pending_secret = $2`, [session.user.id, secret])
    if (!promoted.rowCount) throw new PlatformAuthError('MFA_NOT_ENROLLED', 'set-up changed underneath you; start again', 409)
    await audit('platform.mfa.enrolled', { email: session.user.email })
  }
  await controlDb.query(
    `UPDATE control_plane.platform_sessions SET mfa_verified_at = now() WHERE id = $1`, [session.sessionId])
  await audit('platform.mfa.verified', { email: session.user.email })
}

/**
 * Removes an operator's second factor so they can enrol a new one, and ends
 * every session they hold. Shell only -- there is deliberately no route for it,
 * because a route that can clear a second factor is a route that can bypass it.
 */
export async function resetPlatformMfa(email: string): Promise<void> {
  const { rowCount } = await controlDb.query(
    `UPDATE control_plane.platform_users SET mfa_secret = NULL, mfa_pending_secret = NULL
      WHERE lower(email) = lower($1)`, [email])
  if (!rowCount) throw new ControlPlaneError('NOT_FOUND', 'no such platform user')
  await controlDb.query(
    `UPDATE control_plane.platform_sessions s SET revoked_at = now()
       FROM control_plane.platform_users u
      WHERE s.user_id = u.id AND lower(u.email) = lower($1) AND s.revoked_at IS NULL`, [email])
  await audit('platform.mfa.reset', { email })
}
