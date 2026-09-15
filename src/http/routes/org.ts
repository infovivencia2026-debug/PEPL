/**
 * Organisation masters. Reading is open to anyone signed in — a picker needs
 * the list. Writing is `settings.write`: this is company structure, the same
 * hands that set policy.
 */
import type { Router } from '../router.ts'
import { authed, ok, created, requireBody, asUuid, emit } from './deps.ts'
import { UNIT_KINDS, createUnit, listUnits, reinstateUnit, retireUnit, updateUnit } from '../../people/org.ts'

export function register(router: Router): void {
  router.get('/api/v1/org/:kind',
    { summary: `Units of one kind (${UNIT_KINDS.join(' | ')}); ?includeRetired=true for history`, tag: 'people' },
    authed(null, async (ctx) => ok({
      units: await listUnits(ctx.tx, ctx.req.params.kind!, { includeRetired: ctx.req.query.get('includeRetired') === 'true' }),
    })))

  router.post('/api/v1/org/:kind',
    { summary: 'Add a department, location, designation or grade', tag: 'people', permission: 'settings.write',
      requestExample: { code: 'SALES_N', name: 'Sales — North', parentId: null, attributes: { costCentre: 'CC-41' } } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ code: string; name: string; parentId?: string | null; attributes?: Record<string, unknown>; sortOrder?: number }>(
        ctx.req, ['code', 'name'])
      const unit = await createUnit(ctx.tx, {
        kind: ctx.req.params.kind!, code: String(b.code), name: String(b.name),
        parentId: b.parentId ? asUuid(b.parentId, 'parentId') : null,
        attributes: b.attributes, sortOrder: b.sortOrder,
      })
      await emit(ctx.tx, { action: 'org.unit.changed', entityType: 'org_unit', entityId: unit.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', kind: unit.kind, code: unit.code } })
      return created({ unit })
    }))

  router.patch('/api/v1/org/:kind/:id',
    { summary: 'Rename, re-parent or re-attribute a unit (the code never changes)', tag: 'people',
      permission: 'settings.write', requestExample: { name: 'Sales — North & East' } },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ name?: string; parentId?: string | null; attributes?: Record<string, unknown>; sortOrder?: number }>(ctx.req, [])
      const unit = await updateUnit(ctx.tx, id, {
        name: b.name, attributes: b.attributes, sortOrder: b.sortOrder,
        parentId: b.parentId === undefined ? undefined : b.parentId ? asUuid(b.parentId, 'parentId') : null,
      })
      await emit(ctx.tx, { action: 'org.unit.changed', entityType: 'org_unit', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'update', kind: unit.kind, code: unit.code, fields: Object.keys(b) } })
      return ok({ unit })
    }))

  router.post('/api/v1/org/:kind/:id/retire',
    { summary: 'Retire a unit: hidden from pickers, kept for history; reports current assignments still on it',
      tag: 'people', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await retireUnit(ctx.tx, id)
      await emit(ctx.tx, { action: 'org.unit.changed', entityType: 'org_unit', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', kind: r.unit.kind, code: r.unit.code, inUseBy: r.inUseBy } })
      return ok(r)
    }))

  router.post('/api/v1/org/:kind/:id/reinstate',
    { summary: 'Bring a retired unit back', tag: 'people', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const unit = await reinstateUnit(ctx.tx, id)
      await emit(ctx.tx, { action: 'org.unit.changed', entityType: 'org_unit', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'reinstate', kind: unit.kind, code: unit.code } })
      return ok({ unit })
    }))
}
