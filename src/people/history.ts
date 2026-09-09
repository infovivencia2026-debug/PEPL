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
  effectiveFrom: string
  reason?: string
  actorUserId?: string
}

export interface CompensationInput {
  employeeId: string
  annualCtcPaise: bigint | number
  components?: Record<string, number>
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

  const open = await tx.query<{ id: string; effective_from: string }>(
    `SELECT id, effective_from::text
       FROM employee_assignments
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
       (tenant_id, employee_id, department, designation, effective_from, changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [tid, input.employeeId, input.department, input.designation, input.effectiveFrom,
     input.actorUserId ?? null, input.reason ?? null],
  )
  return rows[0]!.id
}

/** A recording error: supersede the believed row, insert its replacement. */
export async function correctAssignment(
  tx: PoolClient,
  recordId: string,
  patch: { department?: string; designation?: string; reason: string; actorUserId?: string },
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

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employee_assignments
       (tenant_id, employee_id, department, designation, effective_from, effective_to,
        changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [tid, old.employee_id,
     patch.department ?? old.department,
     patch.designation ?? old.designation,
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
        changed_by_user_id, change_reason)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7)
     RETURNING id`,
    [tid, input.employeeId, String(input.annualCtcPaise),
     JSON.stringify(input.components ?? {}), input.effectiveFrom,
     input.actorUserId ?? null, input.reason ?? null],
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
