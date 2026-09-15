/**
 * Data-subject rights under the DPDP Act 2023: a copy, and erasure.
 *
 * EXPORT is a machine-readable bundle of every row about one person — the
 * profile, what they were paid, what they filed, where they punched in. It is
 * the person's own data, so the person gets all of it; a manager does not.
 *
 * ERASURE is anonymisation, not deletion. The payroll ledger — inputs, lines,
 * payslips, filings — must survive for the statutory retention period (eight
 * years for income-tax records), and deleting rows from a locked run is
 * prevented by trigger anyway. What goes is everything that identifies the
 * person: name, email, credentials, bank account, statutory numbers, tax
 * declarations, documents, coordinates, devices. The row ids stay so the
 * ledger still adds up; the person behind them becomes "Erased employee".
 *
 * Erasure is only offered once the retention clock has run
 * (`privacy.erasure_after_days` from the date of exit), because erasing a PAN
 * the 24Q still needs is a compliance failure dressed up as a privacy win.
 */
import type { PoolClient } from 'pg'
import { deleteDocument, listDocuments } from '../documents/index.ts'
import { revokeAllSessions } from '../auth/index.ts'

export class PrivacyError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PrivacyError'
  }
}

/** Table → the column that names the person. RLS scopes every one to the tenant. */
const BY_EMPLOYEE: Record<string, string> = {
  employees: 'id',
  employee_assignments: 'employee_id',
  compensation_records: 'employee_id',
  employee_bank_accounts: 'employee_id',
  employee_statutory_ids: 'employee_id',
  employee_separations: 'employee_id',
  tax_declarations: 'employee_id',
  attendance_punches: 'employee_id',
  daily_attendance: 'employee_id',
  attendance_corrections: 'employee_id',
  leave_requests: 'employee_id',
  leave_ledger: 'employee_id',
  comp_off_credits: 'employee_id',
  payroll_inputs: 'employee_id',
  payroll_lines: 'employee_id',
  payslips: 'employee_id',
  payment_instructions: 'employee_id',
  incentive_targets: 'employee_id',
  incentive_calculations: 'employee_id',
  sales_records: 'employee_id',
  approval_requests: 'subject_employee_id',
  tickets: 'subject_employee_id',
  tasks: 'subject_employee_id',
  audit_events: 'subject_employee_id',
}
const BY_USER: Record<string, string> = {
  app_users: 'id',
  user_roles: 'user_id',
  notifications: 'user_id',
  announcement_receipts: 'user_id',
  conversation_participants: 'user_id',
  mail_accounts: 'user_id',
  push_subscriptions: 'user_id',
  sessions: 'user_id',
}
/** Never exported: secrets, and a chat partner's words. */
const REDACT: Record<string, string[]> = {
  app_users: ['password_hash'],
  sessions: ['token_hash'],
  mail_accounts: ['secret_ciphertext'],
  employee_bank_accounts: [],
}

export interface ExportBundle {
  generatedAt: string
  employeeId: string
  userId: string | null
  tables: Record<string, Record<string, unknown>[]>
  documents: { id: string; file_name: string; content_type: string; size_bytes: number; created_at: string }[]
  messagesAuthored: number
}

export async function exportPersonalData(tx: PoolClient, employeeId: string): Promise<ExportBundle> {
  const { rows: users } = await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1`, [employeeId])
  const userId = users[0]?.id ?? null
  const tables: ExportBundle['tables'] = {}

  const dump = async (table: string, column: string, value: string): Promise<void> => {
    const { rows } = await tx.query<Record<string, unknown>>(`SELECT * FROM ${table} WHERE ${column} = $1`, [value])
    for (const col of REDACT[table] ?? []) for (const r of rows) delete r[col]
    if (rows.length) tables[table] = rows
  }
  for (const [table, column] of Object.entries(BY_EMPLOYEE)) await dump(table, column, employeeId)
  if (userId) for (const [table, column] of Object.entries(BY_USER)) await dump(table, column, userId)

  const documents = (await listDocuments(tx, { ownerType: 'employee', ownerId: employeeId, limit: 500 }))
    .map((d) => ({ id: d.id, file_name: d.file_name, content_type: d.content_type, size_bytes: d.size_bytes, created_at: d.created_at }))

  const messages = userId
    ? Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM messages WHERE sender_user_id = $1`, [userId])).rows[0]!.n)
    : 0

  return { generatedAt: new Date().toISOString(), employeeId, userId, tables, documents, messagesAuthored: messages }
}

export interface ErasureResult {
  employeeId: string
  userId: string | null
  anonymised: Record<string, number>
}

export async function eligibleForErasure(
  tx: PoolClient,
  employeeId: string,
  afterDays: number,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const { rows } = await tx.query<{ status: string; date_of_exit: string | null; erased_at: string | null }>(
    `SELECT status, date_of_exit::text, erased_at::text FROM employees WHERE id = $1`, [employeeId])
  const e = rows[0]
  if (!e) return { ok: false, reason: 'no such employee' }
  if (e.erased_at) return { ok: false, reason: 'already erased' }
  if (e.status !== 'exited' || !e.date_of_exit) return { ok: false, reason: 'the person has not left; erasure follows exit' }
  const eligibleOn = new Date(e.date_of_exit)
  eligibleOn.setDate(eligibleOn.getDate() + afterDays)
  if (eligibleOn > new Date()) {
    return { ok: false, reason: `statutory retention runs until ${eligibleOn.toISOString().slice(0, 10)}` }
  }
  return { ok: true }
}

/**
 * Anonymises in place. Idempotent: running it twice changes nothing more.
 * Every count is returned so the audit event says exactly what went.
 */
export async function erasePersonalData(
  tx: PoolClient,
  args: { employeeId: string; reason: string; actorUserId: string; afterDays: number },
): Promise<ErasureResult> {
  if (!args.reason.trim()) throw new PrivacyError('REASON_REQUIRED', 'erasure needs a reason on the record')
  const check = await eligibleForErasure(tx, args.employeeId, args.afterDays)
  if (!check.ok) throw new PrivacyError('NOT_ERASABLE', check.reason)

  const n: Record<string, number> = {}
  const count = async (label: string, sql: string, params: unknown[]): Promise<void> => {
    n[label] = (await tx.query(sql, params)).rowCount ?? 0
  }
  const { rows: users } = await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1`, [args.employeeId])
  const userId = users[0]?.id ?? null
  const short = args.employeeId.slice(0, 8)

  await count('employees', `UPDATE employees SET first_name = 'Erased', last_name = 'employee', erased_at = now() WHERE id = $1`, [args.employeeId])
  await count('employee_bank_accounts',
    `UPDATE employee_bank_accounts SET beneficiary_name = 'Erased', account_number = 'XXXX' || right(account_number, 4), superseded_at = coalesce(superseded_at, now())
      WHERE employee_id = $1`, [args.employeeId])
  await count('employee_statutory_ids',
    `UPDATE employee_statutory_ids SET uan = NULL, pf_member_id = NULL, esi_number = NULL, pan = NULL, updated_at = now() WHERE employee_id = $1`, [args.employeeId])
  await count('tax_declarations',
    `UPDATE tax_declarations SET declared = '{}'::jsonb, proof_document_ids = '{}', rejection_reason = NULL WHERE employee_id = $1`, [args.employeeId])
  await count('attendance_punches',
    `UPDATE attendance_punches SET geo_lat = NULL, geo_lng = NULL WHERE employee_id = $1 AND (geo_lat IS NOT NULL OR geo_lng IS NOT NULL)`, [args.employeeId])
  await count('employee_separations',
    `UPDATE employee_separations SET note = NULL, recoveries_note = NULL WHERE employee_id = $1`, [args.employeeId])

  const docs = await listDocuments(tx, { ownerType: 'employee', ownerId: args.employeeId, limit: 500 })
  for (const d of docs) await deleteDocument(tx, d.id, `erasure: ${args.reason}`)
  n.documents = docs.length

  if (userId) {
    await revokeAllSessions(tx, userId)
    await count('app_users',
      `UPDATE app_users SET email = 'erased-' || $2 || '@invalid.local', full_name = 'Erased employee', password_hash = NULL, status = 'erased' WHERE id = $1`,
      [userId, short])
    await count('user_roles', `DELETE FROM user_roles WHERE user_id = $1`, [userId])
    await count('push_subscriptions', `DELETE FROM push_subscriptions WHERE user_id = $1`, [userId])
    await count('notifications', `DELETE FROM notifications WHERE user_id = $1`, [userId])
    await count('password_resets', `UPDATE password_resets SET used_at = coalesce(used_at, now()) WHERE user_id = $1`, [userId])
    await count('mail_accounts',
      `UPDATE mail_accounts SET secret_ciphertext = NULL, status = 'disconnected', display_name = 'Erased employee' WHERE user_id = $1`, [userId])
  }
  return { employeeId: args.employeeId, userId, anonymised: n }
}
