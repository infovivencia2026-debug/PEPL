/**
 * Changes held for approval — see 043_pending_changes.sql.
 *
 * `hold()` parks the intended write and raises the approval through the
 * policy layer. `settle()` runs after every decision: approved → the change
 * is applied through the SAME module function a direct write uses, so an
 * approved hike is exactly a hike; anything else → recorded, never applied.
 */
import type { PoolClient } from 'pg'
import { raiseWithPolicy } from './policy.ts'
import type { ChainCode } from './index.ts'
import { changeCompensation } from '../people/history.ts'
import { applyCorrection, type CorrectionAction, type CorrectionPolicy } from '../attendance/index.ts'

export type PendingKind = 'compensation' | 'attendance_correction'

export interface CompensationPayload {
  annualCtcPaise: number
  components?: Record<string, number>
  structureCode?: string
  effectiveFrom: string
  reason: string
}

export interface CorrectionPayload {
  workDate: string
  action: CorrectionAction
  after?: Record<string, unknown>
  reason: string
  policy?: CorrectionPolicy
  allowClosedPeriod?: boolean
}

export interface PendingChange {
  id: string
  entity_type: PendingKind
  subject_employee_id: string
  payload: CompensationPayload | CorrectionPayload
  approval_request_id: string
  requested_by_user_id: string
  status: 'pending' | 'applied' | 'rejected' | 'withdrawn'
  result: Record<string, unknown> | null
  applied_at: string | null
  created_at: string
}

const COLUMNS = 'id, entity_type, subject_employee_id, payload, approval_request_id, requested_by_user_id, status, result, applied_at::text, created_at::text'

export async function hold(
  tx: PoolClient,
  args: {
    kind: PendingKind; subjectEmployeeId: string; payload: CompensationPayload | CorrectionPayload
    requestedByUserId: string; title: string; magnitude?: number; fallback: ChainCode
  },
): Promise<{ pendingId: string; requestId: string; chainCode: ChainCode }> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const pendingId = crypto.randomUUID()
  const approval = await raiseWithPolicy(tx, {
    entityType: args.kind, entityId: pendingId, requestedByUserId: args.requestedByUserId,
    subjectEmployeeId: args.subjectEmployeeId, title: args.title, magnitude: args.magnitude, fallback: args.fallback,
  })
  await tx.query(
    `INSERT INTO pending_changes (tenant_id, id, entity_type, subject_employee_id, payload, approval_request_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`,
    [tid, pendingId, args.kind, args.subjectEmployeeId, JSON.stringify(args.payload), approval.requestId, args.requestedByUserId])
  // A chain with nobody to approve (skip-level routing) is approved on the spot.
  const { rows } = await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])
  if (rows[0]?.status === 'approved') await settle(tx, approval.requestId, args.requestedByUserId)
  return { pendingId, requestId: approval.requestId, chainCode: approval.chainCode }
}

/** Called after every approval decision. Idempotent: an already-settled change is left alone. */
export async function settle(tx: PoolClient, approvalRequestId: string, actorUserId: string): Promise<PendingChange | null> {
  const { rows } = await tx.query<PendingChange & { approval_status: string }>(
    `SELECT p.id, p.entity_type, p.subject_employee_id, p.payload, p.approval_request_id, p.requested_by_user_id,
            p.status, p.result, p.applied_at::text, p.created_at::text, r.status AS approval_status
       FROM pending_changes p JOIN approval_requests r ON (r.tenant_id, r.id) = (p.tenant_id, p.approval_request_id)
      WHERE p.approval_request_id = $1 AND p.status = 'pending'`, [approvalRequestId])
  const change = rows[0]
  if (!change) return null

  if (change.approval_status === 'rejected' || change.approval_status === 'withdrawn' || change.approval_status === 'cancelled') {
    const status = change.approval_status === 'rejected' ? 'rejected' : 'withdrawn'
    await tx.query(`UPDATE pending_changes SET status = $2 WHERE id = $1`, [change.id, status])
    return { ...change, status }
  }
  if (change.approval_status !== 'approved') return change   // still in flight

  let result: Record<string, unknown>
  if (change.entity_type === 'compensation') {
    const p = change.payload as CompensationPayload
    const recordId = await changeCompensation(tx, {
      employeeId: change.subject_employee_id, annualCtcPaise: p.annualCtcPaise, components: p.components,
      structureCode: p.structureCode, effectiveFrom: p.effectiveFrom, reason: p.reason, actorUserId: actorUserId,
    })
    result = { recordId }
  } else {
    const p = change.payload as CorrectionPayload
    const r = await applyCorrection(tx, {
      employeeId: change.subject_employee_id, workDate: p.workDate, action: p.action, after: p.after,
      reason: p.reason, actorUserId, allowClosedPeriod: p.allowClosedPeriod, policy: p.policy,
    })
    result = r as unknown as Record<string, unknown>
  }
  await tx.query(`UPDATE pending_changes SET status = 'applied', applied_at = now(), result = $2::jsonb WHERE id = $1`,
    [change.id, JSON.stringify(result)])
  return { ...change, status: 'applied', result }
}

export async function listPending(tx: PoolClient, opts: { employeeId?: string; status?: PendingChange['status'] } = {}): Promise<PendingChange[]> {
  const { rows } = await tx.query<PendingChange>(
    `SELECT ${COLUMNS} FROM pending_changes
      WHERE ($1::uuid IS NULL OR subject_employee_id = $1) AND ($2::text IS NULL OR status = $2)
      ORDER BY created_at DESC LIMIT 500`, [opts.employeeId ?? null, opts.status ?? null])
  return rows
}
