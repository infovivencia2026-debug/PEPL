/** Approvals and tasks — the unified inbox. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  created,
  requireBody,
  asDate,
  asUuid,
  can,
  consume,
  act,
  inbox,
  approve,
  blockingTasksOpen,
  completeTask,
  instantiateTemplate,
  taskInbox,
  notify,
  emit,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/inbox',
    { summary: 'One queue: approvals and tasks across every module', tag: 'inbox',
      permission: 'approval.act' },
    authed(null, async (ctx) => {
      const [approvals, tasks] = await Promise.all([
        can(ctx.auth, 'approval.act') ? inbox(ctx.tx, ctx.auth.userId) : Promise.resolve([]),
        taskInbox(ctx.tx, ctx.auth.userId),
      ])
      return ok({
        items: [
          ...approvals.map((a) => ({ kind: 'approval' as const, ...a })),
          ...tasks.map((t) => ({ kind: 'task' as const, ...t })),
        ],
        counts: { approvals: approvals.length, tasks: tasks.length },
      })
    }))

  router.post('/api/v1/approvals/:id/act',
    { summary: 'Approve, reject, send back, comment, delegate or withdraw', tag: 'inbox',
      permission: 'approval.act', requestExample: { action: 'approve', comment: 'ok' } },
    authed('approval.act', async (ctx) => {
      const b = requireBody<{ action: string; comment?: string }>(ctx.req, ['action'])
      const result = await act(ctx.tx, {
        requestId: asUuid(ctx.req.params.id, 'id'), actorUserId: ctx.auth.userId,
        action: b.action as never, comment: b.comment,
      })

      if (result.status === 'approved') {
        const { rows } = await ctx.tx.query<{ entity_type: string; entity_id: string; subject_employee_id: string }>(
          `SELECT entity_type, entity_id, subject_employee_id FROM approval_requests WHERE id = $1`,
          [ctx.req.params.id])
        const r = rows[0]
        if (r?.entity_type === 'leave') {
          const { rows: lr } = await ctx.tx.query<{ leave_type_id: string; total_days: string; start_date: string }>(
            `SELECT leave_type_id, total_days::text, start_date::text FROM leave_requests WHERE id = $1`,
            [r.entity_id])
          const leave = lr[0]
          if (leave) {
            await consume(ctx.tx, {
              employeeId: r.subject_employee_id, leaveTypeId: leave.leave_type_id,
              cycleYear: new Date(leave.start_date).getFullYear(),
              days: Number(leave.total_days), effectiveDate: leave.start_date, requestId: r.entity_id,
              allowNegative: ctx.config.get<boolean>('leave.allow_negative_balance'),
            })
            await ctx.tx.query(
              `UPDATE leave_requests SET status = 'approved', decided_at = now() WHERE id = $1`, [r.entity_id])
            await notify(ctx.tx, {
              userId: ctx.auth.userId, eventType: 'leave.approved',
              title: 'Leave approved', entityType: 'leave', entityId: r.entity_id,
              dedupeKey: `leave-approved:${r.entity_id}`,
            })
            await emit(ctx.tx, {
              action: 'leave.request.approved', entityType: 'leave_request', entityId: r.entity_id,
              subjectEmployeeId: r.subject_employee_id, actorUserId: ctx.auth.userId,
            })
          }
        }
      }
      return ok(result)
    }))

  router.post('/api/v1/tasks/:id/complete',
    { summary: 'Complete a task', tag: 'inbox', permission: 'task.write' },
    authed('task.write', async (ctx) => {
      await completeTask(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
      return ok({ completed: true })
    }))

  router.post('/api/v1/tasks/instantiate',
    { summary: 'Run a task template for an employee (onboarding or offboarding)', tag: 'inbox',
      permission: 'task.assign',
      requestExample: { templateId: '…', employeeId: '…', anchorDate: '2026-02-01', sourceType: 'onboarding' } },
    authed('task.assign', async (ctx) => {
      const b = requireBody<{ templateId: string; employeeId: string; anchorDate: string; sourceType: string; assignees?: Record<string, string> }>(
        ctx.req, ['templateId', 'employeeId', 'anchorDate', 'sourceType'])
      const ids = await instantiateTemplate(ctx.tx, {
        templateId: asUuid(b.templateId, 'templateId'),
        subjectEmployeeId: asUuid(b.employeeId, 'employeeId'),
        anchorDate: asDate(b.anchorDate, 'anchorDate'),
        sourceType: b.sourceType,
        resolveAssignee: (rule) => b.assignees?.[rule],
      })
      return created({ taskIds: ids })
    }))

  router.get('/api/v1/employees/:id/offboarding-blockers',
    { summary: 'Open blocking tasks preventing exit sign-off', tag: 'inbox', permission: 'task.read' },
    authed('task.read', async (ctx) =>
      ok({ blockers: await blockingTasksOpen(ctx.tx, asUuid(ctx.req.params.id, 'id'), 'offboarding') })))
}
