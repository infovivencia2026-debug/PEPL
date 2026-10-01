/**
 * One approval mechanism for every module.
 *
 * Chains are COMPOSED from a fixed step vocabulary, not drawn on a canvas. A
 * tenant chooses which chain applies per module and per scope; it does not write
 * conditional logic with computed variables — that is a programming language, and
 * shipping one before observing twenty real tenants produces the wrong language.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { resolveConfig } from '../config/resolver.ts'

export class ApprovalError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ApprovalError'
  }
}

export type StepRole = 'manager' | 'dept_head' | 'hr' | 'finance'
export type ChainCode = 'manager' | 'manager_then_hr' | 'hr_only' | 'manager_hr_finance' | 'manager_dept_head' | 'dept_head_hr'

/** The fixed vocabulary. Adding a chain is a code review, not a customer drawing. */
export const CHAINS: Readonly<Record<ChainCode, readonly StepRole[]>> = Object.freeze({
  manager: ['manager'],
  manager_then_hr: ['manager', 'hr'],
  hr_only: ['hr'],
  manager_hr_finance: ['manager', 'hr', 'finance'],
  manager_dept_head: ['manager', 'dept_head'],
  dept_head_hr: ['dept_head', 'hr'],
})

export type ActionKind = 'approve' | 'reject' | 'send_back' | 'comment' | 'delegate' | 'withdraw'

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new ApprovalError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

export interface RaiseInput {
  entityType: string
  entityId: string
  requestedByUserId: string
  subjectEmployeeId?: string
  chainCode: ChainCode
  title: string
  /** Resolved approver for each role in the chain. */
  approvers: Partial<Record<StepRole, string>>
}

/**
 * Skip-level routing: a step whose approver is the requester, or has no resolved
 * approver, is SKIPPED rather than deadlocking the request. A chain that cannot
 * be satisfied is a stuck request nobody can clear.
 */
export async function raise(tx: PoolClient, input: RaiseInput): Promise<string> {
  const tid = await tenantId(tx)
  const roles = CHAINS[input.chainCode]
  if (!roles) throw new ApprovalError('UNKNOWN_CHAIN', `no chain "${input.chainCode}"`)

  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO approval_requests
       (tenant_id, entity_type, entity_id, requested_by_user_id, subject_employee_id,
        chain_code, title)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     RETURNING id`,
    [tid, input.entityType, input.entityId, input.requestedByUserId,
     input.subjectEmployeeId ?? null, input.chainCode, input.title],
  )
  const requestId = rows[0]!.id

  // A step with nobody to approve it — no manager on record, or the requester
  // is their own approver — used to be skipped, and a chain of skipped steps
  // auto-approved. The default now routes such a step to an HR admin (never
  // the requester); auto-approve is a deliberate setting.
  const fallback = (await resolveConfig(tx, tid)).get<string>('approvals.no_approver_fallback')
  const hrFallback = fallback === 'route_to_hr'
    ? (await tx.query<{ user_id: string }>(
        `SELECT r.user_id FROM user_roles r JOIN app_users u ON u.id = r.user_id AND u.status = 'active'
          WHERE r.role IN ('hr_admin', 'org_admin') AND r.user_id <> $1
          ORDER BY CASE r.role WHEN 'hr_admin' THEN 0 ELSE 1 END, r.user_id LIMIT 1`, [input.requestedByUserId])).rows[0]?.user_id
    : undefined

  let stepNo = 0
  for (const role of roles) {
    stepNo++
    let approver = input.approvers[role]
    let routedToHr = false
    if ((!approver || approver === input.requestedByUserId) && hrFallback) { approver = hrFallback; routedToHr = true }
    const skip = !approver || approver === input.requestedByUserId
    await tx.query(
      `INSERT INTO approval_steps
         (tenant_id, approval_request_id, step_no, approver_user_id, approver_role, status, decided_at, routed_to_hr)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tid, requestId, stepNo, approver ?? null, role,
       skip ? 'skipped' : 'pending', skip ? new Date() : null, routedToHr],
    )
  }

  await advance(tx, requestId)
  return requestId
}

/** Moves current_step past any skipped steps, closing the request if none remain. */
async function advance(tx: PoolClient, requestId: string): Promise<void> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ step_no: number }>(
    `SELECT step_no FROM approval_steps
      WHERE approval_request_id = $1 AND status = 'pending'
      ORDER BY step_no LIMIT 1`,
    [requestId],
  )
  const next = rows[0]?.step_no
  if (next === undefined) {
    await tx.query(
      `UPDATE approval_requests SET status = 'approved', closed_at = now()
        WHERE tenant_id = $1 AND id = $2 AND status = 'pending'`,
      [tid, requestId],
    )
    return
  }
  await tx.query(
    `UPDATE approval_requests SET current_step = $3 WHERE tenant_id = $1 AND id = $2`,
    [tid, requestId, next],
  )
  // The person whose turn it is finds out. Deduped per (request, step) so a
  // send-back and resubmit does not ping them twice for the same step.
  const { rows: who } = await tx.query<{ approver_user_id: string | null; title: string; entity_type: string; delegated_from_user_id: string | null }>(
    `SELECT s.approver_user_id, r.title, r.entity_type, s.delegated_from_user_id
       FROM approval_steps s JOIN approval_requests r ON (r.tenant_id, r.id) = (s.tenant_id, s.approval_request_id)
      WHERE s.approval_request_id = $1 AND s.step_no = $2`, [requestId, next])
  const step = who[0]
  if (step?.approver_user_id) {
    await notify(tx, {
      userId: step.approver_user_id, eventType: 'approval.requested',
      title: `Approval needed: ${step.title}`,
      body: step.delegated_from_user_id ? 'Routed to you as a delegate.' : undefined,
      entityType: 'approval_request', entityId: requestId,
      channels: ['in_app', 'email'], dedupeKey: `approval:${requestId}:step:${next}`,
    })
  }
}

/** The requester learns of every decision, once per decision. */
async function notifyRequester(tx: PoolClient, requestId: string, outcome: string, actorUserId: string): Promise<void> {
  const { rows } = await tx.query<{ requested_by_user_id: string; title: string }>(
    `SELECT requested_by_user_id, title FROM approval_requests WHERE id = $1`, [requestId])
  const r = rows[0]
  if (!r || r.requested_by_user_id === actorUserId) return
  const verb = outcome === 'approved' ? 'approved' : outcome === 'rejected' ? 'rejected' : outcome === 'sent_back' ? 'sent back for changes' : outcome
  await notify(tx, {
    userId: r.requested_by_user_id, eventType: `approval.${outcome}`,
    title: `${r.title} — ${verb}`, entityType: 'approval_request', entityId: requestId,
    channels: ['in_app', 'email'], dedupeKey: `approval:${requestId}:${outcome}:${Date.now()}`,
  })
}

export interface ActResult {
  status: string
  currentStep: number
  changed: boolean
}

export async function act(
  tx: PoolClient,
  args: { requestId: string; actorUserId: string; action: ActionKind; comment?: string },
): Promise<ActResult> {
  const tid = await tenantId(tx)

  const { rows: reqRows } = await tx.query<{ status: string; current_step: number; requested_by_user_id: string }>(
    `SELECT status, current_step, requested_by_user_id FROM approval_requests WHERE id = $1`,
    [args.requestId],
  )
  const req = reqRows[0]
  if (!req) throw new ApprovalError('NOT_FOUND', 'no such approval request')

  // Idempotent: acting on a closed request is a no-op, not a double decision.
  if (req.status !== 'pending' && req.status !== 'sent_back') {
    return { status: req.status, currentStep: req.current_step, changed: false }
  }

  if (args.action === 'comment') {
    await logAction(tx, tid, args, req.current_step)
    return { status: req.status, currentStep: req.current_step, changed: false }
  }

  if (args.action === 'withdraw') {
    if (args.actorUserId !== req.requested_by_user_id) {
      throw new ApprovalError('NOT_REQUESTER', 'only the requester may withdraw')
    }
    await logAction(tx, tid, args, req.current_step)
    await tx.query(
      `UPDATE approval_requests SET status = 'withdrawn', closed_at = now() WHERE tenant_id = $1 AND id = $2`,
      [tid, args.requestId],
    )
    return { status: 'withdrawn', currentStep: req.current_step, changed: true }
  }

  const { rows: stepRows } = await tx.query<{ approver_user_id: string | null }>(
    `SELECT approver_user_id FROM approval_steps
      WHERE approval_request_id = $1 AND step_no = $2 AND status = 'pending'`,
    [args.requestId, req.current_step],
  )
  const step = stepRows[0]
  if (!step) throw new ApprovalError('NO_PENDING_STEP', 'no pending step to act on')
  if (step.approver_user_id && step.approver_user_id !== args.actorUserId) {
    throw new ApprovalError('NOT_APPROVER', 'this step is assigned to someone else')
  }

  await logAction(tx, tid, args, req.current_step)

  if (args.action === 'reject') {
    await tx.query(
      `UPDATE approval_steps SET status = 'rejected', decided_at = now()
        WHERE tenant_id = $1 AND approval_request_id = $2 AND step_no = $3`,
      [tid, args.requestId, req.current_step],
    )
    await tx.query(
      `UPDATE approval_requests SET status = 'rejected', closed_at = now()
        WHERE tenant_id = $1 AND id = $2`,
      [tid, args.requestId],
    )
    await notifyRequester(tx, args.requestId, 'rejected', args.actorUserId)
    return { status: 'rejected', currentStep: req.current_step, changed: true }
  }

  if (args.action === 'send_back') {
    // Back to the requester for edit WITHOUT rejecting — the most-used action in
    // practice, and the one most often left out.
    await tx.query(
      `UPDATE approval_requests SET status = 'sent_back' WHERE tenant_id = $1 AND id = $2`,
      [tid, args.requestId],
    )
    await notifyRequester(tx, args.requestId, 'sent_back', args.actorUserId)
    return { status: 'sent_back', currentStep: req.current_step, changed: true }
  }

  if (args.action === 'delegate') {
    if (!args.comment) throw new ApprovalError('DELEGATE_TARGET_REQUIRED', 'delegate needs a target user id in comment')
    // The target is a user id taken from free text. It must BE a user, of this company (RLS hides
    // another's), still active -- and not the person who asked, who would otherwise approve their
    // own request.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.comment)) {
      throw new ApprovalError('DELEGATE_TARGET_INVALID', 'the delegate must be a user of this company')
    }
    const target = await tx.query(`SELECT 1 FROM app_users WHERE id = $1 AND status = 'active'`, [args.comment])
    if (!target.rowCount) throw new ApprovalError('DELEGATE_TARGET_INVALID', 'the delegate must be an active user of this company')
    if (args.comment === req.requested_by_user_id) {
      throw new ApprovalError('DELEGATE_TO_REQUESTER', 'a request cannot be delegated to the person who made it')
    }
    await tx.query(
      `UPDATE approval_steps SET approver_user_id = $4, delegated_from_user_id = $5
        WHERE tenant_id = $1 AND approval_request_id = $2 AND step_no = $3`,
      [tid, args.requestId, req.current_step, args.comment, args.actorUserId],
    )
    const { rows: t } = await tx.query<{ title: string }>(`SELECT title FROM approval_requests WHERE id = $1`, [args.requestId])
    await notify(tx, {
      userId: args.comment, eventType: 'approval.requested', title: `Approval needed: ${t[0]?.title ?? ''}`,
      body: 'Delegated to you.', entityType: 'approval_request', entityId: args.requestId,
      channels: ['in_app', 'email'], dedupeKey: `approval:${args.requestId}:delegated:${args.comment}`,
    })
    return { status: req.status, currentStep: req.current_step, changed: true }
  }

  await tx.query(
    `UPDATE approval_steps SET status = 'approved', decided_at = now()
      WHERE tenant_id = $1 AND approval_request_id = $2 AND step_no = $3`,
    [tid, args.requestId, req.current_step],
  )
  await tx.query(
    `UPDATE approval_requests SET status = 'pending' WHERE tenant_id = $1 AND id = $2`,
    [tid, args.requestId],
  )
  await advance(tx, args.requestId)

  const { rows: after } = await tx.query<{ status: string; current_step: number }>(
    `SELECT status, current_step FROM approval_requests WHERE id = $1`,
    [args.requestId],
  )
  if (after[0]!.status === 'approved') await notifyRequester(tx, args.requestId, 'approved', args.actorUserId)
  return { status: after[0]!.status, currentStep: after[0]!.current_step, changed: true }
}

async function logAction(
  tx: PoolClient,
  tid: string,
  args: { requestId: string; actorUserId: string; action: ActionKind; comment?: string },
  stepNo: number,
): Promise<void> {
  await tx.query(
    `INSERT INTO approval_actions (tenant_id, approval_request_id, step_no, actor_user_id, action, comment)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [tid, args.requestId, stepNo, args.actorUserId, args.action, args.comment ?? null],
  )
}

export interface InboxItem {
  request_id: string
  entity_type: string
  entity_id: string
  title: string
  step_no: number
  created_at: Date
  age_hours: number
  /** The role this step was meant for (manager, hr, finance, dept_head). */
  approver_role: string | null
  /** True when the step landed here because the requester had no approver (or was their own). */
  routed_to_hr: boolean
  /** Set when someone delegated their step to this approver. */
  delegated_from: string | null
  /** Last time the nightly job nudged the approver about this step. */
  reminded_at: Date | null
  /** Who raised it and for whom. */
  requested_by: string | null
  subject_employee_id: string | null
  subject_name: string | null
}

/**
 * THE universal inbox: one query across every module. Nine modules feeding eight
 * screens is the usability failure that sends managers back to WhatsApp.
 */
export async function inbox(tx: PoolClient, approverUserId: string): Promise<InboxItem[]> {
  const { rows } = await tx.query<InboxItem>(
    `SELECT r.id AS request_id, r.entity_type, r.entity_id, r.title,
            s.step_no, r.created_at,
            EXTRACT(EPOCH FROM (now() - r.created_at)) / 3600 AS age_hours,
            s.approver_role, s.routed_to_hr, s.reminded_at,
            (SELECT full_name FROM app_users d WHERE d.id = s.delegated_from_user_id) AS delegated_from,
            (SELECT full_name FROM app_users q WHERE q.id = r.requested_by_user_id) AS requested_by,
            r.subject_employee_id,
            (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = r.subject_employee_id) AS subject_name
       FROM approval_requests r
       JOIN approval_steps s
         ON (s.tenant_id, s.approval_request_id) = (r.tenant_id, r.id)
        AND s.step_no = r.current_step
      WHERE r.status = 'pending'
        AND s.status = 'pending'
        AND s.approver_user_id = $1
      ORDER BY r.created_at`,
    [approverUserId],
  )
  return rows
}
