/**
 * The employee master beyond name and joining date, and the one thing every
 * scoped rule needs: which department, location and grade a person is in
 * TODAY, so a setting overridden for "Hyderabad" or "Grade M3" actually
 * applies to them.
 */
import type { PoolClient } from 'pg'
import type { Scope } from '../config/resolver.ts'

export class ProfileError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ProfileError' }
}

export interface EmployeePatch {
  firstName?: string
  lastName?: string | null
  dateOfJoining?: string
  dateOfBirth?: string | null
  gender?: 'female' | 'male' | 'other' | 'undisclosed' | null
  personalEmail?: string | null
  workEmail?: string | null
  phone?: string | null
  address?: Record<string, string> | null
  emergencyContact?: Record<string, string> | null
  employmentType?: 'permanent' | 'probation' | 'contract' | 'intern' | 'consultant' | 'part_time'
  probationEnd?: string | null
  confirmedOn?: string | null
  noticePeriodDays?: number
  costCentre?: string | null
  pfApplicable?: boolean
  esiApplicable?: boolean
  customFields?: Record<string, unknown>
}

/** Which fields a person may change about themselves. Everything else is HR. */
export const SELF_EDITABLE: (keyof EmployeePatch)[] = ['personalEmail', 'phone', 'address', 'emergencyContact']

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const COLUMN: Record<Exclude<keyof EmployeePatch, 'customFields'>, string> = {
  firstName: 'first_name', lastName: 'last_name', dateOfJoining: 'date_of_joining', dateOfBirth: 'date_of_birth',
  gender: 'gender', personalEmail: 'personal_email', workEmail: 'work_email', phone: 'phone', address: 'address',
  emergencyContact: 'emergency_contact', employmentType: 'employment_type', probationEnd: 'probation_end',
  confirmedOn: 'confirmed_on', noticePeriodDays: 'notice_period_days', costCentre: 'cost_centre',
  pfApplicable: 'pf_applicable', esiApplicable: 'esi_applicable',
}

/**
 * Corrects or completes the record. Returns what changed (before/after) for
 * the audit row; an empty patch is a no-op, not an error.
 */
export async function updateEmployee(
  tx: PoolClient, employeeId: string, patch: EmployeePatch,
): Promise<{ changed: Record<string, { before: unknown; after: unknown }> }> {
  if (patch.firstName !== undefined && !patch.firstName.trim()) throw new ProfileError('VALIDATION_FAILED', 'first name cannot be blank')
  for (const k of ['personalEmail', 'workEmail'] as const) {
    if (patch[k] && !EMAIL.test(patch[k]!)) throw new ProfileError('VALIDATION_FAILED', `${k} must be an email address`)
  }
  if (patch.phone && !/^\+?[\d\s-]{8,15}$/.test(patch.phone)) throw new ProfileError('VALIDATION_FAILED', 'phone must be 8–15 digits')
  if (patch.noticePeriodDays !== undefined && (!Number.isInteger(patch.noticePeriodDays) || patch.noticePeriodDays < 0 || patch.noticePeriodDays > 365)) {
    throw new ProfileError('VALIDATION_FAILED', 'notice period must be 0–365 days')
  }
  if (patch.dateOfBirth) {
    const age = (Date.now() - Date.parse(patch.dateOfBirth)) / (365.25 * 86_400_000)
    if (age < 14 || age > 100) throw new ProfileError('VALIDATION_FAILED', 'date of birth gives an age outside 14–100')
  }
  if (patch.customFields) await checkCustomFields(tx, patch.customFields)

  const { rows } = await tx.query<Record<string, unknown>>(`SELECT * FROM employees WHERE id = $1`, [employeeId])
  const before = rows[0]
  if (!before) throw new ProfileError('NOT_FOUND', 'no such employee')

  const sets: string[] = []
  const params: unknown[] = [employeeId]
  const changed: Record<string, { before: unknown; after: unknown }> = {}
  for (const [key, value] of Object.entries(patch) as [keyof EmployeePatch, unknown][]) {
    if (value === undefined) continue
    if (key === 'customFields') {
      const merged = { ...(before.custom_fields as Record<string, unknown>), ...(value as Record<string, unknown>) }
      params.push(JSON.stringify(merged)); sets.push(`custom_fields = $${params.length}::jsonb`)
      changed.customFields = { before: before.custom_fields, after: merged }
      continue
    }
    const col = COLUMN[key]
    const next = typeof value === 'string' ? value.trim() || null : value
    const cur = before[col]
    const same = typeof next === 'object' ? JSON.stringify(next) === JSON.stringify(cur) : String(next ?? '') === String(cur ?? '')
    if (same) continue
    params.push(typeof next === 'object' && next !== null ? JSON.stringify(next) : next)
    sets.push(`${col} = $${params.length}${typeof next === 'object' && next !== null ? '::jsonb' : ''}`)
    changed[key] = { before: cur, after: next }
  }
  if (!sets.length) return { changed }
  // Pre-check rather than catch the unique violation: a caught constraint
  // error still aborts the caller's transaction. The index stays as the race guard.
  if (changed.workEmail?.after) {
    const taken = await tx.query(`SELECT 1 FROM employees WHERE lower(work_email) = lower($1) AND id <> $2`, [changed.workEmail.after, employeeId])
    if (taken.rowCount) throw new ProfileError('WORK_EMAIL_TAKEN', 'another employee already has that work email')
  }
  sets.push('updated_at = now()')
  await tx.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $1`, params)
  return { changed }
}

// ── custom fields ────────────────────────────────────────────────────────────

export interface FieldDefinition {
  id: string; key: string; label: string; kind: string; options: string[]; required: boolean; self_editable: boolean; sort_order: number; status: string
}

export async function listFieldDefinitions(tx: PoolClient, includeRetired = false): Promise<FieldDefinition[]> {
  const { rows } = await tx.query<FieldDefinition>(
    `SELECT id, key, label, kind, options, required, self_editable, sort_order, status
       FROM employee_field_definitions WHERE $1 OR status = 'active' ORDER BY sort_order, label`, [includeRetired])
  return rows
}

export async function defineField(
  tx: PoolClient, args: { key: string; label: string; kind: FieldDefinition['kind']; options?: string[]; required?: boolean; selfEditable?: boolean; sortOrder?: number },
): Promise<FieldDefinition> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if (!/^[a-z][a-z0-9_]{1,39}$/.test(args.key)) throw new ProfileError('VALIDATION_FAILED', 'key must be snake_case, 2–40 characters')
  if (!['text', 'number', 'date', 'boolean', 'select'].includes(args.kind)) throw new ProfileError('VALIDATION_FAILED', 'kind must be text, number, date, boolean or select')
  if (args.kind === 'select' && !(args.options?.length)) throw new ProfileError('VALIDATION_FAILED', 'a select field needs options')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employee_field_definitions (tenant_id, key, label, kind, options, required, self_editable, sort_order)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)
     ON CONFLICT (tenant_id, key) DO UPDATE SET label = EXCLUDED.label, kind = EXCLUDED.kind, options = EXCLUDED.options,
       required = EXCLUDED.required, self_editable = EXCLUDED.self_editable, sort_order = EXCLUDED.sort_order, status = 'active'
     RETURNING id`,
    [tid, args.key, args.label.trim().slice(0, 80), args.kind, JSON.stringify(args.options ?? []), args.required ?? false, args.selfEditable ?? false, args.sortOrder ?? 0])
  return (await listFieldDefinitions(tx, true)).find((f) => f.id === rows[0]!.id)!
}

export async function retireField(tx: PoolClient, key: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE employee_field_definitions SET status = 'retired' WHERE key = $1 AND status = 'active'`, [key])
  if (!rowCount) throw new ProfileError('NOT_FOUND', 'no such active field')
}

async function checkCustomFields(tx: PoolClient, values: Record<string, unknown>): Promise<void> {
  const defs = new Map((await listFieldDefinitions(tx)).map((d) => [d.key, d]))
  for (const [key, value] of Object.entries(values)) {
    const d = defs.get(key)
    if (!d) throw new ProfileError('UNKNOWN_FIELD', `no such custom field: ${key}`)
    if (value === null || value === undefined || value === '') continue
    const bad = (why: string): never => { throw new ProfileError('VALIDATION_FAILED', `${d.label}: ${why}`) }
    switch (d.kind) {
      case 'number': if (typeof value !== 'number' || !Number.isFinite(value)) bad('must be a number'); break
      case 'boolean': if (typeof value !== 'boolean') bad('must be true or false'); break
      case 'date': if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad('must be a date (YYYY-MM-DD)'); break
      case 'select': if (!d.options.includes(String(value))) bad(`must be one of ${d.options.join(', ')}`); break
      default: if (typeof value !== 'string' || value.length > 500) bad('must be text up to 500 characters')
    }
  }
}

// ── scope ────────────────────────────────────────────────────────────────────

export interface Posting {
  department: string | null
  designation: string | null
  location_code: string | null
  grade_code: string | null
  manager_employee_id: string | null
}

/** The current posting; null when the person has no assignment yet. */
export async function currentPosting(tx: PoolClient, employeeId: string, asOf?: string): Promise<Posting | null> {
  const { rows } = await tx.query<Posting>(
    `SELECT department, designation, location_code, grade_code, manager_employee_id
       FROM employee_assignments
      WHERE employee_id = $1 AND superseded_at IS NULL
        AND effective_from <= coalesce($2::date, CURRENT_DATE) AND (effective_to IS NULL OR effective_to > coalesce($2::date, CURRENT_DATE))
      ORDER BY effective_from DESC LIMIT 1`, [employeeId, asOf ?? null])
  return rows[0] ?? null
}

/**
 * The scope a setting override is matched against for this person. Overrides
 * are keyed by the org unit's ID; the posting carries codes, so each code is
 * resolved to its master row. A code with no master (free text before the
 * masters existed) simply cannot be targeted by an override.
 */
export async function scopeFor(tx: PoolClient, employeeId: string, asOf?: string): Promise<Scope> {
  const p = await currentPosting(tx, employeeId, asOf)
  if (!p) return {}
  const wanted: [keyof Scope, string, string | null][] = [
    ['department', 'department', p.department], ['location', 'location', p.location_code], ['grade', 'grade', p.grade_code],
  ]
  const scope: Scope = {}
  for (const [dim, kind, code] of wanted) {
    if (!code) continue
    const { rows } = await tx.query<{ id: string }>(`SELECT id FROM org_units WHERE kind = $1 AND upper(code) = upper($2) LIMIT 1`, [kind, code])
    if (rows[0]) scope[dim] = rows[0].id
  }
  return scope
}

/** A location's state, from the org master's attributes — what professional tax is levied by. */
export async function stateOfLocation(tx: PoolClient, locationCode: string | null): Promise<string | null> {
  if (!locationCode) return null
  const { rows } = await tx.query<{ state: string | null }>(
    `SELECT attributes->>'stateCode' AS state FROM org_units WHERE kind = 'location' AND code = $1`, [locationCode])
  return rows[0]?.state?.toUpperCase() || null
}
