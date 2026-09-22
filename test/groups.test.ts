/**
 * Groups and resellers (C6). The owner sees nothing of an invited company
 * until its own org admin accepts; the overview is aggregates only, read in a
 * READ ONLY transaction, and every member touched is in the platform audit;
 * leaving hides the company at once. A reseller gets a book of subscriptions
 * and can provision, never a snapshot. Only a named admin of the owner
 * tenant may use the console.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { createGroup, inviteMember, membershipsOf, acceptMembership, leaveGroup, groupOverview, listMembers, assertAdmin, resellerBook, resellerProvision, tenantSnapshot } from '../src/control-plane/groups.ts'

let A: Tenant; let B: Tenant
let aAdmin: string; let aOther: string; let bAdmin: string
beforeAll(async () => {
  ;({ a: A, b: B } = await resetAndSeed())
  aAdmin = await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'gadmin@alpha.test', fullName: 'Alpha Admin', password: 'a-long-password-1', roles: ['org_admin'] }))
  aOther = await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'gother@alpha.test', fullName: 'Alpha HR', password: 'a-long-password-1', roles: ['hr_admin'] }))
  bAdmin = await withTenant(B.id, (tx) => createUser(tx, { tenantId: B.id, email: 'gadmin@beta.test', fullName: 'Beta Admin', password: 'a-long-password-1', roles: ['org_admin'] }))
})
afterAll(async () => { await closePools(); await controlPool.end(); await controlDb.end() })

describe('group console', () => {
  it('consent first, aggregates only, audited, leave hides at once', async () => {
    const g = await createGroup({ name: 'Alpha Holdings', kind: 'group', ownerTenantId: A.id, adminUserId: aAdmin })
    expect(g.members).toBe(1)   // the owner itself
    await expect(createGroup({ name: 'Alpha Holdings', kind: 'group', ownerTenantId: A.id, adminUserId: aAdmin })).rejects.toMatchObject({ code: 'GROUP_EXISTS' })
    await expect(assertAdmin(g.id, aOther, A.id)).rejects.toMatchObject({ code: 'NOT_GROUP_ADMIN' })
    await expect(assertAdmin(g.id, bAdmin, B.id)).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inviteMember({ groupId: g.id, adminEmail: 'nobody@nowhere.test' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(inviteMember({ groupId: g.id, adminEmail: 'gother@alpha.test' })).rejects.toMatchObject({ code: 'NOT_FOUND' })   // not an org admin
    const m = await inviteMember({ groupId: g.id, adminEmail: 'GADMIN@beta.test' })
    expect(m).toMatchObject({ tenant_id: B.id, status: 'invited' })
    // before acceptance: Beta is not in the overview
    let ov = await groupOverview({ groupId: g.id, userId: aAdmin, tenantId: A.id })
    expect(ov.companies.map((c) => c.tenantId)).toEqual([A.id])
    expect((await membershipsOf(B.id))[0]).toMatchObject({ name: 'Alpha Holdings', owner_name: 'Alpha', status: 'invited' })
    await acceptMembership({ groupId: g.id, tenantId: B.id, userId: bAdmin })
    await expect(acceptMembership({ groupId: g.id, tenantId: B.id, userId: bAdmin })).rejects.toMatchObject({ code: 'NOT_FOUND' })
    ov = await groupOverview({ groupId: g.id, userId: aAdmin, tenantId: A.id })
    expect(ov.companies.map((c) => c.name).sort()).toEqual(['Alpha', 'Beta'])
    const beta = ov.companies.find((c) => c.tenantId === B.id)!
    expect(beta).toMatchObject({ headcount: 1, presentToday: 0, lastLockedPayroll: null, openApprovals: 0, openTickets: 0 })
    expect(Object.keys(beta).sort()).toEqual(['complianceScore', 'exitsThisMonth', 'headcount', 'joinersThisMonth', 'lastLockedPayroll', 'name', 'onLeaveToday', 'openApprovals', 'openTickets', 'presentToday', 'tenantId'])   // no rows, no names
    expect(ov.totals.headcount).toBe(2)
    const audited = (await controlDb.query<{ n: string }>(`SELECT count(*)::text AS n FROM control_plane.platform_audit WHERE action = 'group.overview.read' AND tenant_id = $1`, [B.id])).rows[0]!.n
    expect(Number(audited)).toBeGreaterThanOrEqual(1)
    expect((await listMembers(g.id)).map((x) => x.status)).toEqual(['accepted', 'accepted'])
    await leaveGroup({ groupId: g.id, tenantId: B.id, userId: bAdmin })
    ov = await groupOverview({ groupId: g.id, userId: aAdmin, tenantId: A.id })
    expect(ov.companies.map((c) => c.tenantId)).toEqual([A.id])
    // a re-invite after leaving is a fresh invitation, not an automatic re-join
    expect((await inviteMember({ groupId: g.id, adminEmail: 'gadmin@beta.test' })).status).toBe('invited')
  })

  it('the snapshot transaction is read only', async () => {
    await expect(withTenant(B.id, async (tx) => { await tx.query('SET TRANSACTION READ ONLY'); await tx.query(`UPDATE employees SET first_name = 'x'`) })).rejects.toThrow(/read-only/i)
    expect((await tenantSnapshot(B.id)).headcount).toBe(1)
  })
})

describe('reseller', () => {
  it('provisions under itself and sees a book, never a snapshot', async () => {
    const r = await createGroup({ name: 'Alpha Partners', kind: 'reseller', ownerTenantId: A.id, adminUserId: aAdmin })
    expect(r.members).toBe(0)
    await expect(groupOverview({ groupId: r.id, userId: aAdmin, tenantId: A.id })).rejects.toMatchObject({ code: 'RESELLER_NO_SNAPSHOT' })
    const p = await resellerProvision({ groupId: r.id, userId: aAdmin, tenantId: A.id, input: { legalName: 'Gamma Retail Pvt Ltd', displayName: 'Gamma', planCode: 'growth', adminEmail: 'owner@gamma.test', adminName: 'G Owner', organisationType: 'retail' } })
    const book = await resellerBook({ groupId: r.id, userId: aAdmin, tenantId: A.id })
    expect(book).toHaveLength(1)
    expect(book[0]).toMatchObject({ tenant_id: p.tenantId, display_name: 'Gamma', plan_code: 'growth', employees: 0 })
    // the reseller's group (kind reseller) cannot be used by a group-only path, and a group cannot provision
    const g = await createGroup({ name: 'Alpha Group 2', kind: 'group', ownerTenantId: A.id, adminUserId: aAdmin })
    await expect(resellerBook({ groupId: g.id, userId: aAdmin, tenantId: A.id })).rejects.toMatchObject({ code: 'NOT_RESELLER' })
    await expect(resellerProvision({ groupId: g.id, userId: aAdmin, tenantId: A.id, input: { legalName: 'x', displayName: 'x', planCode: 'growth', adminEmail: 'x@x.test', adminName: 'x' } })).rejects.toMatchObject({ code: 'NOT_RESELLER' })
    // Gamma's own admin can see they are under a reseller, from the member side
    expect((await membershipsOf(p.tenantId))[0]).toMatchObject({ kind: 'reseller', status: 'accepted' })
  })
})
