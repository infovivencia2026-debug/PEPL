/** Integrations hub: API keys, webhooks, connections. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, emit } from './deps.ts'
import { ROLE_PERMISSIONS } from '../../authz/permissions.ts'
import { ACTIONS } from '../../audit/index.ts'
import { createApiKey, listApiKeys, revokeApiKey, createWebhook, listWebhooks, setWebhookStatus, recentDeliveries, upsertConnection, listConnections, removeConnection, CONNECTION_KINDS } from '../../control-plane/integrations.ts'

export function register(router: Router): void {
  router.get('/api/v1/integrations/api-keys', { summary: 'API keys (prefix, role, last used); the secret is never shown again', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => { requireModule(ctx, 'integrations.enabled'); return ok({ keys: await listApiKeys(ctx.tx), roles: Object.keys(ROLE_PERMISSIONS).filter((r) => r !== 'org_admin') }) }))
  router.post('/api/v1/integrations/api-keys', { summary: 'Create a key as a service user with a role. Use it as Authorization: Bearer pk_… — every permission and scope rule applies', tag: 'integrations', permission: 'integration.manage',
    requestExample: { name: 'Tally sync', role: 'finance', expiresAt: '2027-03-31T00:00:00Z' } },
    authed('integration.manage', async (ctx) => {
      requireModule(ctx, 'integrations.enabled')
      const b = requireBody<{ name: string; role: string; expiresAt?: string }>(ctx.req, ['name', 'role'])
      const r = await createApiKey(ctx.tx, { name: b.name, role: b.role, expiresAt: b.expiresAt ? new Date(b.expiresAt).toISOString() : null, createdByUserId: ctx.auth.userId, allowedRoles: Object.keys(ROLE_PERMISSIONS) })
      await emit(ctx.tx, { action: 'security.api_key.created', entityType: 'api_key', entityId: r.key.id, actorUserId: ctx.auth.userId, metadata: { name: r.key.name, role: b.role } })
      return created(r)
    }))
  router.post('/api/v1/integrations/api-keys/:id/revoke', { summary: 'Revoke a key at once (its service user is disabled)', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      await revokeApiKey(ctx.tx, id)
      await emit(ctx.tx, { action: 'security.api_key.revoked', entityType: 'api_key', entityId: id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  router.get('/api/v1/integrations/webhooks', { summary: 'Webhooks and the events they may subscribe to (the audit vocabulary; prefixes like leave.* work)', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => { requireModule(ctx, 'integrations.enabled'); return ok({ webhooks: await listWebhooks(ctx.tx), events: Object.keys(ACTIONS) }) }))
  router.post('/api/v1/integrations/webhooks', { summary: 'Subscribe a URL; the signing secret is shown once. Payloads carry ids, never PII; header x-pepl-signature: t=…,v1=hmac_sha256(secret, t.body)', tag: 'integrations', permission: 'integration.manage',
    requestExample: { name: 'ERP sync', url: 'https://erp.acme.in/hooks/pepl', events: ['payroll.run.locked', 'leave.*'] } },
    authed('integration.manage', async (ctx) => {
      requireModule(ctx, 'integrations.enabled')
      const b = requireBody<{ name: string; url: string; events: string[] }>(ctx.req, ['name', 'url', 'events'])
      const r = await createWebhook(ctx.tx, { ...b, master: process.env.PEPL_MAIL_KEY, createdByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'config.webhook.changed', entityType: 'webhook', entityId: r.webhook.id, actorUserId: ctx.auth.userId, metadata: { url: b.url, events: b.events } })
      return created(r)
    }))
  router.post('/api/v1/integrations/webhooks/:id/status', { summary: 'active | paused | disabled', tag: 'integrations', permission: 'integration.manage', requestExample: { status: 'paused' } },
    authed('integration.manage', async (ctx) => {
      const b = requireBody<{ status: 'active' | 'paused' | 'disabled' }>(ctx.req, ['status'])
      if (!['active', 'paused', 'disabled'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is active, paused or disabled')
      await setWebhookStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status)
      return noContent()
    }))
  router.get('/api/v1/integrations/webhooks/:id/deliveries', { summary: 'Recent deliveries with status, attempts and last error', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => ok({ deliveries: await recentDeliveries(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

  router.get('/api/v1/integrations/connections', { summary: 'Configured external systems (secrets never returned)', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => { requireModule(ctx, 'integrations.enabled'); return ok({ connections: await listConnections(ctx.tx), kinds: CONNECTION_KINDS }) }))
  router.post('/api/v1/integrations/connections', { summary: 'Add or update a connection (kind + name; config is non-secret; secret is write-only)', tag: 'integrations', permission: 'integration.manage',
    requestExample: { kind: 'razorpayx', name: 'Payouts', config: { accountNumber: '2323230012345678' }, secret: 'rzp_live_key:rzp_live_secret' } },
    authed('integration.manage', async (ctx) => {
      requireModule(ctx, 'integrations.enabled')
      const b = requireBody<{ kind: string; name: string; config?: Record<string, unknown>; secret?: string }>(ctx.req, ['kind', 'name'])
      const c = await upsertConnection(ctx.tx, { ...b, master: process.env.PEPL_MAIL_KEY })
      await emit(ctx.tx, { action: 'config.connection.changed', entityType: 'integration_connection', entityId: c.id, actorUserId: ctx.auth.userId, metadata: { kind: c.kind, name: c.name } })
      return created(c)
    }))
  router.post('/api/v1/integrations/connections/:id/remove', { summary: 'Remove a connection and its secret', tag: 'integrations', permission: 'integration.manage' },
    authed('integration.manage', async (ctx) => { await removeConnection(ctx.tx, asUuid(ctx.req.params.id, 'id')); return noContent() }))
}
