/**
 * The control-plane surface a customer touches: sign up, see plans, manage
 * the subscription, approve a support session. Everything here runs on the
 * control-plane connection with the caller's OWN tenant id — never one from
 * the request.
 */
import type { Router } from '../router.ts'

import { HttpError, authed, open, ok, created, noContent, requireBody, asUuid, emit, type Req } from './deps.ts'
import {
  listPlans, signup, billingSummary, updateBillingDetails, switchPlan, listInvoices,
} from '../../control-plane/billing.ts'
import { controlDb, grantSupportAccess, revokeSupportAccess } from '../../control-plane/index.ts'
import { login } from '../../auth/index.ts'

export function register(router: Router): void {
  router.get('/api/v1/plans',
    { summary: 'The plans on sale: prices (paise), modules and limits', tag: 'billing', public: true },
    open(async () => ok({ plans: await listPlans() })))

  router.post('/api/v1/signup',
    { summary: 'Create a company on the trial and sign its first admin in', tag: 'billing', public: true,
      requestExample: { legalName: 'Acme Technologies Pvt Ltd', adminEmail: 'hr@acme.com', adminName: 'Priya Sharma', password: 'a-long-passphrase', stateCode: 'TS' } },
    open(async (req: Req) => {
      const b = requireBody<{ legalName: string; displayName?: string; adminEmail: string; adminName: string; password: string; stateCode?: string }>(
        req, ['legalName', 'adminEmail', 'adminName', 'password'])
      const { tenantId } = await signup({ ...b })
      // Straight into the product: the session comes from the same login path everyone uses.
      const session = await login({ email: b.adminEmail, password: b.password, ip: req.ip, userAgent: String(req.headers['user-agent'] ?? '') })
      return created({ tenantId, token: session.token, expiresAt: session.expiresAt.toISOString(), user: { id: session.userId, roles: session.roles } })
    }))

  router.get('/api/v1/billing',
    { summary: 'Your plan, subscription status, headcount vs limit, next-invoice estimate and anything outstanding', tag: 'billing',
      permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok(await billingSummary(ctx.auth.tenantId))))

  router.patch('/api/v1/billing',
    { summary: 'Billing details for the invoice: GSTIN, address, billing email', tag: 'billing', permission: 'settings.write',
      requestExample: { gstin: '36AAAAA0000A1Z5', address: 'Plot 12, HITEC City, Hyderabad 500081', email: 'accounts@acme.com' } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ gstin?: string | null; address?: string | null; email?: string | null }>(ctx.req, [])
      await updateBillingDetails(ctx.auth.tenantId, b)
      await emit(ctx.tx, { action: 'billing.details.changed', entityType: 'subscription', actorUserId: ctx.auth.userId, after: { gstin: b.gstin ?? undefined, email: b.email ?? undefined } })
      return ok(await billingSummary(ctx.auth.tenantId))
    }))

  router.post('/api/v1/billing/plan',
    { summary: 'Change plan. Upgrades apply now; a downgrade is refused while you are over its headcount limit', tag: 'billing',
      permission: 'settings.write', requestExample: { planCode: 'professional' } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ planCode: string }>(ctx.req, ['planCode'])
      const summary = await switchPlan(ctx.auth.tenantId, b.planCode)
      await emit(ctx.tx, { action: 'billing.plan.changed', entityType: 'subscription', actorUserId: ctx.auth.userId, after: { planCode: b.planCode } })
      return ok(summary)
    }))

  router.get('/api/v1/billing/invoices',
    { summary: 'Invoices, newest first', tag: 'billing', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok({ invoices: await listInvoices(ctx.auth.tenantId) })))

  // ── support access: the tenant approves; we never let ourselves in ──
  router.get('/api/v1/support-access',
    { summary: 'Support sessions granted to PEPL staff, current and past', tag: 'billing', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const { rows } = await controlDb.query(
        `SELECT id, agent_id, reason, scope, starts_at::text, expires_at::text, revoked_at::text, break_glass,
                (revoked_at IS NULL AND now() BETWEEN starts_at AND expires_at) AS active
           FROM control_plane.support_access_grants WHERE tenant_id = $1 ORDER BY starts_at DESC LIMIT 50`, [ctx.auth.tenantId])
      return ok({ grants: rows })
    }))

  router.post('/api/v1/support-access',
    { summary: 'Approve a read-only support session for a named PEPL agent, for a few hours', tag: 'billing',
      permission: 'settings.write', requestExample: { agentId: '…', reason: 'ticket #4412: payslip PDF shows wrong PF', hours: 4 } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ agentId: string; reason: string; hours?: number }>(ctx.req, ['agentId', 'reason'])
      const hours = b.hours ?? 4
      if (!Number.isInteger(hours) || hours < 1 || hours > 72) throw new HttpError(422, 'VALIDATION_FAILED', 'hours must be 1–72')
      const id = await grantSupportAccess({ tenantId: ctx.auth.tenantId, agentId: asUuid(b.agentId, 'agentId'), reason: b.reason, grantedByUserId: ctx.auth.userId, hours })
      await emit(ctx.tx, { action: 'security.support_access.granted', entityType: 'support_grant', entityId: id, actorUserId: ctx.auth.userId,
        reason: b.reason, metadata: { agentId: b.agentId, hours } })
      return created({ id })
    }))

  router.post('/api/v1/support-access/:id/revoke',
    { summary: 'End a support session now', tag: 'billing', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const owned = await controlDb.query(`SELECT 1 FROM control_plane.support_access_grants WHERE id = $1 AND tenant_id = $2`, [id, ctx.auth.tenantId])
      if (!owned.rowCount) throw new HttpError(404, 'NOT_FOUND', 'no such support grant')
      await revokeSupportAccess(id)
      await emit(ctx.tx, { action: 'security.support_access.revoked', entityType: 'support_grant', entityId: id, actorUserId: ctx.auth.userId })
      return noContent()
    }))
}
