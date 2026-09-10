/** Helpdesk. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  created,
  requireBody,
  requireModule,
  asUuid,
  raiseTicket,
  respond,
  setStatus,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/tickets',
    { summary: 'Tickets visible to the caller (confidential ones are filtered by policy)',
      tag: 'helpdesk', permission: 'ticket.read' },
    authed('ticket.read', async (ctx) => {
      requireModule(ctx, 'helpdesk.enabled')
      const { rows } = await ctx.tx.query(
        `SELECT id, ticket_number, title, status, priority, is_confidential,
                sla_resolution_due_at, sla_resolution_breached, created_at
           FROM tickets ORDER BY created_at DESC LIMIT 200`)
      return ok({ tickets: rows })
    }))

  router.post('/api/v1/tickets',
    { summary: 'Raise a ticket', tag: 'helpdesk', permission: 'ticket.write',
      requestExample: { categoryId: '…', title: 'Salary is short', description: 'August net looks wrong' } },
    authed('ticket.write', async (ctx) => {
      requireModule(ctx, 'helpdesk.enabled')
      const b = requireBody<{ categoryId: string; title: string; description: string; priority?: string }>(
        ctx.req, ['categoryId', 'title', 'description'])
      const id = await raiseTicket(ctx.tx, {
        categoryId: asUuid(b.categoryId, 'categoryId'), raisedByUserId: ctx.auth.userId,
        subjectEmployeeId: ctx.auth.employeeId, title: b.title, description: b.description,
        priority: b.priority as never,
        defaultResponseSlaMinutes: ctx.config.get<number>('helpdesk.default_response_sla_minutes'),
      })
      return created({ id })
    }))

  router.post('/api/v1/tickets/:id/messages',
    { summary: 'Reply on a ticket', tag: 'helpdesk', permission: 'ticket.write' },
    authed('ticket.write', async (ctx) => {
      const b = requireBody<{ body: string; internal?: boolean }>(ctx.req, ['body'])
      await respond(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
        authorUserId: ctx.auth.userId, body: b.body, internal: b.internal,
      })
      return created({ posted: true })
    }))

  router.post('/api/v1/tickets/:id/status',
    { summary: 'Change ticket status (pauses the SLA clock when waiting on the employee)',
      tag: 'helpdesk', permission: 'ticket.assign' },
    authed('ticket.assign', async (ctx) => {
      const b = requireBody<{ status: string }>(ctx.req, ['status'])
      await setStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status, { actorUserId: ctx.auth.userId })
      return ok({ status: b.status })
    }))
}
