/**
 * Employee helpdesk.
 *
 * Two things here are load-bearing:
 *   - SLA due times are computed at CREATION and stored. Deriving them at read
 *     time means a later change to the category SLA retroactively rewrites
 *     history, and breach reports become fiction.
 *   - The SLA clock PAUSES while waiting on the employee, so a ticket is not
 *     breached by the requester's own silence.
 *
 * Confidentiality is enforced by the RLS policy on tickets, not by a filter in
 * this file — see db/migrations/011_helpdesk.sql. A service-layer filter is one
 * forgotten WHERE clause away from putting a grievance in a manager's list.
 */
import type { PoolClient } from 'pg'

export class TicketError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TicketError'
  }
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new TicketError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

export interface RaiseTicketInput {
  categoryId: string
  raisedByUserId: string
  subjectEmployeeId?: string
  title: string
  description: string
  priority?: 'low' | 'medium' | 'high' | 'urgent'
  now?: Date
}

export async function raiseTicket(tx: PoolClient, input: RaiseTicketInput): Promise<string> {
  const tid = await tenantId(tx)

  const { rows: cats } = await tx.query<{
    sla_response_minutes: number; sla_resolution_minutes: number; is_confidential: boolean
  }>(
    `SELECT sla_response_minutes, sla_resolution_minutes, is_confidential
       FROM ticket_categories WHERE id = $1 AND status = 'active'`,
    [input.categoryId],
  )
  const cat = cats[0]
  if (!cat) throw new TicketError('CATEGORY_NOT_FOUND', 'no such active ticket category')

  const now = input.now ?? new Date()
  const due = (mins: number): Date => new Date(now.getTime() + mins * 60_000)

  // Numbers come from a per-tenant counter, never MAX() over tickets: the
  // confidentiality policy hides rows from most callers, and a MAX() that cannot
  // see a ticket hands out a number already in use.
  const { rows: seq } = await tx.query<{ next_number: number }>(
    `INSERT INTO ticket_counters (tenant_id, next_number) VALUES ($1, 2)
     ON CONFLICT (tenant_id) DO UPDATE SET next_number = ticket_counters.next_number + 1
     RETURNING ticket_counters.next_number - CASE WHEN xmax = 0 THEN 1 ELSE 0 END AS next_number`,
    [tid],
  )
  const ticketNumber = `HR-${String(seq[0]!.next_number).padStart(4, '0')}`

  // The id is generated HERE rather than by RETURNING: INSERT ... RETURNING
  // requires the new row to be visible under the SELECT policy, and the person
  // filing a confidential ticket on someone's behalf may not be able to see it.
  const id = crypto.randomUUID()

  await tx.query(
    `INSERT INTO tickets
       (tenant_id, id, ticket_number, category_id, raised_by_user_id, subject_employee_id,
        title, description, priority, is_confidential,
        sla_response_due_at, sla_resolution_due_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [tid, id, ticketNumber, input.categoryId, input.raisedByUserId, input.subjectEmployeeId ?? null,
     input.title, input.description, input.priority ?? 'medium',
     // propagated from the category and never removable afterwards
     cat.is_confidential,
     due(cat.sla_response_minutes), due(cat.sla_resolution_minutes), now],
  )
  await logEvent(tx, tid, id, 'created', input.raisedByUserId, null, { ticketNumber })
  return id
}

/** An agent reply stops the response clock; it never restarts. */
export async function respond(
  tx: PoolClient,
  ticketId: string,
  args: { authorUserId: string; body: string; internal?: boolean; now?: Date },
): Promise<void> {
  const tid = await tenantId(tx)
  const now = args.now ?? new Date()

  await tx.query(
    `INSERT INTO ticket_messages (tenant_id, ticket_id, author_user_id, author_type, body, is_internal_note)
     VALUES ($1,$2,$3,'agent',$4,$5)`,
    [tid, ticketId, args.authorUserId, args.body, args.internal ?? false],
  )

  if (!args.internal) {
    await tx.query(
      `UPDATE tickets SET first_responded_at = COALESCE(first_responded_at, $3)
        WHERE tenant_id = $1 AND id = $2`,
      [tid, ticketId, now],
    )
  }
}

/**
 * Pausing pushes the resolution deadline out by the elapsed wait, so a ticket is
 * never breached by time the requester owns. Every pause interval is recorded.
 */
export async function setStatus(
  tx: PoolClient,
  ticketId: string,
  status: string,
  args: { actorUserId: string; now?: Date },
): Promise<void> {
  const tid = await tenantId(tx)
  const now = args.now ?? new Date()

  const { rows } = await tx.query<{ status: string; paused_at: Date | null }>(
    `SELECT status, paused_at FROM tickets WHERE id = $1`, [ticketId],
  )
  const t = rows[0]
  if (!t) throw new TicketError('NOT_FOUND', 'no such ticket')

  const pausing = status === 'waiting_on_employee' && t.status !== 'waiting_on_employee'
  const resuming = t.status === 'waiting_on_employee' && status !== 'waiting_on_employee'

  if (pausing) {
    await tx.query(
      `UPDATE tickets SET status = $3, paused_at = $4 WHERE tenant_id = $1 AND id = $2`,
      [tid, ticketId, status, now],
    )
  } else if (resuming && t.paused_at) {
    const pausedMinutes = Math.round((now.getTime() - t.paused_at.getTime()) / 60_000)
    await tx.query(
      `UPDATE tickets
          SET status = $3, paused_at = NULL,
              paused_minutes = paused_minutes + $4,
              sla_resolution_due_at = sla_resolution_due_at + ($4 || ' minutes')::interval
        WHERE tenant_id = $1 AND id = $2`,
      [tid, ticketId, status, pausedMinutes],
    )
  } else {
    await tx.query(
      `UPDATE tickets SET status = $3,
              resolved_at = CASE WHEN $3 = 'resolved' THEN $4::timestamptz ELSE resolved_at END,
              reopen_count = reopen_count + CASE WHEN $3 = 'reopened' THEN 1 ELSE 0 END
        WHERE tenant_id = $1 AND id = $2`,
      [tid, ticketId, status, now],
    )
  }

  await logEvent(tx, tid, ticketId, 'status_changed', args.actorUserId,
    { status: t.status }, { status })
}

/** Marks breaches. Idempotent and re-runnable, like every scheduled job here. */
export async function evaluateBreaches(tx: PoolClient, now?: Date): Promise<number> {
  const tid = await tenantId(tx)
  const at = now ?? new Date()
  const { rowCount } = await tx.query(
    `UPDATE tickets
        SET sla_response_breached =
              (first_responded_at IS NULL AND sla_response_due_at < $2),
            sla_resolution_breached =
              (resolved_at IS NULL AND sla_resolution_due_at < $2)
      WHERE tenant_id = $1
        AND status NOT IN ('closed','cancelled')
        AND (
          (first_responded_at IS NULL AND sla_response_due_at < $2 AND NOT sla_response_breached)
          OR (resolved_at IS NULL AND sla_resolution_due_at < $2 AND NOT sla_resolution_breached)
        )`,
    [tid, at],
  )
  return rowCount ?? 0
}

async function logEvent(
  tx: PoolClient, tid: string, ticketId: string, eventType: string,
  actorUserId: string | null, from: unknown, to: unknown,
): Promise<void> {
  await tx.query(
    `INSERT INTO ticket_events (tenant_id, ticket_id, event_type, actor_user_id, from_value, to_value)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
    [tid, ticketId, eventType, actorUserId,
     from === null ? null : JSON.stringify(from), JSON.stringify(to)],
  )
}
