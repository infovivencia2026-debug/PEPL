/** Group console (holding + subsidiaries, aggregates only) and reseller console. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, asUuid, emit } from './deps.ts'
import { createGroup, myGroups, assertAdmin, addAdmin, listMembers, inviteMember, membershipsOf, acceptMembership, leaveGroup, groupOverview, resellerProvision, resellerBook } from '../../control-plane/groups.ts'

export function register(router: Router): void {
  router.get('/api/v1/groups', { summary: 'Groups I administer, and invitations / memberships of THIS company', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => ok({ groups: await myGroups(ctx.auth.userId, ctx.auth.tenantId), memberships: await membershipsOf(ctx.auth.tenantId) })))

  router.post('/api/v1/groups', { summary: 'Create a group (this company is the owner and first member) or a reseller account', tag: 'groups', permission: 'group.manage',
    requestExample: { name: 'Acme Holdings', kind: 'group' } },
    authed('group.manage', async (ctx) => {
      const b = requireBody<{ name: string; kind: 'group' | 'reseller' }>(ctx.req, ['name', 'kind'])
      const g = await createGroup({ name: b.name, kind: b.kind, ownerTenantId: ctx.auth.tenantId, adminUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'group.created', entityType: 'group', entityId: g.id, actorUserId: ctx.auth.userId, metadata: { kind: g.kind, name: g.name } })
      return created(g)
    }))

  router.get('/api/v1/groups/:id/members', { summary: 'Members and their invitation status', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => { const g = await assertAdmin(asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, ctx.auth.tenantId); return ok({ group: g, members: await listMembers(g.id) }) }))

  router.post('/api/v1/groups/:id/members', { summary: 'Invite a company by its org admin\'s email; nothing is visible until they accept', tag: 'groups', permission: 'group.manage', requestExample: { adminEmail: 'admin@subsidiary.example' } },
    authed('group.manage', async (ctx) => {
      const g = await assertAdmin(asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, ctx.auth.tenantId)
      const b = requireBody<{ adminEmail: string }>(ctx.req, ['adminEmail'])
      return created(await inviteMember({ groupId: g.id, adminEmail: b.adminEmail }))
    }))

  router.post('/api/v1/groups/:id/admins', { summary: 'Add another user of the owner company as a console admin', tag: 'groups', permission: 'group.manage', requestExample: { userId: '…' } },
    authed('group.manage', async (ctx) => {
      const g = await assertAdmin(asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, ctx.auth.tenantId)
      const userId = asUuid(requireBody<{ userId: string }>(ctx.req, ['userId']).userId, 'userId')
      if (!(await ctx.tx.query(`SELECT 1 FROM app_users WHERE id = $1 AND status = 'active'`, [userId])).rowCount) throw new HttpError(404, 'NOT_FOUND', 'no such user in this company')
      await addAdmin(g.id, userId); return noContent()
    }))

  router.post('/api/v1/groups/:id/accept', { summary: 'Accept an invitation on behalf of THIS company (its org admin consents to aggregate visibility)', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      await acceptMembership({ groupId: id, tenantId: ctx.auth.tenantId, userId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'group.membership.accepted', entityType: 'group', entityId: id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.post('/api/v1/groups/:id/leave', { summary: 'Leave a group; the owner stops seeing this company at once', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      await leaveGroup({ groupId: id, tenantId: ctx.auth.tenantId, userId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'group.membership.left', entityType: 'group', entityId: id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.get('/api/v1/groups/:id/overview', { summary: 'The console: one aggregate card per accepted member (headcount, attendance today, last locked payroll, approvals, compliance score); every read is in the platform audit', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => ok(await groupOverview({ groupId: asUuid(ctx.req.params.id, 'id'), userId: ctx.auth.userId, tenantId: ctx.auth.tenantId }))))

  router.get('/api/v1/groups/:id/book', { summary: 'Reseller book: companies provisioned under this reseller with plan, status and headcount', tag: 'groups', permission: 'group.manage' },
    authed('group.manage', async (ctx) => ok({ companies: await resellerBook({ groupId: asUuid(ctx.req.params.id, 'id'), userId: ctx.auth.userId, tenantId: ctx.auth.tenantId }) })))

  router.post('/api/v1/groups/:id/provision', { summary: 'Reseller: provision a company on a plan; its org admin is the customer', tag: 'groups', permission: 'group.manage',
    requestExample: { legalName: 'Sharma Traders Pvt Ltd', displayName: 'Sharma Traders', planCode: 'growth', adminEmail: 'owner@sharma.example', adminName: 'R. Sharma', stateCode: 'MH', organisationType: 'retail' } },
    authed('group.manage', async (ctx) => {
      const b = requireBody<{ legalName: string; displayName: string; planCode: string; adminEmail: string; adminName: string; stateCode?: string; organisationType?: string }>(ctx.req, ['legalName', 'displayName', 'planCode', 'adminEmail', 'adminName'])
      const r = await resellerProvision({ groupId: asUuid(ctx.req.params.id, 'id'), userId: ctx.auth.userId, tenantId: ctx.auth.tenantId, input: b })
      await emit(ctx.tx, { action: 'group.tenant.provisioned', entityType: 'group', entityId: ctx.req.params.id ?? '', actorUserId: ctx.auth.userId, metadata: { tenantId: r.tenantId, plan: b.planCode } })
      return created(r)
    }))
}
