/**
 * Groups (holding + subsidiaries) and resellers.
 *
 * Membership metadata lives in the control plane. A member company's data is
 * reached ONLY through `tenantSnapshot`, which runs on the app role in that
 * tenant's own context inside a READ ONLY transaction and returns counts,
 * totals and scores — never a row. It runs only for a membership the member's
 * own org admin has accepted, and every console read is in platform_audit.
 *
 * A reseller sees plan and status per company it provisioned; it never gets
 * a snapshot.
 */
import type { PoolClient } from 'pg'
import { controlDb, provisionTenant, type ProvisionInput } from './index.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { complianceScore } from '../payroll/compliance.ts'

export class GroupError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'GroupError' }
}

export interface Group { id: string; name: string; kind: 'group' | 'reseller'; owner_tenant_id: string; created_at: string; members: number }
export interface Member { tenant_id: string; display_name: string; status: string; invited_at: string; accepted_at: string | null; plan_code: string | null; subscription_status: string | null }

const audit = (tenantId: string | null, action: string, detail: Record<string, unknown>): Promise<unknown> =>
  controlDb.query(`INSERT INTO control_plane.platform_audit (tenant_id, action, detail) VALUES ($1,$2,$3::jsonb)`, [tenantId, action, JSON.stringify(detail)])

export async function createGroup(args: { name: string; kind: 'group' | 'reseller'; ownerTenantId: string; adminUserId: string }): Promise<Group> {
  const name = args.name?.trim()
  if (!name) throw new GroupError('VALIDATION_FAILED', 'name is required')
  if (!['group', 'reseller'].includes(args.kind)) throw new GroupError('VALIDATION_FAILED', 'kind is group or reseller')
  if ((await controlDb.query(`SELECT 1 FROM control_plane.groups WHERE owner_tenant_id = $1 AND name = $2`, [args.ownerTenantId, name])).rowCount) throw new GroupError('GROUP_EXISTS', 'a group by that name already exists')
  const { rows } = await controlDb.query<{ id: string }>(`INSERT INTO control_plane.groups (name, kind, owner_tenant_id) VALUES ($1,$2,$3) RETURNING id`, [name, args.kind, args.ownerTenantId])
  await controlDb.query(`INSERT INTO control_plane.group_admins (group_id, user_id) VALUES ($1,$2)`, [rows[0]!.id, args.adminUserId])
  // the owner is a member of its own group, already accepted
  if (args.kind === 'group') await controlDb.query(`INSERT INTO control_plane.group_members (group_id, tenant_id, status, accepted_at, accepted_by_user_id) VALUES ($1,$2,'accepted',now(),$3)`, [rows[0]!.id, args.ownerTenantId, args.adminUserId])
  await audit(args.ownerTenantId, 'group.created', { groupId: rows[0]!.id, kind: args.kind, name })
  return (await getGroup(rows[0]!.id))!
}
export async function getGroup(id: string): Promise<Group | null> {
  return (await controlDb.query<Group>(`SELECT g.id, g.name, g.kind, g.owner_tenant_id, g.created_at::text, (SELECT count(*)::int FROM control_plane.group_members m WHERE m.group_id = g.id AND m.status = 'accepted') AS members FROM control_plane.groups g WHERE g.id = $1`, [id])).rows[0] ?? null
}
/** Groups this user administers (owner side). */
export async function myGroups(userId: string, tenantId: string): Promise<Group[]> {
  return (await controlDb.query<Group>(`SELECT g.id, g.name, g.kind, g.owner_tenant_id, g.created_at::text, (SELECT count(*)::int FROM control_plane.group_members m WHERE m.group_id = g.id AND m.status = 'accepted') AS members
    FROM control_plane.groups g JOIN control_plane.group_admins a ON a.group_id = g.id WHERE a.user_id = $1 AND g.owner_tenant_id = $2 ORDER BY g.name`, [userId, tenantId])).rows
}
export async function assertAdmin(groupId: string, userId: string, tenantId: string): Promise<Group> {
  const g = await getGroup(groupId)
  if (!g || g.owner_tenant_id !== tenantId) throw new GroupError('NOT_FOUND', 'no such group')
  if (!(await controlDb.query(`SELECT 1 FROM control_plane.group_admins WHERE group_id = $1 AND user_id = $2`, [groupId, userId])).rowCount) throw new GroupError('NOT_GROUP_ADMIN', 'you do not administer this group')
  return g
}
export async function addAdmin(groupId: string, userId: string): Promise<void> {
  await controlDb.query(`INSERT INTO control_plane.group_admins (group_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [groupId, userId])
}
export async function listMembers(groupId: string): Promise<Member[]> {
  return (await controlDb.query<Member>(`SELECT m.tenant_id, t.display_name, m.status, m.invited_at::text, m.accepted_at::text, s.plan_code, s.status AS subscription_status
    FROM control_plane.group_members m JOIN tenants t ON t.id = m.tenant_id LEFT JOIN control_plane.subscriptions s ON s.tenant_id = m.tenant_id WHERE m.group_id = $1 AND m.status <> 'left' ORDER BY t.display_name`, [groupId])).rows
}
/** Invite a company by the email domain of its org admin — never by guessing an id from outside. */
export async function inviteMember(args: { groupId: string; adminEmail: string }): Promise<Member> {
  const t = (await controlDb.query<{ tenant_id: string }>(`SELECT u.tenant_id FROM app_users u JOIN user_roles r ON (r.tenant_id, r.user_id) = (u.tenant_id, u.id) WHERE lower(u.email) = lower($1) AND r.role = 'org_admin' AND u.status = 'active' LIMIT 1`, [args.adminEmail.trim()])).rows[0]
  if (!t) throw new GroupError('NOT_FOUND', 'no company has an org admin with that email')
  const g = (await getGroup(args.groupId))!
  if (t.tenant_id === g.owner_tenant_id) throw new GroupError('VALIDATION_FAILED', 'that is the owner itself')
  await controlDb.query(`INSERT INTO control_plane.group_members (group_id, tenant_id) VALUES ($1,$2) ON CONFLICT (group_id, tenant_id) DO UPDATE SET status = 'invited', invited_at = now(), left_at = NULL, accepted_at = NULL, accepted_by_user_id = NULL WHERE control_plane.group_members.status = 'left'`, [args.groupId, t.tenant_id])
  await audit(t.tenant_id, 'group.member.invited', { groupId: args.groupId })
  return (await listMembers(args.groupId)).find((m) => m.tenant_id === t.tenant_id)!
}
/** What the member side sees: invitations to accept, memberships to leave. */
export async function membershipsOf(tenantId: string): Promise<Array<{ group_id: string; name: string; kind: string; owner_name: string; status: string; invited_at: string }>> {
  return (await controlDb.query(`SELECT m.group_id, g.name, g.kind, o.display_name AS owner_name, m.status, m.invited_at::text FROM control_plane.group_members m JOIN control_plane.groups g ON g.id = m.group_id JOIN tenants o ON o.id = g.owner_tenant_id WHERE m.tenant_id = $1 AND m.status <> 'left' AND g.owner_tenant_id <> $1 ORDER BY m.invited_at DESC`, [tenantId])).rows
}
export async function acceptMembership(args: { groupId: string; tenantId: string; userId: string }): Promise<void> {
  const r = await controlDb.query(`UPDATE control_plane.group_members SET status = 'accepted', accepted_at = now(), accepted_by_user_id = $3 WHERE group_id = $1 AND tenant_id = $2 AND status = 'invited'`, [args.groupId, args.tenantId, args.userId])
  if (!r.rowCount) throw new GroupError('NOT_FOUND', 'no pending invitation')
  await audit(args.tenantId, 'group.member.accepted', { groupId: args.groupId, userId: args.userId })
}
export async function leaveGroup(args: { groupId: string; tenantId: string; userId: string }): Promise<void> {
  const r = await controlDb.query(`UPDATE control_plane.group_members SET status = 'left', left_at = now() WHERE group_id = $1 AND tenant_id = $2 AND status <> 'left'`, [args.groupId, args.tenantId])
  if (!r.rowCount) throw new GroupError('NOT_FOUND', 'not a member')
  await audit(args.tenantId, 'group.member.left', { groupId: args.groupId, userId: args.userId })
}

export interface Snapshot {
  tenantId: string; name: string
  headcount: number; joinersThisMonth: number; exitsThisMonth: number
  presentToday: number; onLeaveToday: number
  lastLockedPayroll: { period: string; netPaise: number; employees: number } | null
  openApprovals: number; openTickets: number
  complianceScore: number | null
}
/** Aggregates only, read-only, in the member's own tenant context. */
export async function tenantSnapshot(tenantId: string, today = new Date().toISOString().slice(0, 10)): Promise<Snapshot> {
  return withTenant(tenantId, async (tx: PoolClient) => {
    await tx.query('SET TRANSACTION READ ONLY')
    const one = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> => (await tx.query<T>(sql, params)).rows[0]!
    const name = (await one<{ n: string }>(`SELECT display_name AS n FROM tenants WHERE id = $1`, [tenantId])).n
    const hc = await one<{ headcount: string; joiners: string; exits: string }>(
      `SELECT count(*) FILTER (WHERE status = 'active')::text AS headcount,
              count(*) FILTER (WHERE date_of_joining >= date_trunc('month', $1::date))::text AS joiners,
              count(*) FILTER (WHERE date_of_exit >= date_trunc('month', $1::date) AND date_of_exit <= $1::date)::text AS exits
         FROM employees WHERE erased_at IS NULL`, [today])
    const att = await one<{ present: string; leave: string }>(`SELECT count(*) FILTER (WHERE status IN ('present','on_duty'))::text AS present, count(*) FILTER (WHERE status = 'on_leave')::text AS leave FROM daily_attendance WHERE work_date = $1::date`, [today])
    const pay = (await tx.query<{ period: string; net: string; n: string }>(`SELECT p.label AS period, coalesce(sum(s.net_paise), 0)::text AS net, count(s.employee_id)::text AS n FROM payroll_runs r JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id) LEFT JOIN payslips s ON (s.tenant_id, s.run_id) = (r.tenant_id, r.id) WHERE r.status = 'locked' GROUP BY p.label, p.period_end ORDER BY p.period_end DESC LIMIT 1`)).rows[0]
    const ops = await one<{ approvals: string; tickets: string }>(`SELECT (SELECT count(*) FROM approval_requests WHERE status = 'pending')::text AS approvals, (SELECT count(*) FROM tickets WHERE status NOT IN ('resolved','closed'))::text AS tickets`)
    let score: number | null = null
    try { score = (await complianceScore(tx, { from: new Date(Date.parse(today) - 90 * 86_400_000).toISOString().slice(0, 10), to: today, today })).score } catch { score = null }
    return { tenantId, name, headcount: Number(hc.headcount), joinersThisMonth: Number(hc.joiners), exitsThisMonth: Number(hc.exits), presentToday: Number(att.present), onLeaveToday: Number(att.leave),
      lastLockedPayroll: pay ? { period: pay.period, netPaise: Number(pay.net), employees: Number(pay.n) } : null, openApprovals: Number(ops.approvals), openTickets: Number(ops.tickets), complianceScore: score }
  })
}
/** The console: one snapshot per ACCEPTED member; the read is audited against every member it touched. */
export async function groupOverview(args: { groupId: string; userId: string; tenantId: string; today?: string }): Promise<{ group: Group; companies: Snapshot[]; totals: { headcount: number; presentToday: number; netPayrollPaise: number; openApprovals: number } }> {
  const g = await assertAdmin(args.groupId, args.userId, args.tenantId)
  if (g.kind !== 'group') throw new GroupError('RESELLER_NO_SNAPSHOT', 'a reseller sees subscriptions, not company data')
  const members = (await listMembers(args.groupId)).filter((m) => m.status === 'accepted')
  const companies: Snapshot[] = []
  for (const m of members) companies.push(await tenantSnapshot(m.tenant_id, args.today))
  for (const m of members) await audit(m.tenant_id, 'group.overview.read', { groupId: g.id, byUserId: args.userId, fromTenantId: args.tenantId })
  return { group: g, companies, totals: { headcount: companies.reduce((s, c) => s + c.headcount, 0), presentToday: companies.reduce((s, c) => s + c.presentToday, 0), netPayrollPaise: companies.reduce((s, c) => s + (c.lastLockedPayroll?.netPaise ?? 0), 0), openApprovals: companies.reduce((s, c) => s + c.openApprovals, 0) } }
}

// ── reseller ─────────────────────────────────────────────────────────────────

/** A reseller provisions a company under itself; the new company's org admin is the customer, not the reseller. */
export async function resellerProvision(args: { groupId: string; userId: string; tenantId: string; input: ProvisionInput }): Promise<{ tenantId: string }> {
  const g = await assertAdmin(args.groupId, args.userId, args.tenantId)
  if (g.kind !== 'reseller') throw new GroupError('NOT_RESELLER', 'only a reseller provisions companies')
  const r = await provisionTenant(args.input)
  await controlDb.query(`UPDATE control_plane.subscriptions SET reseller_group_id = $2 WHERE tenant_id = $1`, [r.tenantId, g.id])
  await controlDb.query(`INSERT INTO control_plane.group_members (group_id, tenant_id, status, accepted_at) VALUES ($1,$2,'accepted',now()) ON CONFLICT DO NOTHING`, [g.id, r.tenantId])
  await audit(r.tenantId, 'reseller.provisioned', { groupId: g.id, byUserId: args.userId, plan: args.input.planCode })
  return { tenantId: r.tenantId }
}
export async function resellerBook(args: { groupId: string; userId: string; tenantId: string }): Promise<Array<{ tenant_id: string; display_name: string; plan_code: string; status: string; current_period_end: string; employees: number; created_at: string }>> {
  const g = await assertAdmin(args.groupId, args.userId, args.tenantId)
  if (g.kind !== 'reseller') throw new GroupError('NOT_RESELLER', 'not a reseller')
  return (await controlDb.query(`SELECT s.tenant_id, t.display_name, s.plan_code, s.status, s.current_period_end::text, t.created_at::text,
      (SELECT count(*)::int FROM employees e WHERE e.tenant_id = s.tenant_id AND e.status = 'active') AS employees
    FROM control_plane.subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE s.reseller_group_id = $1 ORDER BY t.display_name`, [g.id])).rows
}
