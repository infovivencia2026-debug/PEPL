/**
 * Assets (B2): default categories seed once; an item is issued to one person
 * at a time and the holder is told; returns set the status from the
 * condition and carry a recovery; the summary counts; exit clearance for IT
 * refuses to sign while the leaver holds a returnable item but accepts a
 * recovery, and admin is untouched by IT's items.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { listCategories, addAsset, issueAsset, acknowledgeAsset, returnAsset, listAssets, assignmentsFor, setAssetStatus, openReturnables, assetSummary, openMaintenance, closeMaintenance } from '../src/work/assets.ts'
import { submitResignation, acceptResignation, clearArea } from '../src/people/exit-workflow.ts'

let A: Tenant
let hrUser: string; let empUser: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  await withTenant(A.id, async (tx) => {
    hrUser = await createUser(tx, { tenantId: A.id, email: 'ahr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'aemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('register, issue, return', () => {
  it('seeds categories, refuses a duplicate tag, issues once, tells the holder, returns with condition and recovery', async () => {
    await withTenant(A.id, async (tx) => {
      const cats = await listCategories(tx)
      expect(cats.map((c) => c.code)).toContain('LAPTOP')
      expect((await listCategories(tx)).length).toBe(cats.length)
      const laptop = cats.find((c) => c.code === 'LAPTOP')!, idCard = cats.find((c) => c.code === 'ID_CARD')!
      const lt = await addAsset(tx, { categoryId: laptop.id, tag: 'LT-0001', name: 'Dell Latitude', serialNo: 'SN1', costPaise: 75_000_00, warrantyUntil: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) })
      await expect(addAsset(tx, { categoryId: laptop.id, tag: 'LT-0001', name: 'dup' })).rejects.toMatchObject({ code: 'ASSET_TAG_TAKEN' })
      const card = await addAsset(tx, { categoryId: idCard.id, tag: 'ID-0001', name: 'Access card' })
      const issue = await issueAsset(tx, { assetId: lt.id, employeeId: A.employeeId, condition: 'new', actorUserId: hrUser })
      expect(issue.acknowledged_at).toBeNull()
      await expect(issueAsset(tx, { assetId: lt.id, employeeId: A.employeeId, actorUserId: hrUser })).rejects.toMatchObject({ code: 'ASSET_UNAVAILABLE' })
      await expect(setAssetStatus(tx, lt.id, 'retired')).rejects.toMatchObject({ code: 'ASSET_ISSUED' })
      expect((await listAssets(tx, { employeeId: A.employeeId })).map((a) => a.tag)).toEqual(['LT-0001'])
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'asset.issued'`, [empUser])).rows[0]!.n).toBe('1')
      await acknowledgeAsset(tx, { assignmentId: issue.id, employeeId: A.employeeId })
      await expect(acknowledgeAsset(tx, { assignmentId: issue.id, employeeId: A.employeeId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await issueAsset(tx, { assetId: card.id, employeeId: A.employeeId, actorUserId: hrUser })
      expect((await assignmentsFor(tx, { employeeId: A.employeeId, open: true })).length).toBe(2)

      await expect(returnAsset(tx, { assignmentId: issue.id, condition: 'damaged', actorUserId: hrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // needs a note
      const back = await returnAsset(tx, { assignmentId: issue.id, condition: 'damaged', note: 'Cracked screen', recoveryPaise: 8_000_00, actorUserId: hrUser })
      expect(back.recovery_paise).toBe('800000')
      expect((await listAssets(tx, { q: 'LT-0001' }))[0]!.status).toBe('in_repair')
      const m = await openMaintenance(tx, { assetId: lt.id, vendor: 'Dell' })
      await closeMaintenance(tx, { maintenanceId: m.id, costPaise: 4_500_00 })
      expect((await listAssets(tx, { q: 'LT-0001' }))[0]!.status).toBe('in_stock')
      const sum = await assetSummary(tx)
      expect(sum).toMatchObject({ total: 2, byStatus: { in_stock: 1, issued: 1 }, warrantyExpiring: 1 })
    })
  })
})

describe('exit clearance', () => {
  it('IT cannot sign while the leaver holds an IT item; a recovery clears it; admin only cares about admin items', async () => {
    await withTenant(A.id, async (tx) => {
      const cats = await listCategories(tx)
      const laptop = cats.find((c) => c.code === 'LAPTOP')!
      const lt2 = await addAsset(tx, { categoryId: laptop.id, tag: 'LT-0002', name: 'ThinkPad' })
      await issueAsset(tx, { assetId: lt2.id, employeeId: A.employeeId, actorUserId: hrUser })
      // holds: LT-0002 (it) and ID-0001 (admin)
      expect((await openReturnables(tx, A.employeeId)).map((h) => `${h.area}:${h.tag}`).sort()).toEqual(['admin:ID-0001', 'it:LT-0002'])
      const r = await submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2026-12-31', reason: 'Moving on' })
      const sep = (await acceptResignation(tx, { resignationId: r.id, actorUserId: hrUser })).separation
      await expect(clearArea(tx, { separationId: sep.id, area: 'it', status: 'cleared', actorUserId: hrUser })).rejects.toMatchObject({ code: 'ASSETS_OUTSTANDING' })
      await expect(clearArea(tx, { separationId: sep.id, area: 'manager', status: 'cleared', actorUserId: hrUser })).resolves.toBeTruthy()   // no tools held
      // laptop written off: IT clears with a recovery
      const cleared = await clearArea(tx, { separationId: sep.id, area: 'it', status: 'recovery', note: 'ThinkPad not returned', recoveryPaise: 40_000_00, actorUserId: hrUser })
      expect(cleared.clearances.find((c) => c.area === 'it')!.status).toBe('recovery')
      // admin still blocked by the ID card until it comes back
      await expect(clearArea(tx, { separationId: sep.id, area: 'admin', status: 'cleared', actorUserId: hrUser })).rejects.toMatchObject({ code: 'ASSETS_OUTSTANDING' })
      const card = (await assignmentsFor(tx, { employeeId: A.employeeId, open: true })).find((a) => a.tag === 'ID-0001')!
      await returnAsset(tx, { assignmentId: card.id, condition: 'good', actorUserId: hrUser })
      await expect(clearArea(tx, { separationId: sep.id, area: 'admin', status: 'cleared', actorUserId: hrUser })).resolves.toBeTruthy()
    })
  })
})
