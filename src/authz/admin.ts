/**
 * Role administration — see 042_role_admin.sql.
 *
 * Two guards matter more than the CRUD: a company can never remove its LAST
 * org_admin (a tenant nobody can administer is a support ticket to us), and
 * a person cannot change their own roles (an admin who could grant themself
 * anything makes the audit trail decorative).
 */
import type { PoolClient } from 'pg'
import { PERMISSIONS, ROLE_PERMISSIONS, type RoleScope } from './permissions.ts'

export class RoleError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'RoleError'
  }
}

export interface CustomRole {
  id: string
  name: string
  description: string | null
  permissions: string[]
  data_scope: RoleScope
  department_codes: string[]
  status: 'active' | 'retired'
}

const COLUMNS = 'id, name, description, permissions, data_scope, department_codes, status'
const SEEDED = new Set(Object.keys(ROLE_PERMISSIONS))

function checkRole(i: { name?: string; permissions?: string[]; dataScope?: RoleScope; departmentCodes?: string[] }): void {
  if (i.name !== undefined) {
    if (typeof i.name !== 'string') throw new RoleError('VALIDATION_FAILED', 'name must be text')
    const n = i.name.trim()
    if (!n || n.length > 60) throw new RoleError('VALIDATION_FAILED', 'name is 1–60 characters')
    if (SEEDED.has(n)) throw new RoleError('VALIDATION_FAILED', `"${n}" is a seeded role name`)
  }
  if (i.permissions !== undefined) {
    if (!Array.isArray(i.permissions) || !i.permissions.length) throw new RoleError('VALIDATION_FAILED', 'a role needs at least one permission')
    const unknown = i.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p))
    if (unknown.length) throw new RoleError('UNKNOWN_PERMISSION', `not a permission: ${unknown.join(', ')}`)
  }
  if (i.dataScope !== undefined && !['all', 'reports', 'self', 'department'].includes(i.dataScope)) {
    throw new RoleError('VALIDATION_FAILED', 'dataScope is all, reports, self or department')
  }
  if (i.departmentCodes !== undefined && (!Array.isArray(i.departmentCodes) || i.departmentCodes.some((c) => typeof c !== 'string'))) {
    throw new RoleError('VALIDATION_FAILED', 'departmentCodes must be a list of department codes')
  }
  if (i.dataScope === 'department' && !(i.departmentCodes?.length)) {
    throw new RoleError('VALIDATION_FAILED', 'a department-scoped role needs departmentCodes')
  }
}

async function checkDepartments(tx: PoolClient, codes: string[]): Promise<string[]> {
  const upper = [...new Set(codes.map((c) => c.trim().toUpperCase()))]
  const { rows } = await tx.query<{ code: string }>(`SELECT code FROM org_units WHERE kind = 'department' AND status = 'active' AND code = ANY($1)`, [upper])
  const missing = upper.filter((c) => !rows.some((r) => r.code === c))
  if (missing.length) throw new RoleError('UNKNOWN_UNIT', `not an active department: ${missing.join(', ')}`)
  return upper
}

export async function listCustomRoles(tx: PoolClient, includeRetired = false): Promise<(CustomRole & { holders: number })[]> {
  const { rows } = await tx.query<CustomRole & { holders: number }>(
    `SELECT ${COLUMNS}, (SELECT count(*)::int FROM user_roles ur WHERE ur.tenant_id = c.tenant_id AND ur.role = c.name) AS holders
       FROM custom_roles c WHERE $1 OR status = 'active' ORDER BY name`, [includeRetired])
  return rows
}

export async function createCustomRole(
  tx: PoolClient,
  i: { name: string; description?: string; permissions: string[]; dataScope?: RoleScope; departmentCodes?: string[] },
): Promise<CustomRole> {
  const dataScope = i.dataScope ?? 'self'
  checkRole({ ...i, dataScope })
  const departments = dataScope === 'department' ? await checkDepartments(tx, i.departmentCodes!) : []
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if ((await tx.query(`SELECT 1 FROM custom_roles WHERE name = $1`, [i.name.trim()])).rowCount) throw new RoleError('ROLE_EXISTS', 'a role with that name exists (retired roles keep their name)')
  const { rows } = await tx.query<CustomRole>(
    `INSERT INTO custom_roles (tenant_id, name, description, permissions, data_scope, department_codes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
    [tid, i.name.trim(), i.description ?? null, [...new Set(i.permissions)], dataScope, departments])
  return rows[0]!
}

/** Permissions and scope may change — every holder's next request reflects it. The name is the identity user_roles points at. */
export async function updateCustomRole(
  tx: PoolClient,
  id: string,
  patch: { description?: string | null; permissions?: string[]; dataScope?: RoleScope; departmentCodes?: string[] },
): Promise<CustomRole> {
  const { rows: cur } = await tx.query<CustomRole>(`SELECT ${COLUMNS} FROM custom_roles WHERE id = $1`, [id])
  const role = cur[0]
  if (!role) throw new RoleError('NOT_FOUND', 'no such role')
  if (role.status === 'retired') throw new RoleError('ROLE_RETIRED', 'reinstate it before editing')
  const dataScope = patch.dataScope ?? role.data_scope
  const codes = patch.departmentCodes ?? role.department_codes
  checkRole({ permissions: patch.permissions, dataScope, departmentCodes: codes })
  const departments = dataScope === 'department' ? await checkDepartments(tx, codes) : []
  const { rows } = await tx.query<CustomRole>(
    `UPDATE custom_roles SET description = $2, permissions = $3, data_scope = $4, department_codes = $5, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, patch.description === undefined ? role.description : patch.description,
     patch.permissions ? [...new Set(patch.permissions)] : role.permissions, dataScope, departments])
  return rows[0]!
}

/** Retiring removes it from everyone who held it; the count comes back so the screen can say so. */
export async function retireCustomRole(tx: PoolClient, id: string): Promise<{ role: CustomRole; removedFrom: number }> {
  const { rows } = await tx.query<CustomRole>(
    `UPDATE custom_roles SET status = 'retired', retired_at = now(), updated_at = now() WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new RoleError('NOT_FOUND', 'no active role with that id')
  const r = await tx.query(`DELETE FROM user_roles WHERE role = $1`, [rows[0].name])
  return { role: rows[0], removedFrom: r.rowCount ?? 0 }
}

export async function reinstateCustomRole(tx: PoolClient, id: string): Promise<CustomRole> {
  const { rows } = await tx.query<CustomRole>(
    `UPDATE custom_roles SET status = 'active', retired_at = NULL, updated_at = now() WHERE id = $1 AND status = 'retired' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new RoleError('NOT_FOUND', 'no retired role with that id')
  return rows[0]
}

export interface UserRow {
  id: string
  email: string
  full_name: string
  status: string
  employee_id: string | null
  employee_number: string | null
  roles: string[]
  last_login_at: string | null
}

export async function listUsers(tx: PoolClient, opts: { q?: string; limit?: number } = {}): Promise<UserRow[]> {
  const { rows } = await tx.query<UserRow>(
    `SELECT u.id, u.email, u.full_name, u.status, u.employee_id, e.employee_number, u.last_login_at::text,
            coalesce(array_agg(ur.role ORDER BY ur.role) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles
       FROM app_users u
       LEFT JOIN employees e ON (e.tenant_id, e.id) = (u.tenant_id, u.employee_id)
       LEFT JOIN user_roles ur ON (ur.tenant_id, ur.user_id) = (u.tenant_id, u.id)
      WHERE u.status <> 'erased'
        AND ($1::text IS NULL OR u.email ILIKE '%' || $1 || '%' OR u.full_name ILIKE '%' || $1 || '%' OR e.employee_number ILIKE '%' || $1 || '%')
      GROUP BY u.id, u.email, u.full_name, u.status, u.employee_id, e.employee_number, u.last_login_at
      ORDER BY u.full_name
      LIMIT $2`, [opts.q?.trim() || null, Math.min(opts.limit ?? 200, 1000)])
  return rows
}

/** Replaces a person's roles. Names must be seeded or active custom roles. */
export async function setUserRoles(
  tx: PoolClient,
  args: { userId: string; roles: string[]; actorUserId: string },
): Promise<{ roles: string[]; added: string[]; removed: string[] }> {
  if (args.userId === args.actorUserId) throw new RoleError('SELF_ROLE_CHANGE', 'you cannot change your own roles; ask another administrator')
  const wanted = [...new Set(args.roles.map((r) => r.trim()).filter(Boolean))]
  if (!wanted.length) throw new RoleError('VALIDATION_FAILED', 'a user needs at least one role')
  const { rows: custom } = await tx.query<{ name: string }>(`SELECT name FROM custom_roles WHERE status = 'active'`)
  const valid = new Set([...SEEDED, ...custom.map((c) => c.name)])
  const unknown = wanted.filter((r) => !valid.has(r))
  if (unknown.length) throw new RoleError('UNKNOWN_ROLE', `not a role here: ${unknown.join(', ')}`)
  const user = await tx.query<{ status: string }>(`SELECT status FROM app_users WHERE id = $1`, [args.userId])
  if (!user.rows[0]) throw new RoleError('NOT_FOUND', 'no such user')

  const { rows: current } = await tx.query<{ role: string }>(`SELECT role FROM user_roles WHERE user_id = $1`, [args.userId])
  const have = new Set(current.map((r) => r.role))
  const removed = [...have].filter((r) => !wanted.includes(r))
  const added = wanted.filter((r) => !have.has(r))

  if (removed.includes('org_admin')) {
    const others = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM user_roles ur JOIN app_users u ON (u.tenant_id, u.id) = (ur.tenant_id, ur.user_id)
        WHERE ur.role = 'org_admin' AND ur.user_id <> $1 AND u.status = 'active'`, [args.userId])
    if (Number(others.rows[0]!.n) === 0) throw new RoleError('LAST_ADMIN', 'this is the only administrator; grant org_admin to someone else first')
  }
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if (removed.length) await tx.query(`DELETE FROM user_roles WHERE user_id = $1 AND role = ANY($2)`, [args.userId, removed])
  for (const role of added) {
    await tx.query(`INSERT INTO user_roles (tenant_id, user_id, role, granted_by_user_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [tid, args.userId, role, args.actorUserId])
  }
  return { roles: wanted.sort(), added, removed }
}

/** Who holds what: every role with its holders, for the "who can do this" question. */
export async function roleMatrix(tx: PoolClient): Promise<{ role: string; seeded: boolean; permissions: string[]; scope: string; holders: { id: string; full_name: string; email: string }[] }[]> {
  const { rows: holders } = await tx.query<{ role: string; id: string; full_name: string; email: string }>(
    `SELECT ur.role, u.id, u.full_name, u.email FROM user_roles ur JOIN app_users u ON (u.tenant_id, u.id) = (ur.tenant_id, ur.user_id)
      WHERE u.status = 'active' ORDER BY ur.role, u.full_name`)
  const custom = await listCustomRoles(tx)
  const by = (role: string) => holders.filter((h) => h.role === role).map(({ id, full_name, email }) => ({ id, full_name, email }))
  return [
    ...Object.entries(ROLE_PERMISSIONS).map(([role, d]) => ({ role, seeded: true, permissions: [...d.permissions], scope: d.scope, holders: by(role) })),
    ...custom.map((c) => ({ role: c.name, seeded: false, permissions: c.permissions,
      scope: c.data_scope === 'department' ? `department: ${c.department_codes.join(', ')}` : c.data_scope, holders: by(c.name) })),
  ]
}
