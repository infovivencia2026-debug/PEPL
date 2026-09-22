/** Network benchmarks: opt in, see your company against its segment. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, emit } from './deps.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { compare, withdraw, METRICS, MIN_K } from '../../control-plane/benchmarks.ts'
import { setSetting } from '../../config/write.ts'

export function register(router: Router): void {
  router.get('/api/v1/benchmarks', { summary: 'Your company against its segment (organisation type × size band) for a month (?month=YYYY-MM, default last month); shown only when ≥10 companies contributed and you contribute too', tag: 'platform', permission: 'report.read' },
    authed('report.read', async (ctx) => {
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'benchmarks are company-wide')
      const sharing = ctx.config.get<boolean>('benchmarks.share_enabled')
      const today = localToday(ctx.config.get<string>('attendance.timezone'))
      const last = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7)
      const month = ctx.req.query.get('month') ?? last
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(422, 'VALIDATION_FAILED', 'month is YYYY-MM')
      if (!sharing) return ok({ sharing: false, minimum: MIN_K, metrics: METRICS.map((m) => ({ ...m, shown: false })), note: 'Turn on benchmarks.share_enabled to contribute anonymised ratios and see your segment.' })
      const orgType = (await ctx.tx.query<{ t: string | null }>(`SELECT organisation_type AS t FROM tenants WHERE id = $1`, [ctx.auth.tenantId])).rows[0]?.t ?? null
      return ok({ sharing: true, ...(await compare(ctx.tx, { tenantId: ctx.auth.tenantId, organisationType: orgType, month })) })
    }))

  router.post('/api/v1/benchmarks/opt-out', { summary: 'Stop contributing and delete every sample this company ever contributed', tag: 'platform', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      await setSetting(ctx.tx, { key: 'benchmarks.share_enabled', value: false, actorUserId: ctx.auth.userId, reason: 'opted out of network benchmarks' })
      const removed = await withdraw(ctx.auth.tenantId)
      await emit(ctx.tx, { action: 'config.setting.changed', entityType: 'setting', actorUserId: ctx.auth.userId, metadata: { key: 'benchmarks.share_enabled', value: false, samplesRemoved: removed } })
      return ok({ sharing: false, samplesRemoved: removed })
    }))
}
