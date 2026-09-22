/** Public trust page; the company's own security posture. */
import type { Router } from '../router.ts'
import { authed, open, ok } from './deps.ts'
import { trustPage, securityPosture } from '../../control-plane/trust.ts'

export function register(router: Router): void {
  router.get('/api/v1/trust', { summary: 'PUBLIC: what the platform enforces, subprocessors, 30-day uptime from the heartbeat, incidents, current status', tag: 'platform', public: true },
    open(async () => ok(await trustPage())))

  router.get('/api/v1/security-posture', { summary: 'This company\'s posture: MFA adoption, admins, API keys, webhooks, audit chain verified, retention, open findings, a score with advice', tag: 'platform', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok(await securityPosture(ctx.tx, ctx.config, ctx.auth.tenantId))))
}
