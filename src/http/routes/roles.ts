/** Roles. */
import type { Router } from '../router.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  PERMISSIONS,
  ROLE_PERMISSIONS,
  approve,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/roles',
    { summary: 'Seeded roles, custom roles and the full permission vocabulary',
      tag: 'config', permission: 'roles.write' },
    authed('roles.write', async (ctx) => {
      const { rows: custom } = await ctx.tx.query(
        `SELECT id, name, description, permissions, data_scope FROM custom_roles ORDER BY name`)
      return ok({
        seededRoles: Object.entries(ROLE_PERMISSIONS).map(([name, d]) => ({
          name, scope: d.scope, permissions: d.permissions,
        })),
        customRoles: custom,
        allPermissions: PERMISSIONS,
      })
    }))

  router.post('/api/v1/roles',
    { summary: 'Create a custom role for this company', tag: 'config', permission: 'roles.write',
      requestExample: { name: 'Regional HR', permissions: ['employee.read', 'leave.approve'], dataScope: 'reports' } },
    authed('roles.write', async (ctx) => {
      const b = requireBody<{ name: string; permissions: string[]; dataScope?: string; description?: string }>(
        ctx.req, ['name', 'permissions'])
      const unknown = b.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p))
      if (unknown.length) {
        throw new HttpError(422, 'UNKNOWN_PERMISSION', `not a permission: ${unknown.join(', ')}`, { unknown })
      }
      const { rows } = await ctx.tx.query<{ id: string }>(
        `INSERT INTO custom_roles (tenant_id, name, description, permissions, data_scope)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [ctx.auth.tenantId, b.name, b.description ?? null, b.permissions, b.dataScope ?? 'self'])
      return created({ id: rows[0]!.id })
    }))
}
