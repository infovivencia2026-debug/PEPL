/**
 * Geofences: the distance math, who is fenced to what, and the server — not
 * the phone — deciding whether a punch was inside.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import {
  createSite, distanceMetres, evaluatePunch, getMembership, listSites, retireSite, setMembership, updateSite,
} from '../src/attendance/geofence.ts'

let A: Tenant
let B: Tenant
const HQ = { lat: 17.4435, lng: 78.3772 }               // Hitech City
const FAR = { lat: 17.3850, lng: 78.4867 }              // Charminar, ~13 km away

beforeAll(async () => { const s = await resetAndSeed(); A = s.a; B = s.b })
afterAll(async () => { await closePools(); await controlPool.end() })

describe('distance', () => {
  it('is haversine to the metre', () => {
    expect(distanceMetres(HQ, HQ)).toBe(0)
    const d = distanceMetres(HQ, FAR)
    expect(d).toBeGreaterThan(12_500)
    expect(d).toBeLessThan(14_000)
    // ~111 m per 0.001° of latitude
    expect(Math.round(distanceMetres(HQ, { lat: HQ.lat + 0.001, lng: HQ.lng }))).toBe(111)
  })
})

describe('sites and membership', () => {
  it('validates, upserts by code, resizes, retires (dropping members)', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(createSite(tx, { code: 'HQ', name: 'x', lat: 91, lng: 0, radiusM: 100 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createSite(tx, { code: 'HQ', name: 'x', ...HQ, radiusM: 10 })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const hq = await createSite(tx, { code: 'hq', name: 'Head office', ...HQ, radiusM: 150 })
      expect(hq.code).toBe('HQ')
      await expect(createSite(tx, { code: 'HQ', name: 'again', ...HQ, radiusM: 150 })).rejects.toMatchObject({ code: 'SITE_EXISTS' })
      const wh = await createSite(tx, { code: 'WH', name: 'Warehouse', ...FAR, radiusM: 300, locationCode: 'hyd' })
      expect(wh.location_code).toBe('HYD')

      const m = await setMembership(tx, { employeeId: A.employeeId, siteIds: [hq.id, wh.id], exempt: false })
      expect(m.siteIds.sort()).toEqual([hq.id, wh.id].sort())
      await expect(setMembership(tx, { employeeId: A.employeeId, siteIds: [hq.id], exempt: true })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })

      await retireSite(tx, wh.id)
      expect((await listSites(tx)).map((s) => s.code)).toEqual(['HQ'])
      expect((await getMembership(tx, A.employeeId)).siteIds).toEqual([hq.id])     // dropped from the retired site
      const bigger = await updateSite(tx, hq.id, { radiusM: 400 })
      expect(bigger.radius_m).toBe(400)
    })
    await withTenant(B.id, async (tx) => { expect(await listSites(tx, { includeRetired: true })).toEqual([]) })
  })

  it('evaluates: inside, outside with the distance, unfenced when nothing applies, exempt beats everything', async () => {
    await withTenant(A.id, async (tx) => {
      const near = { lat: HQ.lat + 0.001, lng: HQ.lng }          // 111 m, inside a 400 m radius
      expect(await evaluatePunch(tx, A.employeeId, near)).toMatchObject({ status: 'inside', siteCode: 'HQ', distanceM: 111 })
      const out = await evaluatePunch(tx, A.employeeId, FAR)
      expect(out.status).toBe('outside')
      expect(out.distanceM).toBeGreaterThan(12_000)
      // no fix at all for a fenced person is outside
      expect((await evaluatePunch(tx, A.employeeId, undefined)).status).toBe('outside')

      // someone with no membership and no applies-to-all site is unfenced
      const nobody = (await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'GF-2','Field',CURRENT_DATE) RETURNING id`, [A.id])).rows[0]!.id
      expect((await evaluatePunch(tx, nobody, FAR)).status).toBe('unfenced')
      // an applies-to-all site fences them
      const [hq] = await listSites(tx)
      await updateSite(tx, hq!.id, { appliesToAll: true })
      expect((await evaluatePunch(tx, nobody, FAR)).status).toBe('outside')
      // unless they are exempt
      await setMembership(tx, { employeeId: nobody, siteIds: [], exempt: true })
      expect((await evaluatePunch(tx, nobody, FAR)).status).toBe('unfenced')
      await updateSite(tx, hq!.id, { appliesToAll: false })
    })
  })
})

describe('the punch route decides server-side', () => {
  let server: Server
  let base: string
  let token: string
  beforeAll(async () => {
    server = createServer(createHandler(buildRouter()))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await withTenant(A.id, (tx) => createUser(tx, { tenantId: A.id, email: 'gf@acme.test', fullName: 'GF', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId }))
    const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'gf@acme.test', password: 'a-long-password-1' }) })
    token = ((await r.json()) as { token: string }).token
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  const punch = async (body: Record<string, unknown>) => {
    const r = await fetch(`${base}/api/v1/attendance/punch`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as Record<string, unknown> }
  }

  it('records and flags an outside punch by default, ignores the client flag, refuses when enforced', async () => {
    const outside = await punch({ direction: 'in', localDate: '2026-09-21', clientPunchId: 'g1', geo: FAR, withinGeofence: true })
    expect(outside.status).toBe(200)
    expect(outside.body.geofence).toMatchObject({ status: 'outside', siteCode: 'HQ' })
    const { rows } = await withTenant(A.id, (tx) => tx.query<{ within_geofence: boolean; distance_m: number }>(
      `SELECT within_geofence, distance_m FROM attendance_punches WHERE employee_id = $1 AND client_punch_id = 'g1'`, [A.employeeId]))
    expect(rows[0]!.within_geofence).toBe(false)            // the client said true; the server knew better
    expect(rows[0]!.distance_m).toBeGreaterThan(12_000)

    await withTenant(A.id, (tx) => setSetting(tx, { key: 'attendance.geofence_enforce', value: true, reason: 'test' }))
    const refused = await punch({ direction: 'in', localDate: '2026-09-21', clientPunchId: 'g2', geo: FAR })
    expect(refused.status).toBe(422)
    expect((refused.body.error as { code: string }).code).toBe('OUTSIDE_GEOFENCE')
    const inside = await punch({ direction: 'in', localDate: '2026-09-21', clientPunchId: 'g3', geo: { lat: HQ.lat + 0.001, lng: HQ.lng } })
    expect(inside.status).toBe(200)
    expect(inside.body.geofence).toMatchObject({ status: 'inside', distanceM: 111 })
  })
})
