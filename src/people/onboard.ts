/**
 * The two things a person needs before HR can do anything with them in the
 * product: a bank account to be paid into, and a login to see it with.
 *
 * Both used to exist only in the demo seed. A bank account is effective-dated
 * and superseded, never edited, because the account a salary WENT to is a fact
 * about that payment. A login is created with a password nobody knows and a
 * one-time link the person sets their own with — the same path as "forgot my
 * password", so there is one way to prove an email, not two.
 */
import { randomBytes } from 'node:crypto'
import type { PoolClient } from 'pg'
import { createUser } from '../auth/index.ts'
import { issueResetToken } from '../auth/reset.ts'

export class OnboardError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'OnboardError' }
}

const tenantId = async (tx: PoolClient): Promise<string> => {
  const t = (await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')).rows[0]?.t
  if (!t) throw new OnboardError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

// ── bank accounts ────────────────────────────────────────────────────────────

export interface BankAccount {
  id: string
  beneficiary_name: string
  account_number: string
  /** Masked for display; the full number is only ever read by the bank file. */
  account_masked: string
  ifsc: string
  bank_name: string | null
  is_primary: boolean
  effective_from: string
  superseded_at: string | null
}

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/

export async function listBankAccounts(tx: PoolClient, employeeId: string, includeHistory = false): Promise<BankAccount[]> {
  const { rows } = await tx.query<BankAccount>(
    `SELECT id, beneficiary_name, account_number, ifsc, bank_name, is_primary, effective_from::text, superseded_at::text
       FROM employee_bank_accounts
      WHERE employee_id = $1 AND ($2 OR superseded_at IS NULL)
      ORDER BY superseded_at IS NOT NULL, effective_from DESC`, [employeeId, includeHistory])
  return rows.map((r) => ({ ...r, account_masked: mask(r.account_number) }))
}

export const mask = (n: string): string => (n.length <= 4 ? n : '•'.repeat(Math.min(n.length - 4, 8)) + n.slice(-4))

/**
 * Records the account salary goes to. The previous primary is superseded, not
 * deleted, so a bank file already generated still reconciles.
 */
export async function setBankAccount(
  tx: PoolClient,
  args: { employeeId: string; beneficiaryName: string; accountNumber: string; ifsc: string; bankName?: string | null; effectiveFrom?: string },
): Promise<BankAccount> {
  const tid = await tenantId(tx)
  const account = args.accountNumber.replace(/\s+/g, '')
  const ifsc = args.ifsc.trim().toUpperCase()
  if (!/^\d{9,18}$/.test(account)) throw new OnboardError('VALIDATION_FAILED', 'account number must be 9–18 digits')
  if (!IFSC.test(ifsc)) throw new OnboardError('VALIDATION_FAILED', 'IFSC must be 4 letters, 0, then 6 characters (e.g. HDFC0001234)')
  const name = args.beneficiaryName.trim()
  if (!name) throw new OnboardError('VALIDATION_FAILED', 'beneficiary name is required')

  const { rowCount } = await tx.query(`SELECT 1 FROM employees WHERE id = $1`, [args.employeeId])
  if (!rowCount) throw new OnboardError('NOT_FOUND', 'no such employee')

  await tx.query(
    `UPDATE employee_bank_accounts SET superseded_at = now(), is_primary = false
      WHERE employee_id = $1 AND superseded_at IS NULL`, [args.employeeId])
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employee_bank_accounts
       (tenant_id, employee_id, beneficiary_name, account_number, ifsc, bank_name, is_primary, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,true,$7) RETURNING id`,
    [tid, args.employeeId, name, account, ifsc, args.bankName?.trim() || null, args.effectiveFrom ?? new Date().toISOString().slice(0, 10)])
  return (await listBankAccounts(tx, args.employeeId)).find((a) => a.id === rows[0]!.id)!
}

// ── logins ───────────────────────────────────────────────────────────────────

export interface LoginStatus {
  user_id: string | null
  email: string | null
  status: string | null
  roles: string[]
  last_login_at: string | null
}

export async function loginFor(tx: PoolClient, employeeId: string): Promise<LoginStatus> {
  const { rows } = await tx.query<{ id: string; email: string; status: string; last_login_at: string | null }>(
    `SELECT id, email, status, last_login_at::text FROM app_users WHERE employee_id = $1 ORDER BY created_at LIMIT 1`, [employeeId])
  const u = rows[0]
  if (!u) return { user_id: null, email: null, status: null, roles: [], last_login_at: null }
  const roles = (await tx.query<{ role: string }>(`SELECT role FROM user_roles WHERE user_id = $1 ORDER BY role`, [u.id])).rows.map((r) => r.role)
  return { user_id: u.id, email: u.email, status: u.status, roles, last_login_at: u.last_login_at }
}

/**
 * Creates the person's login and a one-time link to set their password.
 * Idempotent on the employee: a second call for someone who already has a
 * login issues a fresh link (invalidating the old) rather than a second user.
 */
export async function inviteEmployee(
  tx: PoolClient,
  args: { employeeId: string; email: string; roles?: string[]; issuedByUserId: string; ip?: string },
): Promise<{ userId: string; email: string; token: string; expiresAt: Date; created: boolean }> {
  const tid = await tenantId(tx)
  const email = args.email.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new OnboardError('VALIDATION_FAILED', 'email must be an address')

  const emp = (await tx.query<{ first_name: string; last_name: string | null; status: string }>(
    `SELECT first_name, last_name, status FROM employees WHERE id = $1`, [args.employeeId])).rows[0]
  if (!emp) throw new OnboardError('NOT_FOUND', 'no such employee')
  if (emp.status === 'exited') throw new OnboardError('EMPLOYEE_EXITED', 'an exited employee cannot be given a login')

  const existing = await loginFor(tx, args.employeeId)
  let userId = existing.user_id
  let created = false
  if (!userId) {
    const taken = await tx.query(`SELECT 1 FROM app_users WHERE lower(email) = $1`, [email])
    if (taken.rowCount) throw new OnboardError('EMAIL_TAKEN', `${email} already belongs to another login in this company`)
    // A password nobody knows; the link below is how the person sets theirs.
    userId = await createUser(tx, {
      tenantId: tid, email, fullName: `${emp.first_name} ${emp.last_name ?? ''}`.trim(),
      password: randomBytes(24).toString('base64url'), roles: args.roles?.length ? args.roles : ['employee'],
      employeeId: args.employeeId,
    })
    created = true
  }
  const { token, expiresAt } = await issueResetToken(tx, { userId, issuedByUserId: args.issuedByUserId, ip: args.ip })
  return { userId, email: existing.email ?? email, token, expiresAt, created }
}
