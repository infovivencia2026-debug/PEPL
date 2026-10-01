/**
 * Tasks — the primitive that makes onboarding and offboarding a template plus an
 * event rather than modules of their own.
 */
import type { PoolClient } from 'pg'

export class TaskError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'TaskError'
  }
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new TaskError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

const addDays = (iso: string, days: number): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Fired by employee.hired / employee.exited. Resolves each template item's
 * assignee and due date, and creates one task per item.
 */
export async function instantiateTemplate(
  tx: PoolClient,
  args: {
    templateId: string
    subjectEmployeeId: string
    anchorDate: string                  // joining date, or exit date
    sourceType: string
    resolveAssignee: (rule: string, ref: string | null) => string | undefined
  },
): Promise<string[]> {
  const tid = await tenantId(tx)

  const { rows: items } = await tx.query<{
    id: string; title: string; description: string | null
    assignee_rule: string; assignee_ref: string | null
    due_offset_days: number; blocks_completion: boolean
  }>(
    `SELECT id, title, description, assignee_rule, assignee_ref, due_offset_days, blocks_completion
       FROM task_template_items WHERE template_id = $1 ORDER BY sequence`,
    [args.templateId],
  )
  if (items.length === 0) throw new TaskError('TEMPLATE_EMPTY', 'template has no items')

  const created: string[] = []
  for (const item of items) {
    const assignee = args.resolveAssignee(item.assignee_rule, item.assignee_ref)
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO tasks
         (tenant_id, title, description, assignee_user_id, assignee_role, subject_employee_id,
          source_type, source_id, template_item_id, due_date, blocks_completion)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [tid, item.title, item.description, assignee ?? null, item.assignee_rule,
       args.subjectEmployeeId, args.sourceType, args.subjectEmployeeId, item.id,
       addDays(args.anchorDate, item.due_offset_days), item.blocks_completion],
    )
    created.push(rows[0]!.id)
  }
  return created
}

export async function completeTask(
  tx: PoolClient,
  taskId: string,
  userId: string,
  opts: { mayCompleteOthers?: boolean } = {},
): Promise<void> {
  const tid = await tenantId(tx)
  // Any task.write holder used to complete ANY task, which let an employee tick off the offboarding
  // items that block someone's exit. Only the assignee -- or someone who manages tasks -- may.
  const mayAny = opts.mayCompleteOthers !== false
  const { rowCount } = await tx.query(
    `UPDATE tasks SET status = 'done', completed_by_user_id = $3, completed_at = now()
      WHERE tenant_id = $1 AND id = $2 AND status <> 'done'
        AND ($4::boolean OR assignee_user_id IS NULL OR assignee_user_id = $3)`,
    [tid, taskId, userId, mayAny],
  )
  if (rowCount === 0) {
    const t = await tx.query<{ status: string }>(`SELECT status FROM tasks WHERE tenant_id = $1 AND id = $2`, [tid, taskId])
    // Not there, or already done: idempotent. There but not ours: say so.
    if (t.rows[0] && t.rows[0].status !== 'done') throw new TaskError('NOT_ASSIGNEE', 'this task is assigned to someone else')
  }
}

/**
 * Offboarding cannot be signed off while a blocking item is open — asset
 * recovery being the obvious one.
 */
export async function blockingTasksOpen(
  tx: PoolClient,
  subjectEmployeeId: string,
  sourceType: string,
): Promise<{ id: string; title: string }[]> {
  const { rows } = await tx.query<{ id: string; title: string }>(
    `SELECT id, title FROM tasks
      WHERE subject_employee_id = $1 AND source_type = $2
        AND blocks_completion AND status NOT IN ('done','cancelled')
      ORDER BY due_date`,
    [subjectEmployeeId, sourceType],
  )
  return rows
}

export interface TaskInboxItem {
  id: string
  title: string
  due_date: string | null
  status: string
  overdue: boolean
}

/** Tasks feed the SAME inbox as approvals: a manager gets one queue, not two. */
export async function taskInbox(tx: PoolClient, userId: string): Promise<TaskInboxItem[]> {
  const { rows } = await tx.query<TaskInboxItem>(
    `SELECT id, title, due_date::text, status,
            (due_date IS NOT NULL AND due_date < CURRENT_DATE) AS overdue
       FROM tasks
      WHERE assignee_user_id = $1 AND status NOT IN ('done','cancelled')
      ORDER BY due_date NULLS LAST, created_at`,
    [userId],
  )
  return rows
}
