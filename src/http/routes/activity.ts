/** Activity log. */
import type { Router } from '../router.ts'
import {
  authed,
  ok,
  activity,
  myRecordAccess,
  verifyChain,
} from './deps.ts'

export function register(router: Router): void {
  router.get('/api/v1/activity',
    { summary: 'The company activity log', tag: 'audit', permission: 'audit.read' },
    authed('audit.read', async (ctx) => ok({
      events: await activity(ctx.tx, {
        category: ctx.req.query.get('category') ?? undefined,
        severity: (ctx.req.query.get('severity') ?? undefined) as never,
        limit: Number(ctx.req.query.get('limit') ?? 100),
      }),
    })))

  router.get('/api/v1/activity/verify',
    { summary: 'Re-walk the audit hash chain and report any break', tag: 'audit',
      permission: 'audit.read' },
    authed('audit.read', async (ctx) => ok(await verifyChain(ctx.tx))))

  router.get('/api/v1/me/record-access',
    { summary: 'Who has accessed my record, including my salary', tag: 'audit' },
    authed(null, async (ctx) => {
      if (!ctx.auth.employeeId) return ok({ access: [] })
      return ok({ access: await myRecordAccess(ctx.tx, ctx.auth.employeeId) })
    }))
}
