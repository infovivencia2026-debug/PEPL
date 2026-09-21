/**
 * Authorization.
 *
 * Evaluated on PERMISSION STRINGS at the service boundary, never on role names
 * in a controller — so background jobs, imports and any future AI caller pass
 * through the identical gate, and custom roles are a table rather than a rewrite.
 *
 * Two independent checks on every call: the VERB (may they do it at all?) and
 * the SCOPE (to this person?).
 */

export const PERMISSIONS = [
  'employee.read', 'employee.write',
  'compensation.read', 'compensation.write',
  'bank.read', 'bank.export',
  'attendance.read', 'attendance.correct',
  'attendance.close_period', 'attendance.reopen_period',
  'leave.read', 'leave.apply', 'leave.approve', 'leave.policy.write', 'leave.balance.adjust',
  'payroll.read', 'payroll.process', 'payroll.approve', 'payroll.lock', 'payroll.revise',
  'incentive.read', 'incentive.write', 'incentive.approve',
  'ticket.read', 'ticket.write', 'ticket.assign',
  'task.read', 'task.write', 'task.assign',
  'document.read', 'document.write',
  'announcement.create', 'announcement.read',
  'approval.act',
  'audit.read',
  'settings.write', 'roles.write',
  'import.run', 'report.read',
  'expense.read', 'expense.claim', 'expense.write', 'expense.policy.write',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export type DataScope = 'all' | 'reports' | 'self'
/** A custom role may also be scoped to departments; it resolves to `reports` over those people. */
export type RoleScope = DataScope | 'department'

/**
 * Seeded roles. A tenant may create its own; these are the defaults every
 * company recognises (docs/architecture/standard-company-model.md §8).
 *
 * The critical boundary, and the one HR systems most often get wrong:
 * A MANAGER SEES ATTENDANCE AND LEAVE, NEVER COMPENSATION.
 */
export const ROLE_PERMISSIONS: Readonly<Record<string, { permissions: Permission[]; scope: DataScope }>> =
  Object.freeze({
    org_admin: {
      scope: 'all',
      permissions: [
        'expense.read', 'expense.claim', 'expense.write', 'expense.policy.write',...PERMISSIONS],
    },
    hr_admin: {
      scope: 'all',
      permissions: [
        'expense.read', 'expense.claim', 'expense.write', 'expense.policy.write',
        'employee.read', 'employee.write',
        'attendance.read', 'attendance.correct',
        'attendance.close_period', 'attendance.reopen_period',
        'leave.read', 'leave.apply', 'leave.approve', 'leave.policy.write', 'leave.balance.adjust',
        'ticket.read', 'ticket.write', 'ticket.assign',
        'task.read', 'task.write', 'task.assign',
        'document.read', 'document.write',
        'announcement.create', 'announcement.read',
        'approval.act', 'audit.read', 'import.run', 'report.read',
        'incentive.read',
        // deliberately NOT compensation.* or bank.*
      ],
    },
    payroll_admin: {
      scope: 'all',
      permissions: [
        'expense.read', 'expense.claim',
        'employee.read',
        'compensation.read', 'compensation.write',
        'document.read',
        'bank.read', 'bank.export',
        'payroll.read', 'payroll.process', 'payroll.approve', 'payroll.lock', 'payroll.revise',
        'incentive.read', 'incentive.write', 'incentive.approve',
        'attendance.read', 'leave.read', 'report.read', 'audit.read',
      ],
    },
    finance: {
      scope: 'all',
      // bank.read as well as bank.export: whoever may generate the payment file
      // must be able to see the batches already generated, or they cannot tell a
      // retry from a second payment.
      permissions: [
        'expense.read', 'expense.write',
        'payroll.read', 'bank.read', 'bank.export', 'report.read',
        'approval.act', 'incentive.read',
      ],
    },
    manager: {
      scope: 'reports',
      permissions: [
        'expense.read', 'expense.claim',
        'employee.read',
        'attendance.read', 'attendance.correct',
        'leave.read', 'leave.approve',
        'task.read', 'task.write', 'task.assign',
        'ticket.read',
        'approval.act', 'announcement.read',
      ],
    },
    employee: {
      scope: 'self',
      permissions: [
        'expense.read', 'expense.claim',
        'employee.read',
        'attendance.read', 'leave.read', 'leave.apply',
        'payroll.read', 'document.read', 'document.write', 'ticket.read', 'ticket.write',
        'task.read', 'announcement.read',
      ],
    },
    auditor: {
      scope: 'all',
      permissions: [
        'expense.read',
        'employee.read', 'attendance.read', 'leave.read', 'payroll.read',
        'audit.read', 'report.read', 'compensation.read',
      ],
    },
  })

export class AuthzError extends Error {
  readonly code: string
  readonly status: number
  constructor(code: string, message: string, status = 403) {
    super(message)
    this.code = code
    this.status = status
    this.name = 'AuthzError'
  }
}

export interface AuthzContext {
  tenantId: string
  userId: string
  employeeId?: string
  roles: string[]
  permissions: Set<string>
  scope: DataScope
  /** Employee ids this user manages, resolved once per request. */
  reportIds: Set<string>
}

export function buildContext(input: {
  tenantId: string
  userId: string
  employeeId?: string
  roles: string[]
  customRoles?: { permissions: string[]; data_scope: RoleScope }[]
  reportIds?: string[]
}): AuthzContext {
  const permissions = new Set<string>()
  let scope: DataScope = 'self'
  const widen = (s: DataScope): void => {
    const rank = { self: 0, reports: 1, all: 2 } as const
    if (rank[s] > rank[scope]) scope = s
  }

  for (const role of input.roles) {
    const def = ROLE_PERMISSIONS[role]
    if (!def) continue
    for (const p of def.permissions) permissions.add(p)
    widen(def.scope)
  }
  for (const custom of input.customRoles ?? []) {
    for (const p of custom.permissions) permissions.add(p)
    // Department scope arrives with its people already in reportIds.
    widen(custom.data_scope === 'department' ? 'reports' : custom.data_scope)
  }

  return {
    tenantId: input.tenantId,
    userId: input.userId,
    employeeId: input.employeeId,
    roles: input.roles,
    permissions,
    scope,
    reportIds: new Set(input.reportIds ?? []),
  }
}

/** The VERB check. */
export function assertPermission(ctx: AuthzContext, permission: Permission): void {
  if (!ctx.permissions.has(permission)) {
    throw new AuthzError('PERMISSION_DENIED', `this action requires ${permission}`)
  }
}

export function can(ctx: AuthzContext, permission: Permission): boolean {
  return ctx.permissions.has(permission)
}

/**
 * The SCOPE check, evaluated independently of the verb.
 *
 * Returns 404 rather than 403 for a record outside the caller's scope: telling
 * someone a record exists but is forbidden is itself a disclosure.
 */
export function assertScope(ctx: AuthzContext, targetEmployeeId: string | undefined): void {
  if (!targetEmployeeId) return
  if (ctx.scope === 'all') return
  if (ctx.scope === 'reports') {
    if (targetEmployeeId === ctx.employeeId || ctx.reportIds.has(targetEmployeeId)) return
    throw new AuthzError('NOT_FOUND', 'no such record', 404)
  }
  if (targetEmployeeId !== ctx.employeeId) {
    throw new AuthzError('NOT_FOUND', 'no such record', 404)
  }
}

/** SQL fragment restricting a query to the caller's data scope. */
export function scopeFilter(ctx: AuthzContext, column = 'employee_id'): { sql: string; params: string[] } {
  if (ctx.scope === 'all') return { sql: 'TRUE', params: [] }
  const ids = ctx.scope === 'reports'
    ? [...ctx.reportIds, ctx.employeeId].filter(Boolean) as string[]
    : [ctx.employeeId].filter(Boolean) as string[]
  if (ids.length === 0) return { sql: 'FALSE', params: [] }
  return { sql: `${column} = ANY($SCOPE)`, params: ids }
}
