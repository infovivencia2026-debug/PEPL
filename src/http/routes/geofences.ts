/**
 * Geofence sites and who belongs to them. Sites are company structure
 * (`settings.write`); membership is an attendance decision
 * (`attendance.correct`), made per person and scoped.
 */
import type { Router } from '../router.ts'
import { authed, ok, created, requireBody, asUuid, assertScope, emit } from './deps.ts'
import {
  createSite, getMembership, listSites, reinstateSite, retireSite, setMembership, updateSite,
} from '../../attendance/geofence.ts'

export function register(router: Router): void {
  router.get('/api/v1/geofences',
    { summary: 'Sites people may punch from; ?includeRetired=true for history', tag: 'attendance' },
    authed(null, async (ctx) => ok({ sites: await listSites(ctx.tx, { includeRetired: ctx.req.query.get('includeRetired') === 'true' }) })))

  router.post('/api/v1/geofences',
    { summary: 'Add a site', tag: 'attendance', permission: 'settings.write',
      requestExample: { code: 'HQ', name: 'Head office', lat: 17.4435, lng: 78.3772, radiusM: 150, appliesToAll: true } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ code: string; name: string; lat: number; lng: number; radiusM: number; appliesToAll?: boolean; locationCode?: string | null }>(
        ctx.req, ['code', 'name', 'lat', 'lng', 'radiusM'])
      const site = await createSite(ctx.tx, b)
      await emit(ctx.tx, { action: 'attendance.geofence.changed', entityType: 'geofence_site', entityId: site.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', code: site.code, radiusM: site.radius_m } })
      return created({ site })
    }))

  router.patch('/api/v1/geofences/:id',
    { summary: 'Move, resize or rename a site', tag: 'attendance', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ name?: string; lat?: number; lng?: number; radiusM?: number; appliesToAll?: boolean; locationCode?: string | null }>(ctx.req, [])
      const site = await updateSite(ctx.tx, id, b)
      await emit(ctx.tx, { action: 'attendance.geofence.changed', entityType: 'geofence_site', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'update', code: site.code, fields: Object.keys(b) } })
      return ok({ site })
    }))

  router.post('/api/v1/geofences/:id/retire',
    { summary: 'Retire a site (its members are unfenced until reassigned)', tag: 'attendance', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const site = await retireSite(ctx.tx, id)
      await emit(ctx.tx, { action: 'attendance.geofence.changed', entityType: 'geofence_site', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', code: site.code } })
      return ok({ site })
    }))

  router.post('/api/v1/geofences/:id/reinstate',
    { summary: 'Bring a retired site back', tag: 'attendance', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      return ok({ site: await reinstateSite(ctx.tx, id) })
    }))

  router.get('/api/v1/employees/:id/geofences',
    { summary: 'Which sites a person may punch from, or that they are exempt', tag: 'attendance', permission: 'attendance.read' },
    authed('attendance.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      return ok({ membership: await getMembership(ctx.tx, id) })
    }))

  router.patch('/api/v1/employees/:id/geofences',
    { summary: 'Set a person\'s sites (the list replaces), or mark them exempt (field staff)', tag: 'attendance',
      permission: 'attendance.correct', requestExample: { siteIds: ['…'], exempt: false } },
    authed('attendance.correct', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const b = requireBody<{ siteIds?: string[]; exempt?: boolean }>(ctx.req, [])
      const membership = await setMembership(ctx.tx, {
        employeeId: id, siteIds: (b.siteIds ?? []).map((s) => asUuid(s, 'siteIds')), exempt: b.exempt === true,
      })
      await emit(ctx.tx, { action: 'attendance.geofence.changed', entityType: 'employee', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: id,
        metadata: { op: 'membership', sites: membership.siteIds.length, exempt: membership.exempt } })
      return ok({ membership })
    }))
}
