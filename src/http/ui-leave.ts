/**
 * The console's leave and approval endpoints. Thin: the same functions the
 * domain routes call, so there is one rule for what a leave request costs
 * and one for what happens when it is approved.
 */
import { Router, HttpError } from './router.ts'
import { authed, ok, created, requireBody, requireModule, asUuid } from './context.ts'
import { assertScope, assertPermission } from '../authz/permissions.ts'
import { act } from '../approvals/index.ts'
import { settle } from '../approvals/pending.ts'
import { applyLeave, settleLeaveDecision } from '../leave/apply.ts'
import { emit } from '../audit/index.ts'
import { textField, dateField } from './ui-routes.ts'

export function registerUiLeave(r: Router) {
  r.post(
    '/api/ui/leave/requests',
    { summary: 'Request leave (console)', tag: 'leave' },
    authed('leave.apply', async (c) => {
      requireModule(c, 'leave.enabled')
      const employeeId = c.auth.employeeId
      if (!employeeId) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'Your account needs an employee profile before you can request leave')
      }
      const b = requireBody<{ leaveTypeId: string; startDate: string; endDate: string; reason: string; totalDays?: number; dayParts?: Record<string, string> }>(
        c.req, ['leaveTypeId', 'startDate', 'endDate', 'reason'])
      const result = await applyLeave(c.tx, c.config, {
        employeeId, requestedByUserId: c.auth.userId,
        leaveTypeId: asUuid(b.leaveTypeId, 'Leave type'),
        startDate: dateField(b.startDate, 'Start date'), endDate: dateField(b.endDate, 'End date'),
        reason: textField(b.reason, 'Reason', 2000), totalDays: b.totalDays, dayParts: b.dayParts,
      })
      return created({ id: result.id, totalDays: result.totalDays, skipped: result.skipped, approvalRequestId: result.approvalRequestId })
    }),
  )

  r.post(
    '/api/ui/approvals/:id/actions',
    { summary: 'Decide an assigned approval (leave, salary revision, attendance correction)', tag: 'approvals' },
    authed('approval.act', async (c) => {
      const b = requireBody<{ action: string; comment?: string }>(c.req, ['action'])
      const id = asUuid(c.req.params.id, 'Request')
      if (!['approve', 'reject', 'send_back'].includes(b.action)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'Choose approve, reject or send back')
      }
      const request = (await c.tx.query<{ entity_type: string; entity_id: string; subject_employee_id: string; requested_by_user_id: string | null }>(
        'SELECT entity_type, entity_id, subject_employee_id, requested_by_user_id FROM approval_requests WHERE id = $1 FOR UPDATE', [id])).rows[0]
      if (!request) throw new HttpError(404, 'NOT_FOUND', 'Request not found')
      assertScope(c.auth, request.subject_employee_id)
      if (request.entity_type === 'leave') {
        requireModule(c, 'leave.enabled')
        assertPermission(c.auth, 'leave.approve')
      }

      const result = await act(c.tx, {
        requestId: id, actorUserId: c.auth.userId,
        action: b.action as 'approve' | 'reject' | 'send_back',
        comment: typeof b.comment === 'string' ? b.comment.slice(0, 2000) : undefined,
      })

      if (result.changed && (result.status === 'approved' || result.status === 'rejected')) {
        if (request.entity_type === 'leave') {
          await settleLeaveDecision(c.tx, c.config, {
            leaveRequestId: request.entity_id, status: result.status, actorUserId: c.auth.userId,
            requestedByUserId: request.requested_by_user_id,
          })
          await emit(c.tx, {
            action: result.status === 'approved' ? 'leave.request.approved' : 'leave.request.rejected',
            entityType: 'leave_request', entityId: request.entity_id,
            subjectEmployeeId: request.subject_employee_id, actorUserId: c.auth.userId,
          })
        } else {
          // A held salary revision or attendance correction lands (or is closed
          // out) through the same functions a direct write uses.
          const settled = await settle(c.tx, id, c.auth.userId)
          if (settled?.status === 'applied') {
            await emit(c.tx, {
              action: settled.entity_type === 'compensation' ? 'people.compensation.changed' : 'attendance.day.corrected',
              entityType: settled.entity_type === 'compensation' ? 'employee' : 'attendance',
              entityId: settled.entity_type === 'compensation' ? settled.subject_employee_id : undefined,
              subjectEmployeeId: settled.subject_employee_id, actorUserId: c.auth.userId,
              reason: (settled.payload as { reason: string }).reason,
              metadata: { viaApproval: id, ...settled.result },
            })
          }
        }
      }
      if (request.requested_by_user_id) {
        c.publish({ type: 'approval.decided', userIds: [request.requested_by_user_id], data: { requestId: id, status: result.status, action: b.action } })
      }
      return ok(result)
    }),
  )
}
