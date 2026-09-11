/**
 * Leave types and their policies — the part a company administers.
 *
 * Until now both were seeded on provisioning and never touched again: a tenant
 * could not add paternity leave, retire a type it does not use, or change how
 * fast earned leave accrues. That is the last piece of "the customer controls
 * their own company" that was still missing.
 *
 * A policy is never edited in place. A change is a NEW VERSION with an
 * effective date, and the previous version is closed on the day before. Ledger
 * entries written under version 3 stay defensible after version 4 exists,
 * which is the whole reason the table is versioned.
 */
import type { PoolClient } from 'pg'

export class LeavePolicyError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.code = code
    this.details = details
    this.name = 'LeavePolicyError'
  }
}

export type AccrualMethod = 'monthly' | 'yearly' | 'on_joining' | 'none'
export type MinUnit = 'full_day' | 'half_day' | 'hourly'

const ACCRUAL_METHODS: readonly AccrualMethod[] = ['monthly', 'yearly', 'on_joining', 'none']
const MIN_UNITS: readonly MinUnit[] = ['full_day', 'half_day', 'hourly']

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new LeavePolicyError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LeaveType {
  id: string
  code: string
  name: string
  is_paid: boolean
  affects_lop: boolean
  status: 'active' | 'retired'
}

export interface LeaveTypeWithPolicy extends LeaveType {
  policy: Policy | null
}

export interface Policy {
  id: string
  leave_type_id: string
  version: number
  accrual_method: AccrualMethod
  accrual_units_per_period: number
  max_balance: number | null
  carry_forward_limit: number
  encashable: boolean
  allow_negative_balance: boolean
  min_unit: MinUnit
  probation_allowed: boolean
  effective_from: string
  effective_to: string | null
}

const POLICY_COLUMNS = `
  id, leave_type_id, version, accrual_method,
  accrual_units_per_period::float8 AS accrual_units_per_period,
  max_balance::float8 AS max_balance,
  carry_forward_limit::float8 AS carry_forward_limit,
  encashable, allow_negative_balance, min_unit, probation_allowed,
  effective_from::text, effective_to::text`

/** Every type, with the policy in force on `asOf` (today by default). */
export async function listLeaveTypes(
  tx: PoolClient,
  opts: { includeRetired?: boolean; asOf?: string } = {},
): Promise<LeaveTypeWithPolicy[]> {
  const asOf = opts.asOf ?? new Date().toISOString().slice(0, 10)
  const { rows: types } = await tx.query<LeaveType>(
    `SELECT id, code, name, is_paid, affects_lop, status
       FROM leave_types
      WHERE $1 OR status = 'active'
      ORDER BY code`,
    [opts.includeRetired ?? false],
  )
  const { rows: policies } = await tx.query<Policy>(
    `SELECT ${POLICY_COLUMNS}
       FROM leave_policies
      WHERE effective_from <= $1::date
        AND (effective_to IS NULL OR effective_to >= $1::date)`,
    [asOf],
  )
  const byType = new Map(policies.map((p) => [p.leave_type_id, p]))
  return types.map((t) => ({ ...t, policy: byType.get(t.id) ?? null }))
}

/**
 * Adds a leave type.
 *
 * The code is the stable handle — it appears in ledger entries and on payslips
 * — so it is upper-cased, short, and cannot be changed afterwards. The name can.
 */
export async function createLeaveType(
  tx: PoolClient,
  args: { code: string; name: string; isPaid?: boolean; affectsLop?: boolean },
): Promise<LeaveType> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase()
  if (!/^[A-Z][A-Z0-9_]{0,11}$/.test(code)) {
    throw new LeavePolicyError('INVALID_LEAVE_CODE',
      'a leave code is 1-12 characters: letters, digits and underscore, starting with a letter')
  }
  const name = args.name.trim()
  if (!name || name.length > 80) {
    throw new LeavePolicyError('VALIDATION_FAILED', 'a leave type needs a name of 1-80 characters')
  }

  const { rows } = await tx.query<LeaveType>(
    `INSERT INTO leave_types (tenant_id, code, name, is_paid, affects_lop)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, code) DO NOTHING
     RETURNING id, code, name, is_paid, affects_lop, status`,
    [tid, code, name, args.isPaid ?? true, args.affectsLop ?? false],
  )
  if (!rows[0]) {
    throw new LeavePolicyError('LEAVE_TYPE_EXISTS', `a leave type with code ${code} already exists`)
  }
  return rows[0]
}

/** Renames a type or changes whether it is paid. The code stays. */
export async function updateLeaveType(
  tx: PoolClient,
  id: string,
  patch: { name?: string; isPaid?: boolean; affectsLop?: boolean },
): Promise<LeaveType> {
  if (patch.name !== undefined && (!patch.name.trim() || patch.name.length > 80)) {
    throw new LeavePolicyError('VALIDATION_FAILED', 'a leave type needs a name of 1-80 characters')
  }
  const { rows } = await tx.query<LeaveType>(
    `UPDATE leave_types
        SET name = COALESCE($2, name),
            is_paid = COALESCE($3, is_paid),
            affects_lop = COALESCE($4, affects_lop)
      WHERE id = $1
      RETURNING id, code, name, is_paid, affects_lop, status`,
    [id, patch.name?.trim() ?? null, patch.isPaid ?? null, patch.affectsLop ?? null],
  )
  if (!rows[0]) throw new LeavePolicyError('NOT_FOUND', 'no such leave type')
  return rows[0]
}

/**
 * Retires a type: no new requests, existing balances and history untouched.
 *
 * Deleting would orphan every ledger entry and request that references it.
 * Retirement is the only form of removal a leave type gets.
 */
export async function retireLeaveType(tx: PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE leave_types SET status = 'retired' WHERE id = $1 AND status = 'active'`, [id],
  )
  if (!rowCount) throw new LeavePolicyError('NOT_FOUND', 'no such active leave type')
}

export async function reinstateLeaveType(tx: PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query(
    `UPDATE leave_types SET status = 'active' WHERE id = $1 AND status = 'retired'`, [id],
  )
  if (!rowCount) throw new LeavePolicyError('NOT_FOUND', 'no such retired leave type')
}

// ---------------------------------------------------------------------------
// Policies
// ---------------------------------------------------------------------------

export interface PolicyInput {
  accrualMethod: AccrualMethod
  accrualUnitsPerPeriod: number
  maxBalance?: number | null
  carryForwardLimit?: number
  encashable?: boolean
  allowNegativeBalance?: boolean
  minUnit?: MinUnit
  probationAllowed?: boolean
  /** The first day the new rules apply. Must be today or later. */
  effectiveFrom: string
}

function validatePolicy(input: PolicyInput, today: string): void {
  if (!ACCRUAL_METHODS.includes(input.accrualMethod)) {
    throw new LeavePolicyError('VALIDATION_FAILED',
      `accrualMethod must be one of: ${ACCRUAL_METHODS.join(', ')}`)
  }
  if (input.minUnit && !MIN_UNITS.includes(input.minUnit)) {
    throw new LeavePolicyError('VALIDATION_FAILED', `minUnit must be one of: ${MIN_UNITS.join(', ')}`)
  }
  for (const [field, value] of [
    ['accrualUnitsPerPeriod', input.accrualUnitsPerPeriod],
    ['carryForwardLimit', input.carryForwardLimit ?? 0],
    ['maxBalance', input.maxBalance ?? 0],
  ] as const) {
    if (!Number.isFinite(value) || value < 0 || value > 999) {
      throw new LeavePolicyError('VALIDATION_FAILED', `${field} must be between 0 and 999`)
    }
  }
  if (input.accrualMethod === 'none' && input.accrualUnitsPerPeriod !== 0) {
    throw new LeavePolicyError('VALIDATION_FAILED',
      'a policy that does not accrue cannot have units per period')
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.effectiveFrom) || Number.isNaN(Date.parse(input.effectiveFrom))) {
    throw new LeavePolicyError('VALIDATION_FAILED', 'effectiveFrom must be a YYYY-MM-DD date')
  }
  // Backdating a policy would rewrite what past accruals should have been, and
  // the ledger entries already written under the old rules would disagree with
  // it. A change applies from a date that has not happened yet.
  if (input.effectiveFrom < today) {
    throw new LeavePolicyError('POLICY_NOT_BACKDATABLE',
      `a policy change applies from today or later, not ${input.effectiveFrom}`,
      { today })
  }
}

/**
 * Publishes a new policy version for a type.
 *
 * The version in force is closed on the day before the new one starts; a
 * version that had not yet begun is replaced outright, because two future
 * versions with overlapping windows is not a state anyone can reason about.
 */
export async function publishPolicy(
  tx: PoolClient,
  leaveTypeId: string,
  input: PolicyInput,
  opts: { today?: string } = {},
): Promise<Policy> {
  const tid = await tenantId(tx)
  const today = opts.today ?? new Date().toISOString().slice(0, 10)
  validatePolicy(input, today)

  const { rows: types } = await tx.query<{ status: string }>(
    `SELECT status FROM leave_types WHERE id = $1`, [leaveTypeId],
  )
  if (!types[0]) throw new LeavePolicyError('NOT_FOUND', 'no such leave type')
  if (types[0].status !== 'active') {
    throw new LeavePolicyError('LEAVE_TYPE_RETIRED', 'a retired leave type cannot take a new policy')
  }

  // A future version that has not started is superseded, not layered under.
  await tx.query(
    `DELETE FROM leave_policies
      WHERE leave_type_id = $1 AND effective_from >= $2::date`,
    [leaveTypeId, input.effectiveFrom],
  )

  // The version in force ends the day before the new one begins.
  await tx.query(
    `UPDATE leave_policies
        SET effective_to = ($2::date - 1)
      WHERE leave_type_id = $1
        AND (effective_to IS NULL OR effective_to >= $2::date)
        AND effective_from < $2::date`,
    [leaveTypeId, input.effectiveFrom],
  )

  const { rows: last } = await tx.query<{ v: number | null }>(
    `SELECT max(version) AS v FROM leave_policies WHERE leave_type_id = $1`, [leaveTypeId],
  )
  const version = (last[0]?.v ?? 0) + 1

  const { rows } = await tx.query<Policy>(
    `INSERT INTO leave_policies
       (tenant_id, leave_type_id, version, accrual_method, accrual_units_per_period,
        max_balance, carry_forward_limit, encashable, allow_negative_balance,
        min_unit, probation_allowed, effective_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING ${POLICY_COLUMNS}`,
    [
      tid, leaveTypeId, version, input.accrualMethod, input.accrualUnitsPerPeriod,
      input.maxBalance ?? null, input.carryForwardLimit ?? 0, input.encashable ?? false,
      input.allowNegativeBalance ?? false, input.minUnit ?? 'half_day',
      input.probationAllowed ?? false, input.effectiveFrom,
    ],
  )
  return rows[0]!
}

/** Every version a type has ever had, newest first. */
export async function policyHistory(tx: PoolClient, leaveTypeId: string): Promise<Policy[]> {
  const { rows } = await tx.query<Policy>(
    `SELECT ${POLICY_COLUMNS} FROM leave_policies
      WHERE leave_type_id = $1 ORDER BY version DESC`,
    [leaveTypeId],
  )
  return rows
}
