/**
 * One place where an approval decision reaches the thing it was about.
 *
 * Both decision routes (the domain inbox and the console) and the bulk route
 * call this after `act()`. Each entity type settles through the same function
 * a direct write uses, and emits its audit action once. Adding an entity type
 * to the approval engine means adding one branch here — nowhere else.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { emit } from '../audit/index.ts'
import { settle as settleHeld } from './pending.ts'
import { settleLeaveDecision } from '../leave/apply.ts'
import { settleClaimDecision, settleTravelDecision } from '../work/expenses.ts'
import { settleTimesheetDecision } from '../work/timesheets.ts'
import { settleRequisitionDecision, settleOfferDecision } from '../people/recruitment.ts'
import { settleRemoteDecision } from '../attendance/remote.ts'
import { settleSwapDecision, settleOtDecision } from '../attendance/roster.ts'

export interface DecisionArgs {
  requestId: string
  status: 'approved' | 'rejected'
  actorUserId: string
  comment?: string
}

export async function settleDecision(tx: PoolClient, cfg: ResolvedConfig, args: DecisionArgs): Promise<{ entityType: string; requestedByUserId: string | null } | null> {
  const { rows } = await tx.query<{ entity_type: string; entity_id: string; subject_employee_id: string; requested_by_user_id: string | null }>(
    `SELECT entity_type, entity_id, subject_employee_id, requested_by_user_id FROM approval_requests WHERE id = $1`, [args.requestId])
  const r = rows[0]
  if (!r) return null
  const approved = args.status === 'approved'
  const base = { subjectEmployeeId: r.subject_employee_id, actorUserId: args.actorUserId }

  switch (r.entity_type) {
    case 'leave': {
      const s = await settleLeaveDecision(tx, cfg, { leaveRequestId: r.entity_id, status: args.status, actorUserId: args.actorUserId, requestedByUserId: r.requested_by_user_id })
      if (s.changed) await emit(tx, { action: approved ? 'leave.request.approved' : 'leave.request.rejected', entityType: 'leave_request', entityId: r.entity_id, ...base })
      break
    }
    case 'expense': {
      const s = await settleClaimDecision(tx, { claimId: r.entity_id, status: args.status, actorUserId: args.actorUserId })
      if (s.changed) await emit(tx, { action: approved ? 'expense.claim.approved' : 'expense.claim.rejected', entityType: 'expense_claim', entityId: r.entity_id, ...base })
      break
    }
    case 'travel': await settleTravelDecision(tx, { tripId: r.entity_id, status: args.status }); break
    case 'remote': await settleRemoteDecision(tx, { approvalRequestId: args.requestId, status: args.status }); break
    case 'shift_swap': await settleSwapDecision(tx, { approvalRequestId: args.requestId, status: args.status, actorUserId: args.actorUserId }); break
    case 'overtime': await settleOtDecision(tx, { approvalRequestId: args.requestId, status: args.status }); break
    case 'requisition': await settleRequisitionDecision(tx, { approvalRequestId: args.requestId, status: args.status }); break
    case 'offer': await settleOfferDecision(tx, { approvalRequestId: args.requestId, status: args.status }); break
    case 'timesheet': {
      const s = await settleTimesheetDecision(tx, { approvalRequestId: args.requestId, status: args.status, actorUserId: args.actorUserId, comment: args.comment })
      if (s.changed) await emit(tx, { action: approved ? 'timesheet.approved' : 'timesheet.rejected', entityType: 'timesheet', entityId: s.timesheetId, ...base })
      break
    }
    default: {
      // A held salary revision or attendance correction lands (or is closed
      // out) through the same functions a direct write uses.
      const settled = await settleHeld(tx, args.requestId, args.actorUserId)
      if (settled?.status === 'applied') {
        await emit(tx, {
          action: settled.entity_type === 'compensation' ? 'people.compensation.changed' : 'attendance.day.corrected',
          entityType: settled.entity_type === 'compensation' ? 'employee' : 'attendance',
          entityId: settled.entity_type === 'compensation' ? settled.subject_employee_id : undefined,
          subjectEmployeeId: settled.subject_employee_id, actorUserId: args.actorUserId,
          reason: (settled.payload as { reason: string }).reason,
          metadata: { viaApproval: args.requestId, ...settled.result },
        })
      }
    }
  }
  return { entityType: r.entity_type, requestedByUserId: r.requested_by_user_id }
}
