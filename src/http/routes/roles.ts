/** Roles: the vocabulary, custom roles, and who holds what. All `roles.write`. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, asUuid, emit, PERMISSIONS, ROLE_PERMISSIONS } from './deps.ts'
import {
  createCustomRole, listCustomRoles, listUsers, reinstateCustomRole, retireCustomRole, roleMatrix, setUserRoles, updateCustomRole,
} from '../../authz/admin.ts'
import type { RoleScope } from '../../authz/permissions.ts'

export function register(router: Router): void {
  router.get('/api/v1/roles',
    { summary: 'Seeded roles, custom roles (with holder counts) and the full permission vocabulary',
      tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => ok({
      seededRoles: Object.entries(ROLE_PERMISSIONS).map(([name, d]) => ({ name, scope: d.scope, permissions: d.permissions })),
      customRoles: await listCustomRoles(ctx.tx, ctx.req.query.get('includeRetired') === 'true'),
      allPermissions: PERMISSIONS,
    })))

  router.post('/api/v1/roles',
    { summary: 'Create a custom role', tag: 'config', permission: 'roles.write',
      requestExample: { name: 'Chennai HR', permissions: ['employee.read', 'leave.approve'], dataScope: 'department', departmentCodes: ['CHE'] } },
    authed('roles.write', async (ctx) => {
      const b = requireBody<{ name: string; permissions: string[]; dataScope?: RoleScope; description?: string; departmentCodes?: string[] }>(ctx.req, ['name', 'permissions'])
      const role = await createCustomRole(ctx.tx, b)
      await emit(ctx.tx, { action: 'roles.custom.changed', entityType: 'custom_role', entityId: role.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', name: role.name, permissions: role.permissions, scope: role.data_scope } })
      return created({ id: role.id, role })
    }))

  router.patch('/api/v1/roles/:id',
    { summary: 'Change a custom role\'s permissions, scope or description (holders see it on their next request)',
      tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ description?: string | null; permissions?: string[]; dataScope?: RoleScope; departmentCodes?: string[] }>(ctx.req, [])
      const role = await updateCustomRole(ctx.tx, id, b)
      await emit(ctx.tx, { action: 'roles.custom.changed', entityType: 'custom_role', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'update', name: role.name, fields: Object.keys(b), permissions: role.permissions, scope: role.data_scope } })
      return ok({ role })
    }))

  router.post('/api/v1/roles/:id/retire',
    { summary: 'Retire a custom role; it is removed from everyone who held it', tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await retireCustomRole(ctx.tx, id)
      await emit(ctx.tx, { action: 'roles.custom.changed', entityType: 'custom_role', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', name: r.role.name, removedFrom: r.removedFrom } })
      return ok(r)
    }))

  router.post('/api/v1/roles/:id/reinstate',
    { summary: 'Bring a retired custom role back (nobody holds it until reassigned)', tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => ok({ role: await reinstateCustomRole(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  router.get('/api/v1/roles/matrix',
    { summary: 'Who holds what: every role with its permissions and holders', tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => ok({ matrix: await roleMatrix(ctx.tx) })))

  router.get('/api/v1/users',
    { summary: 'Users with their roles (?q= searches name, email, employee number)', tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => ok({
      users: await listUsers(ctx.tx, { q: ctx.req.query.get('q') ?? undefined, limit: Number(ctx.req.query.get('limit') ?? 200) }),
    })))

  router.patch('/api/v1/users/:id/roles',
    { summary: 'Replace a user\'s roles (never your own; never the last org_admin)', tag: 'config', permission: 'roles.write',
      requestExample: { roles: ['manager', 'Chennai HR'] } },
    authed('roles.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ roles: string[] }>(ctx.req, ['roles'])
      if (!Array.isArray(b.roles)) throw new HttpError(422, 'VALIDATION_FAILED', 'roles is a list')
      const r = await setUserRoles(ctx.tx, { userId: id, roles: b.roles.map(String), actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'roles.user.changed', entityType: 'user', entityId: id,
        actorUserId: ctx.auth.userId, metadata: r })
      return ok(r)
    }))
}
