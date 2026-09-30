/**
 * TOTP second factor (RFC 6238, SHA-1, 30 s, 6 digits — what every
 * authenticator app expects), with hashed one-time recovery codes.
 *
 * Enrolment is two steps so a lost phone never locks anyone out: setup
 * stores a pending secret and returns the otpauth URI; enable verifies one
 * code from the app and only then turns MFA on and hands out the recovery
 * codes (shown once, stored hashed). A code is accepted once: the time step
 * it belonged to is remembered.
 */
import { appPool } from '../db/pool.ts'
import { createHmac, randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'

export class MfaError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 422) { super(message); this.code = code; this.status = status; this.name = 'MfaError' }
}

// Five wrong codes in fifteen minutes lock a person out of verifying. Six digits with
// three accepted per window is guessable at network speed from a session that has
// cleared only the password, and until now nothing counted the misses at all.
const MFA_MAX_FAILED = 5
const MFA_LOCKOUT_MINUTES = 15
/** Failures are stored in login_attempts under this key: a table with no tenant, on purpose. */
const attemptKey = (userId: string): string => `mfa:${userId}`

const STEP_SECONDS = 30
const DIGITS = 6
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function totp(secret: Buffer, step: number): string {
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(step))
  const h = createHmac('sha1', secret).update(counter).digest()
  const offset = h[h.length - 1]! & 0x0f
  const bin = ((h[offset]! & 0x7f) << 24) | (h[offset + 1]! << 16) | (h[offset + 2]! << 8) | h[offset + 3]!
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0')
}
export const stepAt = (now = Date.now()): number => Math.floor(now / 1000 / STEP_SECONDS)

/** Accepts the current step and one either side (clock drift), and never a step already used. */
function matchingStep(secret: Buffer, code: string, lastUsed: number | null, now = Date.now()): number | null {
  const s = stepAt(now)
  for (const candidate of [s, s - 1, s + 1]) {
    if (lastUsed !== null && candidate <= lastUsed) continue
    const expected = totp(secret, candidate)
    if (expected.length === code.length && timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return candidate
  }
  return null
}

const hashCode = (c: string): string => createHash('sha256').update(c.replace(/[\s-]/g, '').toUpperCase()).digest('hex')
const recoveryCode = (): string => { const raw = base32Encode(randomBytes(5)).slice(0, 8); return `${raw.slice(0, 4)}-${raw.slice(4)}` }

export interface MfaStatus { enabled: boolean; pendingSetup: boolean; recoveryCodesLeft: number; enabledAt: string | null }

export async function mfaStatus(tx: PoolClient, userId: string): Promise<MfaStatus> {
  const { rows } = await tx.query<{ enabled_at: string | null; n: number }>(`SELECT enabled_at::text, cardinality(recovery_hashes) AS n FROM user_mfa WHERE user_id = $1`, [userId])
  const r = rows[0]
  return { enabled: Boolean(r?.enabled_at), pendingSetup: Boolean(r) && !r!.enabled_at, recoveryCodesLeft: r?.n ?? 0, enabledAt: r?.enabled_at ?? null }
}

/** Step 1: a fresh secret (replacing any pending one), returned as an otpauth URI for the QR. */
export async function beginSetup(tx: PoolClient, args: { userId: string; email: string; issuer: string }): Promise<{ secret: string; otpauth: string }> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const existing = await mfaStatus(tx, args.userId)
  if (existing.enabled) throw new MfaError('MFA_ALREADY_ENABLED', 'MFA is already on; disable it before enrolling a new device', 409)
  const secret = randomBytes(20)
  await tx.query(`INSERT INTO user_mfa (tenant_id, user_id, secret) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET secret = EXCLUDED.secret, created_at = now()`, [tid, args.userId, secret])
  const b32 = base32Encode(secret)
  const label = encodeURIComponent(`${args.issuer}:${args.email}`)
  return { secret: b32, otpauth: `otpauth://totp/${label}?secret=${b32}&issuer=${encodeURIComponent(args.issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_SECONDS}` }
}

/** Step 2: prove the app has the secret; MFA turns on and the recovery codes are handed out once. */
export async function enable(tx: PoolClient, args: { userId: string; code: string; sessionId?: string }): Promise<{ recoveryCodes: string[] }> {
  const { rows } = await tx.query<{ secret: Buffer; enabled_at: string | null }>(`SELECT secret, enabled_at FROM user_mfa WHERE user_id = $1`, [args.userId])
  if (!rows[0]) throw new MfaError('MFA_NOT_SET_UP', 'start setup first', 409)
  if (rows[0].enabled_at) throw new MfaError('MFA_ALREADY_ENABLED', 'MFA is already on', 409)
  const step = matchingStep(rows[0].secret, String(args.code ?? '').trim(), null)
  if (step === null) throw new MfaError('MFA_CODE_INVALID', 'that code is not right; check the time on your phone and try the next one')
  const codes = Array.from({ length: 8 }, recoveryCode)
  await tx.query(`UPDATE user_mfa SET enabled_at = now(), recovery_hashes = $2::text[], last_used_step = $3 WHERE user_id = $1`, [args.userId, codes.map(hashCode), step])
  if (args.sessionId) await tx.query(`UPDATE sessions SET mfa_verified_at = now(), mfa_pending = false WHERE id = $1`, [args.sessionId])
  return { recoveryCodes: codes }
}

/** A login's second step, or a re-check before a sensitive action. Accepts a TOTP code or a recovery code (consumed). */
export async function verify(tx: PoolClient, args: { userId: string; sessionId: string; code: string }): Promise<{ method: 'totp' | 'recovery'; recoveryCodesLeft: number }> {
  const { rows } = await tx.query<{ secret: Buffer; enabled_at: string | null; recovery_hashes: string[]; last_used_step: string | null }>(
    `SELECT secret, enabled_at, recovery_hashes, last_used_step::text FROM user_mfa WHERE user_id = $1 FOR UPDATE`, [args.userId])
  const m = rows[0]
  if (!m?.enabled_at) throw new MfaError('MFA_NOT_ENABLED', 'this account has no second factor', 409)

  // AFTER the row lock above, deliberately. Parallel guesses queue on that lock, so each
  // one reads the count the previous one left; counted before it, a burst of requests
  // would all see zero failures and every one of them would get its guess.
  const recent = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM login_attempts
      WHERE email = $1 AND NOT succeeded AND attempted_at > now() - ($2 || ' minutes')::interval`,
    [attemptKey(args.userId), MFA_LOCKOUT_MINUTES])
  if ((recent.rows[0]?.n ?? 0) >= MFA_MAX_FAILED) {
    // Refused before the code is even looked at: a lock that lets the RIGHT code
    // through only slows the guessing down.
    throw new MfaError('ACCOUNT_LOCKED', `too many wrong codes; try again in ${MFA_LOCKOUT_MINUTES} minutes`, 429)
  }
  const code = String(args.code ?? '').trim()
  const step = /^\d{6}$/.test(code) ? matchingStep(m.secret, code, m.last_used_step === null ? null : Number(m.last_used_step)) : null
  if (step !== null) {
    await tx.query(`UPDATE user_mfa SET last_used_step = $2 WHERE user_id = $1`, [args.userId, step])
    await tx.query(`UPDATE sessions SET mfa_verified_at = now(), mfa_pending = false WHERE id = $1`, [args.sessionId])
    return { method: 'totp', recoveryCodesLeft: m.recovery_hashes.length }
  }
  const h = hashCode(code)
  const idx = m.recovery_hashes.findIndex((x) => x.length === h.length && timingSafeEqual(Buffer.from(x), Buffer.from(h)))
  if (idx < 0) {
    // Recorded on a SEPARATE connection. This runs inside the request's transaction and
    // the throw below rolls it back, so a counter written on `tx` would vanish with it
    // and the lock could never engage. Login records its own failures the same way.
    await appPool.query(
      `INSERT INTO login_attempts (email, ip, succeeded) VALUES ($1, NULL, false)`, [attemptKey(args.userId)])
    throw new MfaError('MFA_CODE_INVALID', 'that code is not right')
  }
  const left = m.recovery_hashes.filter((_, i) => i !== idx)
  await tx.query(`UPDATE user_mfa SET recovery_hashes = $2::text[] WHERE user_id = $1`, [args.userId, left])
  await tx.query(`UPDATE sessions SET mfa_verified_at = now(), mfa_pending = false WHERE id = $1`, [args.sessionId])
  return { method: 'recovery', recoveryCodesLeft: left.length }
}

/** Turning it off needs a current code (or recovery code): a stolen session cannot silently remove the factor. */
export async function disable(tx: PoolClient, args: { userId: string; sessionId: string; code: string }): Promise<void> {
  await verify(tx, args)
  await tx.query(`DELETE FROM user_mfa WHERE user_id = $1`, [args.userId])
}

/** HR reset for a lost phone: the factor is removed and every session signed out; the person enrols again at next login. */
export async function adminReset(tx: PoolClient, userId: string): Promise<void> {
  await tx.query(`DELETE FROM user_mfa WHERE user_id = $1`, [userId])
  await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId])
}

export const ADMIN_ROLES: ReadonlySet<string> = new Set(['org_admin', 'hr_admin', 'payroll_admin', 'finance'])
