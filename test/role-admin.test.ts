/**
 * Role administration: custom roles edit and retire, users get and lose roles
 * with the two guards (not your own, never the last admin), and a
 * department-scoped role sees exactly its departments — through the same
 * scope check every route already uses.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser, loadAuthzContext } from '../src/auth/index.ts'
import { assertScope } from '../src/authz/permissions.ts'
import { createUnit } from '../src/people/org.ts'
import {
  createCustomRole, listCustomRoles, listUsers, retireCustomRole, roleMatrix, setUserRoles, updateCustomRole, reinstateCustomRole,
} from '../src/authz/admin.ts'

let A: Tenant
const ids: Record<string, string> = {}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    ids.admin = await createUser(tx, { tenantId: A.id, email: 'admin@a.test', fullName: 'Admin', password: 'a-long-password-1', roles: ['org_admin'] })
    ids.admin2 = await createUser(tx, { tenantId: A.id, email: 'admin2@a.test', fullName: 'Admin Two', password: 'a-long-password-1', roles: ['org_admin'] })
    ids.priya = await createUser(tx, { tenantId: A.id, email: 'priya@a.test', fullName: 'Priya', password: 'a-long-password-1', roles: ['employee'] })
    for (const code of ['CHE', 'HYD']) await createUnit(tx, { kind: 'department', code, name: code })
    const emp = async (n: string, dept: string) => {
      const id = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,$2,DATE '2025-01-01') RETURNING id`, [A.id, n])).rows[0]!.id
      await tx.query(`INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from) VALUES ($1,$2,$3,'x',DATE '2025-01-01')`, [A.id, id, dept])
      return id
    }
    ids.che1 = await emp('CHE-1', 'CHE'); ids.che2 = await emp('CHE-2', 'CHE'); ids.hyd1 = await emp('HYD-1', 'HYD')
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('custom roles', () => {
  it('create, edit permissions and scope, retire (removing holders), reinstate', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(createCustomRole(tx, { name: 'org_admin', permissions: ['employee.read'] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createCustomRole(tx, { name: 'X', permissions: ['fly.high'] })).rejects.toMatchObject({ code: 'UNKNOWN_PERMISSION' })
      await expect(createCustomRole(tx, { name: 'X', permissions: ['employee.read'], dataScope: 'department' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createCustomRole(tx, { name: 'X', permissions: ['employee.read'], dataScope: 'department', departmentCodes: ['NOPE'] })).rejects.toMatchObject({ code: 'UNKNOWN_UNIT' })

      const che = await createCustomRole(tx, { name: 'Chennai HR', permissions: ['employee.read', 'leave.approve'], dataScope: 'department', departmentCodes: ['che'] })
      expect(che.department_codes).toEqual(['CHE'])
      await expect(createCustomRole(tx, { name: 'Chennai HR', permissions: ['employee.read'] })).rejects.toMatchObject({ code: 'ROLE_EXISTS' })

      const r = await setUserRoles(tx, { userId: ids.priya!, roles: ['employee', 'Chennai HR'], actorUserId: ids.admin! })
      expect(r).toEqual({ roles: ['Chennai HR', 'employee'], added: ['Chennai HR'], removed: [] })
      expect((await listCustomRoles(tx))[0]!.holders).toBe(1)

      const edited = await updateCustomRole(tx, che.id, { permissions: ['employee.read', 'leave.approve', 'attendance.read'], departmentCodes: ['CHE', 'HYD'] })
      expect(edited.permissions).toContain('attendance.read')
      expect(edited.department_codes).toEqual(['CHE', 'HYD'])

      const retired = await retireCustomRole(tx, che.id)
      expect(retired.removedFrom).toBe(1)
      expect((await tx.query(`SELECT 1 FROM user_roles WHERE user_id = $1 AND role = 'Chennai HR'`, [ids.priya])).rowCount).toBe(0)
      await expect(updateCustomRole(tx, che.id, { description: 'x' })).rejects.toMatchObject({ code: 'ROLE_RETIRED' })
      await reinstateCustomRole(tx, che.id)
      await updateCustomRole(tx, che.id, { departmentCodes: ['CHE'] })
      await setUserRoles(tx, { userId: ids.priya!, roles: ['employee', 'Chennai HR'], actorUserId: ids.admin! })
    })
  })

  it('a department-scoped role sees its departments and nothing else, via assertScope', async () => {
    await withTenant(A.id, async (tx) => {
      const session = { tenantId: A.id, userId: ids.priya!, sessionId: 'test' }
      const ctx = await loadAuthzContext(tx, session)
      expect(ctx.scope).toBe('reports')
      expect(ctx.permissions.has('leave.approve')).toBe(true)
      expect(() => assertScope(ctx, ids.che1!)).not.toThrow()
      expect(() => assertScope(ctx, ids.che2!)).not.toThrow()
      expect(() => assertScope(ctx, ids.hyd1!)).toThrow()
      // the fixture's own employee is in neither department
      expect(() => assertScope(ctx, A.employeeId)).toThrow()
    })
  })
})

describe('user roles', () => {
  it('refuses self-change, unknown roles, and removing the last admin; lists users and the matrix', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(setUserRoles(tx, { userId: ids.admin!, roles: ['employee'], actorUserId: ids.admin! })).rejects.toMatchObject({ code: 'SELF_ROLE_CHANGE' })
      await expect(setUserRoles(tx, { userId: ids.priya!, roles: ['wizard'], actorUserId: ids.admin! })).rejects.toMatchObject({ code: 'UNKNOWN_ROLE' })
      await expect(setUserRoles(tx, { userId: ids.priya!, roles: [], actorUserId: ids.admin! })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      // two admins: one may be demoted; then the other may not
      const demote = await setUserRoles(tx, { userId: ids.admin2!, roles: ['hr_admin'], actorUserId: ids.admin! })
      expect(demote.removed).toEqual(['org_admin'])
      await expect(setUserRoles(tx, { userId: ids.admin!, roles: ['hr_admin'], actorUserId: ids.admin2! })).rejects.toMatchObject({ code: 'LAST_ADMIN' })

      const users = await listUsers(tx, { q: 'priya' })
      expect(users).toHaveLength(1)
      expect(users[0]!.roles).toEqual(['Chennai HR', 'employee'])
      const matrix = await roleMatrix(tx)
      const che = matrix.find((m) => m.role === 'Chennai HR')!
      expect(che.seeded).toBe(false)
      expect(che.scope).toBe('department: CHE')
      expect(che.holders.map((h) => h.email)).toEqual(['priya@a.test'])
      expect(matrix.find((m) => m.role === 'org_admin')!.holders.map((h) => h.email)).toEqual(['admin@a.test'])
    })
  })
})
