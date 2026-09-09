/** Configuration — the tenant’s own control surface. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  requireBody,
  setSetting,
  REGISTRY,
  emit,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/config',
    { summary: 'Every setting with its definition, current value and default', tag: 'config',
      permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const changed = new Set(ctx.config.changedKeys())
      return ok({
        version: String(ctx.config.version),
        settings: Object.entries(REGISTRY).map(([key, def]) => ({
          key,
          module: key.split('.')[0],
          label: def.label,
          help: def.help,
          type: def.kind,
          risk: def.risk,
          default: def.default,
          value: ctx.config.get(key),
          changedFromDefault: changed.has(key),
          affectsPayroll: def.affects.includes('payroll'),
          requiresEffectiveDate: def.affects.includes('payroll'),
          scopableBy: def.scopable,
          entitlement: def.entitlement ?? null,
          dependsOn: def.dependsOn,
        })),
      })
    }))

  router.patch('/api/v1/config/:key',
    { summary: 'Change one setting for this company only', tag: 'config', permission: 'settings.write',
      requestExample: { value: 25, reason: 'board decision', effectiveFrom: '2026-11-01' } },
    authed('settings.write', async (ctx) => {
      const body = requireBody<{ value: unknown; reason?: string; effectiveFrom?: string; scope?: { type: string; id: string } }>(
        ctx.req, ['value'])
      await setSetting(ctx.tx, {
        key: ctx.req.params.key!,
        value: body.value as never,
        reason: body.reason,
        effectiveFrom: body.effectiveFrom ?? null,
        actorUserId: ctx.auth.userId,
        scope: body.scope as never,
      })
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'config', entityLabel: ctx.req.params.key,
        actorUserId: ctx.auth.userId, after: { value: body.value }, reason: body.reason,
      })
      return ok({ key: ctx.req.params.key, applied: true })
    }))

  router.get('/api/v1/config/changes',
    { summary: 'Every configuration change, forever', tag: 'config', permission: 'audit.read' },
    authed('audit.read', async (ctx) => {
      const { rows } = await ctx.tx.query(
        `SELECT key, scope_type, old_value, new_value, effective_from, actor_user_id, reason, changed_at
           FROM config_change_log ORDER BY id DESC LIMIT 200`)
      return ok({ changes: rows })
    }))
}
