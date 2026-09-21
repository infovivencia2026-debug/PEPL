/**
 * Task templates: the checklist a joiner or a leaver triggers.
 *
 * A template is a named list of items — "collect PAN", "issue laptop",
 * "revoke access" — each with who does it (a rule resolved at run time: the
 * person's manager, HR, the employee themselves, or a named user), when it is
 * due relative to the joining or exit date, and whether the exit can be
 * signed off while it is open. Templates are retired, not deleted, so the
 * tasks already created from one keep their provenance.
 */
import type { PoolClient } from 'pg'

export class TemplateError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'TemplateError' }
}

export const TRIGGERS = ['onboarding', 'offboarding', 'manual'] as const
export type Trigger = typeof TRIGGERS[number]
export const ASSIGNEE_RULES = ['manager', 'hr', 'it', 'finance', 'employee', 'named_user'] as const
export type AssigneeRule = typeof ASSIGNEE_RULES[number]

export interface TemplateItemInput {
  title: string
  description?: string | null
  assigneeRule: AssigneeRule
  assigneeRef?: string | null
  dueOffsetDays?: number
  blocksCompletion?: boolean
  requiresAttachment?: boolean
}

export interface TaskTemplate {
  id: string
  name: string
  trigger_event: Trigger | null
  status: string
  items: {
    id: string; title: string; description: string | null; assignee_rule: AssigneeRule; assignee_ref: string | null
    due_offset_days: number; sequence: number; blocks_completion: boolean; requires_attachment: boolean
  }[]
}

const tenantId = async (tx: PoolClient): Promise<string> => {
  const t = (await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')).rows[0]?.t
  if (!t) throw new TemplateError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

function checkItems(items: readonly TemplateItemInput[]): void {
  if (!items.length) throw new TemplateError('VALIDATION_FAILED', 'a template needs at least one item')
  for (const [i, it] of items.entries()) {
    if (!it.title?.trim()) throw new TemplateError('VALIDATION_FAILED', `item ${i + 1} needs a title`)
    if (!ASSIGNEE_RULES.includes(it.assigneeRule)) {
      throw new TemplateError('VALIDATION_FAILED', `item ${i + 1}: assigneeRule must be one of ${ASSIGNEE_RULES.join(', ')}`)
    }
    if (it.assigneeRule === 'named_user' && !it.assigneeRef) {
      throw new TemplateError('VALIDATION_FAILED', `item ${i + 1}: named_user needs assigneeRef (a user id)`)
    }
    if (it.dueOffsetDays !== undefined && (!Number.isInteger(it.dueOffsetDays) || Math.abs(it.dueOffsetDays) > 365)) {
      throw new TemplateError('VALIDATION_FAILED', `item ${i + 1}: dueOffsetDays must be a whole number within a year`)
    }
  }
}

export async function listTemplates(tx: PoolClient, includeRetired = false): Promise<TaskTemplate[]> {
  const { rows } = await tx.query<Omit<TaskTemplate, 'items'>>(
    `SELECT id, name, trigger_event, status FROM task_templates WHERE $1 OR status = 'active' ORDER BY trigger_event, name`,
    [includeRetired])
  const out: TaskTemplate[] = []
  for (const t of rows) out.push({ ...t, items: await itemsOf(tx, t.id) })
  return out
}

async function itemsOf(tx: PoolClient, templateId: string): Promise<TaskTemplate['items']> {
  const { rows } = await tx.query<TaskTemplate['items'][number]>(
    `SELECT id, title, description, assignee_rule, assignee_ref, due_offset_days, sequence, blocks_completion, requires_attachment
       FROM task_template_items WHERE template_id = $1 ORDER BY sequence`, [templateId])
  return rows
}

export async function getTemplate(tx: PoolClient, id: string): Promise<TaskTemplate | null> {
  const { rows } = await tx.query<Omit<TaskTemplate, 'items'>>(
    `SELECT id, name, trigger_event, status FROM task_templates WHERE id = $1`, [id])
  return rows[0] ? { ...rows[0], items: await itemsOf(tx, id) } : null
}

export async function createTemplate(
  tx: PoolClient, args: { name: string; trigger: Trigger; items: TemplateItemInput[] },
): Promise<TaskTemplate> {
  const name = args.name.trim().slice(0, 120)
  if (!name) throw new TemplateError('VALIDATION_FAILED', 'a template needs a name')
  if (!TRIGGERS.includes(args.trigger)) throw new TemplateError('VALIDATION_FAILED', `trigger must be one of ${TRIGGERS.join(', ')}`)
  checkItems(args.items)
  const tid = await tenantId(tx)
  const dup = await tx.query(`SELECT 1 FROM task_templates WHERE lower(name) = lower($1) AND status = 'active'`, [name])
  if (dup.rowCount) throw new TemplateError('TEMPLATE_EXISTS', `an active template called "${name}" already exists`)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO task_templates (tenant_id, name, trigger_event, applies_to) VALUES ($1,$2,$3,'{}'::jsonb) RETURNING id`,
    [tid, name, args.trigger])
  await writeItems(tx, tid, rows[0]!.id, args.items)
  return (await getTemplate(tx, rows[0]!.id))!
}

/** Items are replaced whole: a checklist is edited as a list, not item by item. */
export async function updateTemplate(
  tx: PoolClient, id: string, patch: { name?: string; trigger?: Trigger; items?: TemplateItemInput[] },
): Promise<TaskTemplate> {
  const tid = await tenantId(tx)
  const cur = await getTemplate(tx, id)
  if (!cur) throw new TemplateError('TEMPLATE_NOT_FOUND', 'no such template')
  if (cur.status !== 'active') throw new TemplateError('TEMPLATE_RETIRED', 'a retired template is history; create a new one')
  if (patch.trigger && !TRIGGERS.includes(patch.trigger)) throw new TemplateError('VALIDATION_FAILED', `trigger must be one of ${TRIGGERS.join(', ')}`)
  if (patch.items) checkItems(patch.items)
  await tx.query(
    `UPDATE task_templates SET name = coalesce($2, name), trigger_event = coalesce($3, trigger_event) WHERE id = $1`,
    [id, patch.name?.trim().slice(0, 120) || null, patch.trigger ?? null])
  if (patch.items) {
    await tx.query(`DELETE FROM task_template_items WHERE template_id = $1`, [id])
    await writeItems(tx, tid, id, patch.items)
  }
  return (await getTemplate(tx, id))!
}

export async function retireTemplate(tx: PoolClient, id: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE task_templates SET status = 'retired' WHERE id = $1 AND status = 'active'`, [id])
  if (!rowCount) throw new TemplateError('TEMPLATE_NOT_FOUND', 'no such active template')
}

async function writeItems(tx: PoolClient, tid: string, templateId: string, items: readonly TemplateItemInput[]): Promise<void> {
  for (const [i, it] of items.entries()) {
    await tx.query(
      `INSERT INTO task_template_items
         (tenant_id, template_id, title, description, assignee_rule, assignee_ref, due_offset_days, sequence, blocks_completion, requires_attachment)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [tid, templateId, it.title.trim(), it.description?.trim() || null, it.assigneeRule, it.assigneeRef ?? null,
       it.dueOffsetDays ?? 0, i + 1, it.blocksCompletion ?? false, it.requiresAttachment ?? false])
  }
}

/** The active template for a trigger, if the company has exactly one: what fires automatically. */
export async function templateForTrigger(tx: PoolClient, trigger: Trigger): Promise<TaskTemplate | null> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM task_templates WHERE trigger_event = $1 AND status = 'active' ORDER BY name LIMIT 2`, [trigger])
  if (rows.length !== 1) return null
  return getTemplate(tx, rows[0]!.id)
}

/**
 * Resolves who a rule means for a given employee: their manager's login, an
 * HR/IT/finance role holder, the employee's own login, or a named user. Null
 * when nobody fits — the caller decides whether that item is skipped or lands
 * on HR as a fallback.
 */
export async function resolveAssignees(
  tx: PoolClient, employeeId: string,
): Promise<(rule: string, ref: string | null) => string | undefined> {
  const q = async (sql: string, params: unknown[]): Promise<string | undefined> =>
    (await tx.query<{ id: string }>(sql, params)).rows[0]?.id
  const self = await q(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])
  const manager = await q(
    `SELECT u.id FROM employee_assignments a JOIN app_users u ON u.employee_id = a.manager_employee_id AND u.status = 'active'
      WHERE a.employee_id = $1 AND a.superseded_at IS NULL AND (a.effective_to IS NULL OR a.effective_to > CURRENT_DATE)
      ORDER BY a.effective_from DESC LIMIT 1`, [employeeId])
  const byRole = async (roles: string[]): Promise<string | undefined> => q(
    `SELECT u.id FROM app_users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.status = 'active' AND r.role = ANY($1) ORDER BY array_position($1, r.role), u.created_at LIMIT 1`, [roles])
  const hr = await byRole(['hr_admin', 'org_admin'])
  const it = await byRole(['it_admin', 'org_admin', 'hr_admin'])
  const finance = await byRole(['finance', 'payroll_admin', 'org_admin'])
  return (rule, ref) => {
    switch (rule) {
      case 'employee': return self
      case 'manager': return manager ?? hr
      case 'hr': return hr
      case 'it': return it
      case 'finance': return finance
      case 'named_user': return ref ?? undefined
      default: return undefined
    }
  }
}
