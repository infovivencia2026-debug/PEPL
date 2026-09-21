/**
 * Effective-dated employment facts: the two operations that are NOT the same.
 *
 *   change()     — the fact changed in the world.  A promotion effective 1 Oct.
 *                  Closes the current row's effective_to and inserts a new one.
 *                  Both rows stay believed; the timeline shows a progression.
 *
 *   correct()    — the fact was recorded wrongly.  We typed 10L instead of 12L.
 *                  Sets superseded_at on the wrong row and inserts a replacement
 *                  with the SAME effective_from. The old row stays retrievable,
 *                  which is how a locked payroll run proves what it actually saw.
 *
 * Nothing is ever UPDATEd except to set superseded_at / effective_to, and nothing
 * is ever deleted.
 */
import type { PoolClient } from 'pg'
import { resolveUnitCode } from './org.ts'

export class HistoryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'HistoryError'
  }
}

export interface AssignmentInput {
  employeeId: string
  department: string
  designation: string
  /** undefined = keep the current manager; null = no manager (a CEO, a founder). */
  managerEmployeeId?: string | null
  /** undefined = keep; null = clear. Codes from the location / grade masters once they exist. */
  locationCode?: string | null
  gradeCode?: string | null
  effectiveFrom: string
  reason?: string
  actorUserId?: string
}

export interface CompensationInput {
  employeeId: string
  annualCtcPaise: bigint | number
  components?: Record<string, number>
  /** The structure the components were derived from, for the record. */
  structureCode?: string
  effectiveFrom: string
  reason?: string
  actorUserId?: string
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new HistoryError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

/** A real-world change: close the open row, then open a new one. */
export async function changeAssignment(tx: PoolClient, input: AssignmentInput): Promise<string> {
  const tid = await tenantId(tx)
  // Masters, once defined, are the only valid values; free text until then.
  input = {
    ...input,
    department: await resolveUnitCode(tx, 'department', input.department),
    designation: await resolveUnitCode(tx, 'designation', input.designation),
  }

  const open = await tx.query<{ id: string; effective_from: string; manager_employee_id: string | null; location_code: string | null; grade_code: string | null }>(
    `SELECT id, effective_from::text, manager_employee_id, location_code, grade_code
       FROM employee_assignments
      WHERE employee_id = $1 AND superseded_at IS NULL
        AND (effective_to IS NULL OR effective_to > $2)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [input.employeeId, input.effectiveFrom],
  )

  const prior = open.rows[0]
  const manager = input.managerEmployeeId === undefined ? (prior?.manager_employee_id ?? null) : input.managerEmployeeId
  await assertManager(tx, input.employeeId, manager)
  const location = input.locationCode === undefined ? (prior?.location_code ?? null)
    : input.locationCode ? await resolveUnitCode(tx, 'location', input.locationCode) : null
  const grade = input.gradeCode === undefined ? (prior?.grade_code ?? null)
    : input.gradeCode ? await resolveUnitCode(tx, 'grade', input.gradeCode) : null
  if (prior) {
    if (prior.effective_from >= input.effectiveFrom) {
      throw new HistoryError(
        'ASSIGNMENT_NOT_AFTER_CURRENT',
        `an assignment already starts on ${prior.effective_from}; a change must be dated after it, or use a correction`,
      )
    }
    await tx.query(
      `UPDATE employee_assignments SET effective_to = $1 WHERE tenant_id = $2 AND id = $3`,
      [input.effectiveFrom, tid, prior.id],
    )
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employee_assignments
       (tenant_id, employee_id, department, designation, manager_employee_id, location_code, grade_code, effective_from, changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [tid, input.employeeId, input.department, input.designation, manager, location, grade, input.effectiveFrom,
     input.actorUserId ?? null, input.reason ?? null],
  )
  return rows[0]!.id
}

/**
 * A manager must be a current, different employee — and not someone who
 * reports to this person, or the chain loops and every approval waits forever.
 */
async function assertManager(tx: PoolClient, employeeId: string, managerId: string | null): Promise<void> {
  if (!managerId) return
  if (managerId === employeeId) throw new HistoryError('MANAGER_IS_SELF', 'a person cannot be their own manager')
  const { rows } = await tx.query<{ status: string }>(`SELECT status FROM employees WHERE id = $1`, [managerId])
  if (!rows[0]) throw new HistoryError('MANAGER_NOT_FOUND', 'no such employee to be the manager')
  if (rows[0].status === 'exited') throw new HistoryError('MANAGER_EXITED', 'an exited employee cannot be a manager')
  // walk up from the proposed manager; meeting ourselves means a cycle
  const { rows: cycle } = await tx.query<{ found: boolean }>(
    `WITH RECURSIVE up AS (
       SELECT manager_employee_id AS id, 1 AS depth FROM employee_assignments
        WHERE employee_id = $1 AND superseded_at IS NULL AND (effective_to IS NULL OR effective_to > CURRENT_DATE)
       UNION ALL
       SELECT a.manager_employee_id, up.depth + 1 FROM up
         JOIN employee_assignments a ON a.employee_id = up.id AND a.superseded_at IS NULL
          AND (a.effective_to IS NULL OR a.effective_to > CURRENT_DATE)
        WHERE up.id IS NOT NULL AND up.depth < 50)
     SELECT EXISTS (SELECT 1 FROM up WHERE id = $2) AS found`, [managerId, employeeId])
  if (cycle[0]?.found) throw new HistoryError('MANAGER_CYCLE', 'that person reports to this employee; the chain would loop')
}

/** A recording error: supersede the believed row, insert its replacement. */
export async function correctAssignment(
  tx: PoolClient,
  recordId: string,
  patch: { department?: string; designation?: string; managerEmployeeId?: string | null; locationCode?: string | null; gradeCode?: string | null; reason: string; actorUserId?: string },
): Promise<string> {
  const tid = await tenantId(tx)
  if (!patch.reason?.trim()) {
    throw new HistoryError('CORRECTION_REASON_REQUIRED', 'a correction must say why the original was wrong')
  }

  const { rows: found } = await tx.query(
    `SELECT * FROM employee_assignments WHERE id = $1 AND superseded_at IS NULL`,
    [recordId],
  )
  const old = found[0]
  if (!old) throw new HistoryError('RECORD_NOT_FOUND', `no believed assignment ${recordId}`)

  // Supersede first: the exclusion constraint would otherwise reject the
  // replacement as an overlap with the row it replaces.
  await tx.query(
    `UPDATE employee_assignments SET superseded_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tid, recordId],
  )

  const manager = patch.managerEmployeeId === undefined ? old.manager_employee_id : patch.managerEmployeeId
  await assertManager(tx, old.employee_id, manager)
  const location = patch.locationCode === undefined ? old.location_code : patch.locationCode
  const grade = patch.gradeCode === undefined ? old.grade_code : patch.gradeCode
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employee_assignments
       (tenant_id, employee_id, department, designation, manager_employee_id, location_code, grade_code, effective_from, effective_to,
        changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [tid, old.employee_id,
     patch.department ?? old.department,
     patch.designation ?? old.designation,
     manager, location, grade,
     old.effective_from, old.effective_to,
     patch.actorUserId ?? null, patch.reason],
  )
  return rows[0]!.id
}

export async function changeCompensation(tx: PoolClient, input: CompensationInput): Promise<string> {
  const tid = await tenantId(tx)

  const open = await tx.query<{ id: string; effective_from: string }>(
    `SELECT id, effective_from::text
       FROM compensation_records
      WHERE employee_id = $1 AND superseded_at IS NULL
        AND (effective_to IS NULL OR effective_to > $2)
      ORDER BY effective_from DESC
      LIMIT 1`,
    [input.employeeId, input.effectiveFrom],
  )

  const prior = open.rows[0]
  if (prior) {
    if (prior.effective_from >= input.effectiveFrom) {
      throw new HistoryError(
        'COMPENSATION_NOT_AFTER_CURRENT',
        `compensation already starts on ${prior.effective_from}; a revision must be dated after it, or use a correction`,
      )
    }
    await tx.query(
      `UPDATE compensation_records SET effective_to = $1 WHERE tenant_id = $2 AND id = $3`,
      [input.effectiveFrom, tid, prior.id],
    )
  }

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO compensation_records
       (tenant_id, employee_id, annual_ctc_paise, components, effective_from,
        changed_by_user_id, change_reason, structure_code)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING id`,
    [tid, input.employeeId, String(input.annualCtcPaise),
     JSON.stringify(input.components ?? {}), input.effectiveFrom,
     input.actorUserId ?? null, input.reason ?? null, input.structureCode ?? null],
  )
  return rows[0]!.id
}

export async function correctCompensation(
  tx: PoolClient,
  recordId: string,
  patch: { annualCtcPaise?: bigint | number; components?: Record<string, number>; reason: string; actorUserId?: string },
): Promise<string> {
  const tid = await tenantId(tx)
  if (!patch.reason?.trim()) {
    throw new HistoryError('CORRECTION_REASON_REQUIRED', 'a correction must say why the original was wrong')
  }

  const { rows: found } = await tx.query(
    `SELECT * FROM compensation_records WHERE id = $1 AND superseded_at IS NULL`,
    [recordId],
  )
  const old = found[0]
  if (!old) throw new HistoryError('RECORD_NOT_FOUND', `no believed compensation record ${recordId}`)

  await tx.query(
    `UPDATE compensation_records SET superseded_at = now() WHERE tenant_id = $1 AND id = $2`,
    [tid, recordId],
  )

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO compensation_records
       (tenant_id, employee_id, annual_ctc_paise, components, effective_from, effective_to,
        changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
     RETURNING id`,
    [tid, old.employee_id,
     patch.annualCtcPaise === undefined ? old.annual_ctc_paise : String(patch.annualCtcPaise),
     JSON.stringify(patch.components ?? old.components),
     old.effective_from, old.effective_to,
     patch.actorUserId ?? null, patch.reason],
  )
  return rows[0]!.id
}

export interface ProfileAt {
  employee_id: string
  employee_number: string
  first_name: string
  last_name: string | null
  department: string | null
  designation: string | null
  annual_ctc_paise: string | null
  components: Record<string, number> | null
}

/**
 * "Who was Rahul's manager on 14 August?"           → profileAt(id, '2026-08-14')
 * "What did we BELIEVE his salary was at lock time?" → profileAt(id, '2026-08-31', run.lockedAt)
 */
export async function profileAt(
  tx: PoolClient,
  employeeId: string,
  asOfValid: string,
  asKnownAt?: Date | string,
): Promise<ProfileAt | undefined> {
  const { rows } = await tx.query<ProfileAt>(
    `SELECT * FROM employee_profile_at($1, $2::date, coalesce($3::timestamptz, now()))`,
    [employeeId, asOfValid, asKnownAt ?? null],
  )
  return rows[0]
}
