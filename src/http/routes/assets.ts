/** Asset register: categories, items, issue/return, maintenance. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, assertScope, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { listCategories, upsertCategory, addAsset, getAsset, listAssets, setAssetStatus, issueAsset, acknowledgeAsset, returnAsset, assignmentsFor, openMaintenance, closeMaintenance, assetSummary } from '../../work/assets.ts'

export function register(router: Router): void {
  router.get('/api/v1/assets/categories', { summary: 'Asset categories (defaults seeded on first call)', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => { requireModule(ctx, 'assets.enabled'); return ok({ categories: await listCategories(ctx.tx) }) }))

  router.post('/api/v1/assets/categories', { summary: 'Add or change a category (which exit-clearance area wants it back; returnable or issued to keep)', tag: 'assets', permission: 'asset.manage',
    requestExample: { code: 'HEADSET', name: 'Headset', clearanceArea: 'it', returnable: true } },
    authed('asset.manage', async (ctx) => ok(await upsertCategory(ctx.tx, requireBody<{ code: string; name: string; clearanceArea?: string; returnable?: boolean }>(ctx.req, ['code', 'name'])))))

  router.get('/api/v1/assets', { summary: 'Asset register (?status=&categoryId=&employeeId=&q=) with the current holder', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => {
      requireModule(ctx, 'assets.enabled')
      const q = ctx.req.query
      return ok({ assets: await listAssets(ctx.tx, { status: q.get('status') ?? undefined, categoryId: q.get('categoryId') ? asUuid(q.get('categoryId'), 'categoryId') : undefined, employeeId: q.get('employeeId') ? asUuid(q.get('employeeId'), 'employeeId') : undefined, q: q.get('q') ?? undefined }) })
    }))

  router.get('/api/v1/assets/summary', { summary: 'Counts by status and category, warranties expiring in 60 days', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => ok(await assetSummary(ctx.tx))))

  router.post('/api/v1/assets', { summary: 'Add an item to the register', tag: 'assets', permission: 'asset.manage',
    requestExample: { categoryId: '…', tag: 'LT-0042', name: 'Dell Latitude 5440', serialNo: 'ABC123', purchasedOn: '2026-04-01', costPaise: 7500000, warrantyUntil: '2029-03-31', locationCode: 'HYD' } },
    authed('asset.manage', async (ctx) => {
      requireModule(ctx, 'assets.enabled')
      const b = requireBody<{ categoryId: string; tag: string; name: string; serialNo?: string; purchasedOn?: string; costPaise?: number; warrantyUntil?: string; locationCode?: string; notes?: string }>(ctx.req, ['categoryId', 'tag', 'name'])
      const a = await addAsset(ctx.tx, { ...b, categoryId: asUuid(b.categoryId, 'categoryId'), purchasedOn: b.purchasedOn ? asDate(b.purchasedOn, 'purchasedOn') : null, warrantyUntil: b.warrantyUntil ? asDate(b.warrantyUntil, 'warrantyUntil') : null, costPaise: b.costPaise === undefined ? null : asInt(b.costPaise, 'costPaise', { min: 0 }) })
      await emit(ctx.tx, { action: 'asset.changed', entityType: 'asset', entityId: a.id, actorUserId: ctx.auth.userId, metadata: { tag: a.tag, status: a.status } })
      return created(a)
    }))

  router.get('/api/v1/assets/:id', { summary: 'One asset with its holder and history', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => {
      const a = await getAsset(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!a) throw new HttpError(404, 'NOT_FOUND', 'no such asset')
      const history = (await ctx.tx.query(`SELECT s.id, s.employee_id, s.issued_on::text, s.returned_on::text, s.return_condition, s.recovery_paise::text FROM asset_assignments s WHERE s.asset_id = $1 ORDER BY s.issued_on DESC`, [a.id])).rows
      return ok({ asset: a, history })
    }))

  router.post('/api/v1/assets/:id/status', { summary: 'Mark in stock / lost / retired (must not be issued)', tag: 'assets', permission: 'asset.manage', requestExample: { status: 'retired', note: 'End of life' } },
    authed('asset.manage', async (ctx) => {
      const b = requireBody<{ status: 'in_stock' | 'in_repair' | 'lost' | 'retired'; note?: string }>(ctx.req, ['status'])
      if (!['in_stock', 'in_repair', 'lost', 'retired'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is in_stock, in_repair, lost or retired')
      const a = await setAssetStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status, b.note)
      await emit(ctx.tx, { action: 'asset.changed', entityType: 'asset', entityId: a.id, actorUserId: ctx.auth.userId, metadata: { tag: a.tag, status: a.status } })
      return ok(a)
    }))

  router.post('/api/v1/assets/:id/issue', { summary: 'Issue to an employee (they are asked to acknowledge)', tag: 'assets', permission: 'asset.manage', requestExample: { employeeId: '…', condition: 'New, sealed box' } },
    authed('asset.manage', async (ctx) => {
      const b = requireBody<{ employeeId: string; issuedOn?: string; condition?: string }>(ctx.req, ['employeeId'])
      const employeeId = asUuid(b.employeeId, 'employeeId')
      assertScope(ctx.auth, employeeId)
      const s = await issueAsset(ctx.tx, { assetId: asUuid(ctx.req.params.id, 'id'), employeeId, issuedOn: b.issuedOn ? asDate(b.issuedOn, 'issuedOn') : undefined, condition: b.condition, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'asset.issued', entityType: 'asset', entityId: s.asset_id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId, metadata: { tag: s.tag } })
      return created(s)
    }))

  router.get('/api/v1/assets/assignments', { summary: 'Issues (?employeeId=&open=true|false); ?employeeId=me for your own', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => {
      const raw = ctx.req.query.get('employeeId')
      const employeeId = raw === 'me' ? ctx.auth.employeeId ?? undefined : raw ? asUuid(raw, 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      const open = ctx.req.query.get('open')
      return ok({ assignments: await assignmentsFor(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, open: open === null ? undefined : open === 'true' }) })
    }))

  router.post('/api/v1/assets/assignments/:id/acknowledge', { summary: 'Employee confirms receipt', tag: 'assets', permission: 'asset.read' },
    authed('asset.read', async (ctx) => {
      if (!ctx.auth.employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      await acknowledgeAsset(ctx.tx, { assignmentId: asUuid(ctx.req.params.id, 'id'), employeeId: ctx.auth.employeeId })
      return noContent()
    }))

  router.post('/api/v1/assets/assignments/:id/return', { summary: 'Take an item back: good → in stock; damaged → in repair; lost → lost; a recovery amount for the F&F when applicable', tag: 'assets', permission: 'asset.manage',
    requestExample: { condition: 'damaged', note: 'Cracked screen', recoveryPaise: 800000 } },
    authed('asset.manage', async (ctx) => {
      const b = requireBody<{ condition: 'good' | 'damaged' | 'lost'; note?: string; recoveryPaise?: number; returnedOn?: string }>(ctx.req, ['condition'])
      const s = await returnAsset(ctx.tx, { assignmentId: asUuid(ctx.req.params.id, 'id'), condition: b.condition, note: b.note, recoveryPaise: b.recoveryPaise === undefined ? undefined : asInt(b.recoveryPaise, 'recoveryPaise', { min: 0 }), returnedOn: b.returnedOn ? asDate(b.returnedOn, 'returnedOn') : undefined, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'asset.returned', entityType: 'asset', entityId: s.asset_id, subjectEmployeeId: s.employee_id, actorUserId: ctx.auth.userId, metadata: { tag: s.tag, condition: s.return_condition, recoveryPaise: s.recovery_paise } })
      return ok(s)
    }))

  router.post('/api/v1/assets/:id/maintenance', { summary: 'Send for repair / service', tag: 'assets', permission: 'asset.manage', requestExample: { kind: 'repair', vendor: 'Dell Service Centre', note: 'Battery' } },
    authed('asset.manage', async (ctx) => {
      const b = requireBody<{ kind?: 'repair' | 'service' | 'upgrade'; vendor?: string; note?: string }>(ctx.req, [])
      return created(await openMaintenance(ctx.tx, { assetId: asUuid(ctx.req.params.id, 'id'), ...b }))
    }))

  router.post('/api/v1/assets/maintenance/:id/close', { summary: 'Back from repair (cost; backInStock=false retires it)', tag: 'assets', permission: 'asset.manage', requestExample: { costPaise: 450000 } },
    authed('asset.manage', async (ctx) => {
      const b = requireBody<{ costPaise?: number; note?: string; backInStock?: boolean }>(ctx.req, [])
      await closeMaintenance(ctx.tx, { maintenanceId: asUuid(ctx.req.params.id, 'id'), costPaise: b.costPaise === undefined ? undefined : asInt(b.costPaise, 'costPaise', { min: 0 }), note: b.note, backInStock: b.backInStock })
      return noContent()
    }))
}
