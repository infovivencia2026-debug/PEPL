/**
 * One login form, two identity stores.
 *
 * Everyone — an employee, their HR admin, and a PEPL operator — types into the
 * same box. What they get back differs, and the difference is decided HERE, by
 * which store the address was found in. Nothing the browser sends influences
 * it: there is no `kind` in the request, and adding one would turn a display
 * hint into a privilege claim.
 *
 * The stores stay apart. This module routes; it does not merge. A platform
 * password still mints only a platform session (control_plane.platform_sessions)
 * and a customer password still mints only a tenant session (sessions), so a
 * token from one remains meaningless to the other — which is the property the
 * console's tests assert in both directions.
 *
 * Migration 095 is what makes the routing unambiguous: an address exists in one
 * store or the other, never both, enforced by triggers on each table.
 */
import { controlDb } from '../control-plane/index.ts'
import { platformLogin, type PlatformUser } from '../control-plane/platform-auth.ts'
import { login, normaliseLogin, type LoginResult, type CompanyChoice } from './index.ts'

export type UnifiedLogin =
  | { kind: 'platform'; token: string; expiresAt: Date; user: PlatformUser; mfaPending: boolean }
  | ({ kind: 'tenant' } & LoginResult)
  | ({ kind: 'choose' } & CompanyChoice)

/**
 * Existence only, on the control connection — the application pool has no
 * grant on this table. Both paths refuse with the same code and status, so
 * asking the question costs no disclosure: a wrong password looks identical
 * whichever store the address is in, and an address in neither looks identical
 * to both.
 */
async function isOperatorAddress(email: string): Promise<boolean> {
  const { rows } = await controlDb.query<{ yes: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM control_plane.platform_users WHERE lower(email) = lower($1)
     ) AS yes`, [email.trim()])
  return rows[0]!.yes
}

export async function unifiedLogin(input: {
  email: unknown; password: unknown; ip?: string; userAgent?: string
}): Promise<UnifiedLogin> {
  // Before the operator lookup as well: it runs on the raw address otherwise, so
  // the routing decision and the lockout counters would disagree about who this is.
  const args = { ...input, ...normaliseLogin(input.email, input.password) }
  if (await isOperatorAddress(args.email)) {
    const s = await platformLogin(args)
    return { kind: 'platform', token: s.token, expiresAt: s.expiresAt, user: s.user, mfaPending: s.mfaPending }
  }
  const result = await login(args)
  return 'choose' in result ? { kind: 'choose', ...result } : { kind: 'tenant', ...result }
}
