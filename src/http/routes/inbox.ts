/** Approvals and tasks — the unified inbox. */
import type { Router } from '../router.ts'
import { settleDecision } from '../../approvals/settle.ts'
import {
  listTemplates, getTemplate, createTemplate, updateTemplate, retireTemplate, resolveAssignees,
  type TemplateItemInput, type Trigger,
} from '../../work/templates.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  asDate,
  asUuid,
  can, assertScope,
  act,
  inbox,
  approve,
  blockingTasksOpen,
  completeTask,
  instantiateTemplate,
  taskInbox,
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

  router.post('/api/v1/approvals/bulk',
    { summary: 'Approve or reject up to 50 requests in one go; each is decided and settled independently and reported back', tag: 'inbox',
      permission: 'approval.act', requestExample: { ids: ['…', '…'], action: 'approve', comment: 'Reviewed together' } },
    authed('approval.act', async (ctx) => {
      const b = requireBody<{ ids: string[]; action: 'approve' | 'reject'; comment?: string }>(ctx.req, ['ids', 'action'])
      if (!['approve', 'reject'].includes(b.action)) throw new HttpError(422, 'VALIDATION_FAILED', 'bulk action is approve or reject')
      if (!Array.isArray(b.ids) || b.ids.length === 0 || b.ids.length > 50) throw new HttpError(422, 'VALIDATION_FAILED', 'between 1 and 50 ids')
      if (b.action === 'reject' && !b.comment?.trim()) throw new HttpError(422, 'VALIDATION_FAILED', 'a bulk rejection needs a comment')
      const results: Array<{ id: string; status?: string; error?: string }> = []
      for (const raw of b.ids) {
        const id = asUuid(raw, 'ids')
        // SAVEPOINT so one refusal (already decided, not the approver) does not roll back the others
        await ctx.tx.query('SAVEPOINT bulk_item')
        try {
          const result = await act(ctx.tx, { requestId: id, actorUserId: ctx.auth.userId, action: b.action, comment: b.comment })
          if (result.changed && (result.status === 'approved' || result.status === 'rejected')) {
            const settled = await settleDecision(ctx.tx, ctx.config, { requestId: id, status: result.status, actorUserId: ctx.auth.userId, comment: b.comment })
            if (settled?.requestedByUserId) ctx.publish({ type: 'approval.decided', userIds: [settled.requestedByUserId], data: { requestId: id, status: result.status, action: b.action } })
          }
          await ctx.tx.query('RELEASE SAVEPOINT bulk_item')
          results.push({ id, status: result.status })
        } catch (e) {
          await ctx.tx.query('ROLLBACK TO SAVEPOINT bulk_item')
          results.push({ id, error: (e as { code?: string }).code ?? 'FAILED' })
        }
      }
      await emit(ctx.tx, { action: 'approval.bulk.decided', entityType: 'approval_request', actorUserId: ctx.auth.userId,
        metadata: { action: b.action, requested: b.ids.length, decided: results.filter((r) => !r.error).length } })
      return ok({ results })
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

      if (result.changed && (result.status === 'approved' || result.status === 'rejected')) {
        await settleDecision(ctx.tx, ctx.config, { requestId: ctx.req.params.id!, status: result.status, actorUserId: ctx.auth.userId, comment: b.comment })
      }

      // The person who raised the request is the one waiting on this answer.
      const { rows: raised } = await ctx.tx.query<{ requested_by_user_id: string | null }>(
        `SELECT requested_by_user_id FROM approval_requests WHERE id = $1`,
        [ctx.req.params.id])
      const requester = raised[0]?.requested_by_user_id
      ctx.publish({
        type: 'approval.decided',
        ...(requester ? { userIds: [requester] } : {}),
        data: { requestId: ctx.req.params.id, status: result.status, action: b.action },
      })
      return ok(result)
    }))

  router.post('/api/v1/tasks/:id/complete',
    { summary: 'Complete a task', tag: 'inbox', permission: 'task.write' },
    authed('task.write', async (ctx) => {
      await completeTask(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, { mayCompleteOthers: can(ctx.auth, 'task.assign') })
      return ok({ completed: true })
    }))

  router.get('/api/v1/task-templates',
    { summary: 'Onboarding / offboarding checklists (?includeRetired=true for history)', tag: 'inbox', permission: 'task.read' },
    authed('task.read', async (ctx) => ok({ templates: await listTemplates(ctx.tx, ctx.req.query.get('includeRetired') === 'true') })))

  router.post('/api/v1/task-templates',
    { summary: 'Define a checklist: name, trigger (onboarding|offboarding|manual) and its items in order', tag: 'inbox',
      permission: 'task.assign',
      requestExample: { name: 'New joiner', trigger: 'onboarding', items: [
        { title: 'Collect PAN and Aadhaar', assigneeRule: 'hr', dueOffsetDays: 0, requiresAttachment: true },
        { title: 'Issue laptop', assigneeRule: 'it', dueOffsetDays: 1 },
        { title: 'Introduce the team', assigneeRule: 'manager', dueOffsetDays: 2 } ] } },
    authed('task.assign', async (ctx) => {
      const b = requireBody<{ name: string; trigger: Trigger; items: TemplateItemInput[] }>(ctx.req, ['name', 'trigger', 'items'])
      if (!Array.isArray(b.items)) throw new HttpError(422, 'VALIDATION_FAILED', 'items must be an array')
      const t = await createTemplate(ctx.tx, { name: b.name, trigger: b.trigger, items: b.items })
      await emit(ctx.tx, { action: 'work.template.changed', entityType: 'task_template', entityId: t.id, actorUserId: ctx.auth.userId,
        after: { name: t.name, trigger: t.trigger_event, items: t.items.length } })
      return created(t)
    }))

  router.patch('/api/v1/task-templates/:id',
    { summary: 'Rename, retrigger or replace the items of a checklist', tag: 'inbox', permission: 'task.assign',
      requestExample: { items: [{ title: 'Collect PAN', assigneeRule: 'hr' }] } },
    authed('task.assign', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ name?: string; trigger?: Trigger; items?: TemplateItemInput[] }>(ctx.req, [])
      if (b.items !== undefined && !Array.isArray(b.items)) throw new HttpError(422, 'VALIDATION_FAILED', 'items must be an array')
      const t = await updateTemplate(ctx.tx, id, b)
      await emit(ctx.tx, { action: 'work.template.changed', entityType: 'task_template', entityId: id, actorUserId: ctx.auth.userId,
        after: { name: t.name, trigger: t.trigger_event, items: t.items.length } })
      return ok(t)
    }))

  router.post('/api/v1/task-templates/:id/retire',
    { summary: 'Retire a checklist; tasks already created from it are untouched', tag: 'inbox', permission: 'task.assign' },
    authed('task.assign', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      await retireTemplate(ctx.tx, id)
      await emit(ctx.tx, { action: 'work.template.retired', entityType: 'task_template', entityId: id, actorUserId: ctx.auth.userId })
      return ok({ retired: true })
    }))

  router.post('/api/v1/tasks/instantiate',
    { summary: 'Run a task template for an employee (onboarding or offboarding)', tag: 'inbox',
      permission: 'task.assign',
      requestExample: { templateId: '…', employeeId: '…', anchorDate: '2026-02-01', sourceType: 'onboarding' } },
    authed('task.assign', async (ctx) => {
      const b = requireBody<{ templateId: string; employeeId: string; anchorDate: string; sourceType: string; assignees?: Record<string, string> }>(
        ctx.req, ['templateId', 'employeeId', 'anchorDate', 'sourceType'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      const templateId = asUuid(b.templateId, 'templateId')
      if (!(await getTemplate(ctx.tx, templateId))) throw new HttpError(404, 'TEMPLATE_NOT_FOUND', 'no such template')
      // Explicit assignees win; otherwise the rules resolve from the org: the
      // person's manager, whoever holds the HR/IT/finance role, the person.
      const auto = await resolveAssignees(ctx.tx, employeeId)
      const ids = await instantiateTemplate(ctx.tx, {
        templateId, subjectEmployeeId: employeeId,
        anchorDate: asDate(b.anchorDate, 'anchorDate'),
        sourceType: b.sourceType,
        resolveAssignee: (rule, ref) => b.assignees?.[rule] ?? auto(rule, ref),
      })
      await emit(ctx.tx, { action: 'work.checklist.started', entityType: 'employee', entityId: employeeId, subjectEmployeeId: employeeId,
        actorUserId: ctx.auth.userId, metadata: { templateId, sourceType: b.sourceType, tasks: ids.length } })
      return created({ taskIds: ids })
    }))

  router.get('/api/v1/employees/:id/offboarding-blockers',
    { summary: 'Open blocking tasks preventing exit sign-off', tag: 'inbox', permission: 'task.read' },
    authed('task.read', async (ctx) => {
      // Who is leaving is not for everyone to learn: the same scope rule as the profile.
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      return ok({ blockers: await blockingTasksOpen(ctx.tx, id, 'offboarding') })
    }))
}
