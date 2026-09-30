/**
 * Authentication.
 *
 * Passwords: scrypt with a per-password salt, from node:crypto — no native
 * dependency, and a memory-hard KDF rather than a bare hash.
 *
 * Sessions: opaque random tokens, stored only as a SHA-256 hash. A database
 * leak must not yield usable sessions, and revocation has to be immediate —
 * which a self-contained JWT cannot offer before it expires.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import type { PoolClient } from 'pg'
import { appPool } from '../db/pool.ts'
// Only for the login company picker: a cross-tenant name lookup that the app
// role cannot and should not be able to make.
import { controlDb } from '../control-plane/index.ts'
import { buildContext, type AuthzContext, type RoleScope } from '../authz/permissions.ts'

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>

export class AuthError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 401) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'AuthError'
  }
}

const KEY_LEN = 64
const SESSION_DAYS = 30
// Long enough to read a two-line question and click, short enough that a token
// seen over someone's shoulder is worthless by the time it is used.
const CHOICE_MINUTES = 5
const MAX_FAILED = 8
const LOCKOUT_MINUTES = 15

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 10) {
    throw new AuthError('PASSWORD_TOO_SHORT', 'password must be at least 10 characters', 400)
  }
  const salt = randomBytes(16)
  const key = await scrypt(password, salt, KEY_LEN)
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$')
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false
  const expected = Buffer.from(keyB64, 'base64')
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length)
  // constant time: a length mismatch must not short-circuit differently
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

/**
 * A password that opened more than one company. No session exists yet and none
 * will until a company is named: a session belongs to exactly one tenant, and
 * that is the property everything else rests on.
 */
export interface CompanyChoice {
  choose: true
  choiceToken: string
  companies: Array<{ tenantId: string; name: string }>
}

export interface LoginResult {
  token: string
  expiresAt: Date
  tenantId: string
  userId: string
  roles: string[]
  /** True when the account has a second factor: the session is pending until POST /auth/mfa/verify. */
  mfaRequired: boolean
}

/**
 * What a sign-in request is allowed to be, and the ONE spelling of it that every
 * lockout counter, attempt log and lookup uses.
 *
 * The browser's route trimmed and lower-cased the address; the API's did neither, so
 * `Admin@Acme.test` and `admin@acme.test` had separate lockout budgets (five guesses
 * per capitalisation, per stray space), any body of any size was written into
 * login_attempts, and a non-string email surfaced as a 500. The password is NOT
 * trimmed: whitespace can be part of one, and a login must not quietly sign in as a
 * different password than the one the person chose.
 */
export function normaliseLogin(email: unknown, password: unknown): { email: string; password: string } {
  if (typeof email !== 'string' || typeof password !== 'string') {
    throw new AuthError('VALIDATION_FAILED', 'email and password must be text', 422)
  }
  const address = email.trim().toLowerCase()
  if (address.length === 0 || address.length > 254) {
    throw new AuthError('VALIDATION_FAILED', 'email must be an address of at most 254 characters', 422)
  }
  // 1024 is far past any real password and stops a request from making scrypt chew
  // on a megabyte.
  if (password.length === 0 || password.length > 1024) {
    throw new AuthError('VALIDATION_FAILED', 'password must be between 1 and 1024 characters', 422)
  }
  return { email: address, password }
}

/**
 * Login is deliberately tenant-agnostic at the front door: the caller supplies
 * an email, and the tenant is resolved from it. Accepting a tenant id from the
 * client would make it a guessing target.
 */
export async function login(args: {
  email: string
  password: string
  ip?: string
  userAgent?: string
}): Promise<LoginResult | CompanyChoice> {
  const { email, password } = normaliseLogin(args.email, args.password)
  const client = await appPool.connect()
  try {
    const recent = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM login_attempts
        WHERE email = $1 AND NOT succeeded
          AND attempted_at > now() - ($2 || ' minutes')::interval`,
      [email, LOCKOUT_MINUTES],
    )
    if ((recent.rows[0]?.n ?? 0) >= MAX_FAILED) {
      throw new AuthError('ACCOUNT_LOCKED',
        `too many failed attempts; try again in ${LOCKOUT_MINUTES} minutes`, 429)
    }

    // The lookup crosses tenants by necessity, so it runs as a narrow query on
    // the credential columns only — never a general read of tenant data.
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.bypass_reason', 'login_lookup', true)`)
    const { rows } = await client.query<{
      tenant_id: string; id: string; password_hash: string | null
      status: string; employee_id: string | null
    }>(
      `SELECT * FROM auth_user_by_email($1)`,
      [email],
    )
    await client.query('COMMIT')

    // One address can now belong to several companies, so the password is
    // checked against each of them and only the matches are ever acted on.
    // Nothing about an account reaches the caller unless they can already
    // authenticate as it.
    const matches: typeof rows = []
    for (const candidate of rows) {
      if (candidate.status !== 'active' || !candidate.password_hash) continue
      if (await verifyPassword(password, candidate.password_hash)) matches.push(candidate)
    }
    // Constant-ish work when the address is unknown, so response time does not
    // enumerate accounts.
    if (rows.length === 0) {
      await verifyPassword(password, await hashPassword('dummy-password-value'))
    }

    if (matches.length === 0) {
      await client.query(
        `INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, false)`,
        [email, args.ip ?? null],
      )
      // The same refusal whether the address is unknown, wrong-password, or
      // held in five companies. Anything more makes the form a directory.
      throw new AuthError('INVALID_CREDENTIALS', 'email or password is incorrect')
    }

    if (matches.length > 1) {
      const choiceToken = randomBytes(32).toString('base64url')
      // On the CONTROL connection, not the app one. `tenants` is RLS-protected
      // and there is no tenant context during a login, so the app role
      // correctly sees nothing — and widening that policy to fix a label would
      // trade the isolation model for a nicety. Reading names across tenants is
      // exactly what the control connection is for.
      const names = await controlDb.query<{ id: string; display_name: string }>(
        `SELECT id, display_name FROM tenants WHERE id = ANY($1::uuid[])`,
        [matches.map((m) => m.tenant_id)],
      )
      await client.query(
        `INSERT INTO login_choices (token_hash, email, candidates, expires_at)
         VALUES ($1, $2, $3::jsonb, now() + ($4 || ' minutes')::interval)`,
        [hashToken(choiceToken), email,
         JSON.stringify(matches.map((m) => ({ tenantId: m.tenant_id, userId: m.id }))),
         CHOICE_MINUTES],
      )
      // A successful authentication, even though no session exists yet — the
      // rate limiter must not count it as a failed attempt.
      await client.query(
        `INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, true)`,
        [email, args.ip ?? null],
      )
      return {
        choose: true,
        choiceToken,
        companies: matches.map((m) => ({
          tenantId: m.tenant_id,
          name: names.rows.find((n) => n.id === m.tenant_id)?.display_name ?? 'Company',
        })),
      }
    }

    const user = matches[0]!

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)

    const mfaRequired = (await client.query<{ on: boolean }>(`SELECT auth_mfa_enabled($1, $2) AS on`, [user.tenant_id, user.id])).rows[0]!.on
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [user.tenant_id])
    await client.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at, ip, user_agent, mfa_pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.tenant_id, user.id, hashToken(token), expiresAt, args.ip ?? null, args.userAgent ?? null, mfaRequired],
    )
    await client.query(
      `UPDATE app_users SET last_login_at = now() WHERE tenant_id = $1 AND id = $2`,
      [user.tenant_id, user.id],
    )
    const roleRows = await client.query<{ role: string }>(
      `SELECT role FROM user_roles WHERE user_id = $1`, [user.id],
    )
    await client.query('COMMIT')

    await client.query(
      `INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, $2, true)`,
      [email, args.ip ?? null],
    )

    return {
      token, expiresAt,
      tenantId: user.tenant_id,
      userId: user.id,
      roles: roleRows.rows.map((r) => r.role),
      mfaRequired,
    }
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
}

/**
 * Finish a login that opened more than one company.
 *
 * The token carries the accounts the password ACTUALLY matched, recorded when
 * it was proven. Naming any other company is refused — the choice is between
 * doors already unlocked, never a way to open a new one. Single use, so a token
 * glimpsed once cannot be replayed to pick a different company later.
 */
export async function completeCompanyChoice(args: {
  choiceToken: string
  tenantId: string
  ip?: string
  userAgent?: string
}): Promise<LoginResult> {
  const client = await appPool.connect()
  try {
    // Consume and read in one statement: two callers racing the same token must
    // not both get a session out of it.
    const { rows } = await client.query<{ email: string; candidates: Array<{ tenantId: string; userId: string }> }>(
      `UPDATE login_choices
          SET consumed_at = now()
        WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > now()
        RETURNING email, candidates`,
      [hashToken(args.choiceToken)],
    )
    const choice = rows[0]
    if (!choice) {
      throw new AuthError('INVALID_CREDENTIALS', 'that sign-in has expired; please start again')
    }

    const chosen = choice.candidates.find((c) => c.tenantId === args.tenantId)
    if (!chosen) {
      // The password never opened this company. Same refusal as a bad password:
      // confirming the company exists would be a disclosure in itself.
      throw new AuthError('INVALID_CREDENTIALS', 'that sign-in has expired; please start again')
    }

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000)
    const mfaRequired = (await client.query<{ on: boolean }>(
      `SELECT auth_mfa_enabled($1, $2) AS on`, [chosen.tenantId, chosen.userId])).rows[0]!.on

    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [chosen.tenantId])
    await client.query(
      `INSERT INTO sessions (tenant_id, user_id, token_hash, expires_at, ip, user_agent, mfa_pending)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [chosen.tenantId, chosen.userId, hashToken(token), expiresAt, args.ip ?? null, args.userAgent ?? null, mfaRequired],
    )
    await client.query(
      `UPDATE app_users SET last_login_at = now() WHERE tenant_id = $1 AND id = $2`,
      [chosen.tenantId, chosen.userId],
    )
    const roleRows = await client.query<{ role: string }>(
      `SELECT role FROM user_roles WHERE user_id = $1`, [chosen.userId],
    )
    await client.query('COMMIT')

    return {
      token, expiresAt,
      tenantId: chosen.tenantId,
      userId: chosen.userId,
      roles: roleRows.rows.map((r) => r.role),
      mfaRequired,
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}


export interface Session {
  tenantId: string
  userId: string
  sessionId: string
  /** The login has not yet passed the second factor. */
  mfaPending: boolean
  mfaVerifiedAt: Date | null
}

/** Resolves a bearer token to a session, or throws. Revocation is immediate. */
export async function resolveSession(token: string): Promise<Session> {
  const client = await appPool.connect()
  try {
    // An API key (pk_…) is a service user's standing credential: no MFA step,
    // no expiry beyond its own, revocable like a session. Everything after this
    // line — permissions, scope, module gates, audit — sees an ordinary user.
    if (token.startsWith('pk_')) {
      const { rows } = await client.query<{ tenant_id: string; user_id: string; id: string }>(`SELECT * FROM auth_api_key_by_hash($1)`, [hashToken(token)])
      const k = rows[0]
      if (!k) throw new AuthError('INVALID_SESSION', 'API key is invalid, expired or revoked')
      return { tenantId: k.tenant_id, userId: k.user_id, sessionId: `apikey:${k.id}`, mfaPending: false, mfaVerifiedAt: null }
    }
    const { rows } = await client.query<{ tenant_id: string; user_id: string; id: string; mfa_pending: boolean; mfa_verified_at: string | null }>(
      `SELECT * FROM auth_session_by_hash($1)`,
      [hashToken(token)],
    )
    const s = rows[0]
    if (!s) throw new AuthError('INVALID_SESSION', 'session is invalid or has expired')
    return { tenantId: s.tenant_id, userId: s.user_id, sessionId: s.id, mfaPending: s.mfa_pending, mfaVerifiedAt: s.mfa_verified_at ? new Date(s.mfa_verified_at) : null }
  } finally {
    client.release()
  }
}

export async function revokeSession(tx: PoolClient, sessionId: string): Promise<void> {
  await tx.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [sessionId])
}

/** Sign out everywhere — the real kill switch after a compromise or an exit. */
export async function revokeAllSessions(tx: PoolClient, userId: string): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  )
  return rowCount ?? 0
}

/**
 * Loads roles, custom roles and the manager's reports, then builds the context
 * every service call is checked against.
 */
export async function loadAuthzContext(
  tx: PoolClient,
  session: Pick<Session, 'tenantId' | 'userId' | 'sessionId'>,
): Promise<AuthzContext> {
  // Sequential: one PoolClient, one query at a time.
  const { rows: userRows } = await tx.query<{ employee_id: string | null }>(
    `SELECT employee_id FROM app_users WHERE id = $1`, [session.userId])
  const { rows: roleRows } = await tx.query<{ role: string }>(
    `SELECT role FROM user_roles WHERE user_id = $1`, [session.userId])
  const { rows: customRows } = await tx.query<{ permissions: string[]; data_scope: RoleScope; department_codes: string[] }>(
    `SELECT c.permissions, c.data_scope, c.department_codes
       FROM custom_roles c
       JOIN user_roles ur ON ur.role = c.name AND ur.tenant_id = c.tenant_id
      WHERE ur.user_id = $1 AND c.status = 'active'`, [session.userId])

  const employeeId = userRows[0]?.employee_id ?? undefined

  let reportIds: string[] = []
  if (employeeId) {
    const { rows } = await tx.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee_assignments
        WHERE manager_employee_id = $1 AND superseded_at IS NULL
          AND (effective_to IS NULL OR effective_to > CURRENT_DATE)`,
      [employeeId],
    )
    reportIds = rows.map((r) => r.employee_id)
  }
  // A department-scoped role sees everyone currently in those departments.
  const departments = [...new Set(customRows.filter((c) => c.data_scope === 'department').flatMap((c) => c.department_codes))]
  if (departments.length) {
    const { rows } = await tx.query<{ employee_id: string }>(
      `SELECT employee_id FROM employee_assignments
        WHERE department = ANY($1) AND superseded_at IS NULL
          AND (effective_to IS NULL OR effective_to > CURRENT_DATE)`, [departments])
    reportIds = [...new Set([...reportIds, ...rows.map((r) => r.employee_id)])]
  }

  return buildContext({
    tenantId: session.tenantId,
    userId: session.userId,
    employeeId,
    roles: roleRows.map((r) => r.role),
    customRoles: customRows,
    reportIds,
  })
}

export async function createUser(
  tx: PoolClient,
  args: { tenantId: string; email: string; fullName: string; password: string; roles: string[]; employeeId?: string },
): Promise<string> {
  const hash = await hashPassword(args.password)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO app_users (tenant_id, email, full_name, password_hash, employee_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id`,
    [args.tenantId, args.email, args.fullName, hash, args.employeeId ?? null],
  )
  const userId = rows[0]!.id
  for (const role of args.roles) {
    await tx.query(
      `INSERT INTO user_roles (tenant_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT DO NOTHING`,
      [args.tenantId, userId, role],
    )
  }
  return userId
}
