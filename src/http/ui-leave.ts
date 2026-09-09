import { Router, HttpError } from './router.ts'
import {
  authed,
  ok,
  created,
  requireBody,
  requireModule,
  asUuid,
} from './context.ts'
import { assertScope, assertPermission } from '../authz/permissions.ts'
import {
  act,
  raise,
  CHAINS,
  type StepRole,
  type ChainCode,
} from '../approvals/index.ts'
import { consume } from '../leave/ledger.ts'
import { applyCorrection } from '../attendance/index.ts'
import { emit } from '../audit/index.ts'
import { textField, dateField } from './ui-routes.ts'
export function registerUiLeave(r: Router) {
  r.post(
    '/api/ui/leave/requests',
    { summary: 'Submit full-day leave', tag: 'leave' },
    authed('leave.apply', async (c) => {
      requireModule(c, 'leave.enabled')
      const employeeId = c.auth.employeeId
      if (!employeeId)
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Your account needs an employee profile before you can request leave',
        )
      const b = requireBody(c.req, [
          'leaveTypeId',
          'startDate',
          'endDate',
          'reason',
        ]),
        start = dateField(b.startDate, 'Start date'),
        end = dateField(b.endDate, 'End date'),
        days = (Date.parse(end) - Date.parse(start)) / 86400000 + 1
      if (days < 1 || days > 31)
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Choose 1–31 full calendar days',
        )
      const cycle = (d: string) =>
        Number(d.slice(0, 4)) -
        (Number(d.slice(5, 7)) < c.config.get<number>('leave.cycle_start_month')
          ? 1
          : 0)
      if (cycle(start) !== cycle(end))
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Submit separate requests across leave cycles',
        )
      const today = (await c.tx.query('SELECT CURRENT_DATE::text AS d'))
        .rows[0]!.d as string
      if (
        (Date.parse(today) - Date.parse(start)) / 86400000 >
        c.config.get<number>('leave.backdating_limit_days')
      )
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'This request is outside your company’s backdating limit',
        )
      const type = asUuid(b.leaveTypeId, 'Leave type')
      if (
        !(
          await c.tx.query(
            "SELECT id FROM leave_types WHERE id=$1 AND status='active'",
            [type],
          )
        ).rowCount
      )
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Choose an active leave type',
        )
      await c.tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [
        employeeId,
      ])
      if (
        (
          await c.tx.query(
            "SELECT id FROM leave_requests WHERE employee_id=$1 AND status IN ('pending','approved') AND start_date<=$3 AND end_date>=$2",
            [employeeId, start, end],
          )
        ).rowCount
      )
        throw new HttpError(
          409,
          'VALIDATION_FAILED',
          'You already have a request in this date range',
        )
      const { rows: users } = await c.tx.query(
        `SELECT u.id,ur.role FROM app_users u JOIN user_roles ur ON ur.user_id=u.id AND ur.tenant_id=u.tenant_id WHERE u.status='active' AND u.id<>$1 AND ur.role IN ('org_admin','hr_admin') ORDER BY ur.role,u.id`,
        [c.auth.userId],
      )
      const { rows: manager } = await c.tx.query(
        `SELECT u.id FROM employee_assignments a JOIN app_users u ON u.employee_id=a.manager_employee_id AND u.tenant_id=a.tenant_id WHERE a.employee_id=$1 AND a.superseded_at IS NULL AND a.effective_from<=CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to>CURRENT_DATE) AND u.status='active'`,
        [employeeId],
      )
      const chain = c.config.get<string>('leave.approval_chain') as ChainCode,
        approvers: Partial<Record<StepRole, string>> = {
          hr: users[0]?.id,
          manager: manager[0]?.id,
        }
      if (
        !CHAINS[chain]?.every(
          (role) => approvers[role] && approvers[role] !== c.auth.userId,
        )
      )
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'The required approvers are not assigned. Ask your administrator to complete the approval chain.',
        )
      const dayParts = Object.fromEntries(
        Array.from({ length: days }, (_, i) => [
          new Date(Date.parse(start) + i * 86400000).toISOString().slice(0, 10),
          'full',
        ]),
      )
      const { rows } = await c.tx.query(
        'INSERT INTO leave_requests(tenant_id,employee_id,leave_type_id,start_date,end_date,total_days,reason,day_parts) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
        [
          c.auth.tenantId,
          employeeId,
          type,
          start,
          end,
          days,
          textField(b.reason, 'Reason', 2000),
          JSON.stringify(dayParts),
        ],
      )
      await raise(c.tx, {
        entityType: 'leave',
        entityId: rows[0]!.id,
        requestedByUserId: c.auth.userId,
        subjectEmployeeId: employeeId,
        chainCode: chain,
        title: `Leave · ${start} to ${end}`,
        approvers,
      })
      return created({ id: rows[0]!.id })
    }),
  )
  r.post(
    '/api/ui/approvals/:id/actions',
    { summary: 'Decide assigned leave request', tag: 'approvals' },
    authed('approval.act', async (c) => {
      const b = requireBody(c.req, ['action']),
        id = asUuid(c.req.params.id, 'Request')
      if (!['approve', 'reject', 'send_back'].includes(String(b.action)))
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Choose approve, reject or send back',
        )
      const request = (
        await c.tx.query(
          'SELECT entity_type,entity_id,subject_employee_id FROM approval_requests WHERE id=$1 FOR UPDATE',
          [id],
        )
      ).rows[0]
      if (!request) throw new HttpError(404, 'NOT_FOUND', 'Request not found')
      assertScope(c.auth, request.subject_employee_id)
      if (request.entity_type !== 'leave')
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Complete this decision in the originating module',
        )
      requireModule(c, 'leave.enabled')
      assertPermission(c.auth, 'leave.approve')
      const result = await act(c.tx, {
        requestId: id,
        actorUserId: c.auth.userId,
        action: b.action as 'approve' | 'reject' | 'send_back',
        comment:
          typeof b.comment === 'string' ? b.comment.slice(0, 2000) : undefined,
      })
      if (result.changed && ['approved', 'rejected'].includes(result.status)) {
        const leave = (
          await c.tx.query(
            'SELECT employee_id,leave_type_id,start_date::text,end_date::text,total_days FROM leave_requests WHERE id=$1 FOR UPDATE',
            [request.entity_id],
          )
        ).rows[0]
        if (!leave)
          throw new HttpError(404, 'NOT_FOUND', 'Leave request not found')
        await c.tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [
          leave.employee_id,
        ])
        if (result.status === 'approved') {
          if (
            (
              await c.tx.query(
                "SELECT id FROM attendance_periods WHERE status IN ('closed','frozen') AND period_start<=$2 AND period_end>=$1",
                [leave.start_date, leave.end_date],
              )
            ).rowCount
          )
            throw new HttpError(
              409,
              'PERIOD_CLOSED',
              'This leave overlaps a closed attendance period. Resolve the period before approval.',
            )
          const cycle =
            Number(leave.start_date.slice(0, 4)) -
            (Number(leave.start_date.slice(5, 7)) <
            c.config.get<number>('leave.cycle_start_month')
              ? 1
              : 0)
          await consume(c.tx, {
            employeeId: leave.employee_id,
            leaveTypeId: leave.leave_type_id,
            cycleYear: cycle,
            days: Number(leave.total_days),
            effectiveDate: leave.start_date,
            requestId: request.entity_id,
            allowNegative: c.config.get<boolean>(
              'leave.allow_negative_balance',
            ),
          })
          await emit(c.tx, {
            action: 'leave.request.approved',
            entityType: 'leave_request',
            entityId: request.entity_id,
            subjectEmployeeId: leave.employee_id,
            actorUserId: c.auth.userId,
          })
        }
        await c.tx.query(
          'UPDATE leave_requests SET status=$2,decided_at=now() WHERE id=$1',
          [request.entity_id, result.status],
        )
        if (result.status === 'approved')
          for (
            let d = Date.parse(leave.start_date);
            d <= Date.parse(leave.end_date);
            d += 86400000
          )
            await applyCorrection(c.tx, {
              employeeId: leave.employee_id,
              workDate: new Date(d).toISOString().slice(0, 10),
              action: 'mark_leave',
              after: { dayFraction: 1, leaveRequestId: request.entity_id },
              reason: 'Approved leave request',
              actorUserId: c.auth.userId,
            })
      }
      return ok(result)
    }),
  )
}
