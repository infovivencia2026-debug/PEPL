/** Sandbox: a company's throwaway twin with sample data. */
import type { Router } from '../router.ts'
import { authed, ok, created, noContent, asInt, emit } from './deps.ts'
import { sandboxOf, createSandbox, resetSandbox, deleteSandbox, isSandboxTenant, SANDBOX_PASSWORD } from '../../control-plane/sandbox.ts'

export function register(router: Router): void {
  router.get('/api/v1/sandbox', { summary: 'This company\'s sandbox, if any, and whether THIS tenant is one', tag: 'platform', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok({ isSandbox: await isSandboxTenant(ctx.auth.tenantId), sandbox: await sandboxOf(ctx.auth.tenantId), loginHint: { password: SANDBOX_PASSWORD, note: 'every sandbox user, including the sample people, signs in with this password' } })))

  router.post('/api/v1/sandbox', { summary: 'Create the sandbox (Enterprise plan, sample data, expires in N days; nothing it sends leaves the building)', tag: 'platform', permission: 'settings.write',
    requestExample: { organisationType: 'manufacturing', days: 14 } },
    authed('settings.write', async (ctx) => {
      const b = (ctx.req.body ?? {}) as { organisationType?: string; days?: number }
      const me = (await ctx.tx.query<{ email: string; full_name: string }>(`SELECT email, full_name FROM app_users WHERE id = $1`, [ctx.auth.userId])).rows[0]!
      const s = await createSandbox({ parentTenantId: ctx.auth.tenantId, adminEmail: me.email, adminName: me.full_name, organisationType: b.organisationType, days: b.days === undefined ? undefined : asInt(b.days, 'days', { min: 1, max: 90 }), requestedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'sandbox.created', entityType: 'tenant', entityId: s.id, actorUserId: ctx.auth.userId, metadata: { expiresOn: s.sandbox_expires_on } })
      return created(s)
    }))

  router.post('/api/v1/sandbox/reset', { summary: 'Purge and re-seed the sandbox (new tenant id, same expiry)', tag: 'platform', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const s = await resetSandbox({ parentTenantId: ctx.auth.tenantId, requestedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'sandbox.created', entityType: 'tenant', entityId: s.id, actorUserId: ctx.auth.userId, metadata: { reset: true } })
      return ok(s)
    }))

  router.del('/api/v1/sandbox', { summary: 'Delete the sandbox and everything in it', tag: 'platform', permission: 'settings.write' },
    authed('settings.write', async (ctx) => { await deleteSandbox(ctx.auth.tenantId); await emit(ctx.tx, { action: 'sandbox.deleted', entityType: 'tenant', actorUserId: ctx.auth.userId }); return noContent() }))
}
