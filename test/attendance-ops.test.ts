/**
 * Attendance operations (blueprint A4): breaks come off worked time, a late
 * reason attaches to the day, the auto-checkout job closes a forgotten
 * punch-out at the shift end and flags it, the control room counts today,
 * and a QR kiosk code is a punch at that site — valid two minutes, refused
 * once stale or forged.
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
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { createShift, rosterEmployee } from '../src/attendance/shifts.ts'
import { createSite } from '../src/attendance/geofence.ts'
import { startBreak, endBreak, setLateReason, autoCheckout, controlRoom, qrCode, verifyQr, rotateQrSecret } from '../src/attendance/ops.ts'

let A: Tenant
let server: Server; let base: string; let token: string; let mgrToken: string
let manager: string; let siteId: string
const TODAY = new Date().toISOString().slice(0, 10)
beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-OMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    await createUser(tx, { tenantId: A.id, email: 'oemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    await createUser(tx, { tenantId: A.id, email: 'omgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    siteId = (await createSite(tx, { code: 'HQ', name: 'Head office', lat: 17.4435, lng: 78.3772, radiusM: 150 })).id
    await setSetting(tx, { key: 'attendance.qr_punch_enabled', value: true, reason: 'test' })
    await setSetting(tx, { key: 'attendance.late_reason_required', value: true, reason: 'test' })
  })
  const login = async (email: string) => ((await (await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password-1' }) })).json()) as { token: string }).token
  token = await login('oemp@acme.test'); mgrToken = await login('omgr@acme.test')
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })
const api = async (t: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.status === 204 ? {} : (await r.json()) as Record<string, any> }
}

describe('breaks', () => {
  it('need a punch-in, one at a time, and come off the worked minutes', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(startBreak(tx, { employeeId: A.employeeId, workDate: '2026-10-05' })).rejects.toMatchObject({ code: 'NOT_PUNCHED_IN' })
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T03:30:00Z', localDate: '2026-10-05', direction: 'in', source: 'web' })
      await recomputeDay(tx, A.employeeId, '2026-10-05')
      const b = await startBreak(tx, { employeeId: A.employeeId, workDate: '2026-10-05', kind: 'lunch' })
      expect(b.kind).toBe('lunch')
      await expect(startBreak(tx, { employeeId: A.employeeId, workDate: '2026-10-05' })).rejects.toMatchObject({ code: 'BREAK_OPEN' })
      // a 45-minute lunch, recorded in the past so the numbers are exact
      await tx.query(`UPDATE attendance_breaks SET started_at = '2026-10-05T07:00:00Z', ended_at = '2026-10-05T07:45:00Z' WHERE id = $1`, [b.id])
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-05T12:30:00Z', localDate: '2026-10-05', direction: 'out', source: 'web' })
      await recomputeDay(tx, A.employeeId, '2026-10-05')
      const day = (await tx.query<{ worked_minutes: number }>(`SELECT worked_minutes FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-05'`, [A.employeeId])).rows[0]!
      expect(day.worked_minutes).toBe(9 * 60 - 45)
      await recomputeDay(tx, A.employeeId, '2026-10-05', { breaksDeducted: false })
      expect((await tx.query<{ worked_minutes: number }>(`SELECT worked_minutes FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-05'`, [A.employeeId])).rows[0]!.worked_minutes).toBe(9 * 60)
      await expect(endBreak(tx, { employeeId: A.employeeId })).rejects.toMatchObject({ code: 'NO_OPEN_BREAK' })
    })
  })
})

describe('late reason and auto-checkout with a shift', () => {
  it('a late punch asks for a reason; a forgotten punch-out is closed at shift end and flagged', async () => {
    await withTenant(A.id, async (tx) => {
      const s = await createShift(tx, { code: 'GEN', name: 'General', startTime: '09:00', endTime: '18:00', graceInMin: 10, fullDayMin: 480, halfDayMin: 240 })
      await rosterEmployee(tx, { employeeId: A.employeeId, shiftId: s.id, effectiveFrom: '2026-01-01' })
      await expect(setLateReason(tx, { employeeId: A.employeeId, workDate: '2026-10-06', reason: 'x' })).rejects.toMatchObject({ code: 'NOT_LATE' })
      // 09:40 IST = 04:10Z → 30 min late after 10 min grace
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-06T04:10:00Z', localDate: '2026-10-06', direction: 'in', source: 'web' })
      await recomputeDay(tx, A.employeeId, '2026-10-06', { timezone: 'Asia/Kolkata' })
      const late = await setLateReason(tx, { employeeId: A.employeeId, workDate: '2026-10-06', reason: 'Metro breakdown' })
      expect(late.lateMinutes).toBe(30)

      // nobody punched out. 20:00 IST: 18:00 end + 60 min setting has passed → closed at 18:00 IST (12:30Z)
      expect(await autoCheckout(tx, { afterMinutes: 60, timezone: 'Asia/Kolkata', now: new Date('2026-10-06T13:00:00Z') })).toBe(0)   // 18:30 IST: not yet
      expect(await autoCheckout(tx, { afterMinutes: 60, timezone: 'Asia/Kolkata', now: new Date('2026-10-06T14:30:00Z') })).toBe(1)
      const day = (await tx.query<{ last_out: string; auto_closed: boolean; late_reason: string; worked_minutes: number }>(
        `SELECT last_out::text, auto_closed, late_reason, worked_minutes FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-06'`, [A.employeeId])).rows[0]!
      expect(day.auto_closed).toBe(true)
      expect(new Date(day.last_out).toISOString()).toBe('2026-10-06T12:30:00.000Z')
      expect(day.late_reason).toBe('Metro breakdown')                  // recompute kept it
      expect(await autoCheckout(tx, { afterMinutes: 60, timezone: 'Asia/Kolkata', now: new Date('2026-10-06T15:00:00Z') })).toBe(0)   // idempotent
      expect(await autoCheckout(tx, { afterMinutes: 0, timezone: 'Asia/Kolkata' })).toBe(0)                                             // off
    })
  })
})

describe('control room', () => {
  it('counts who is expected, in, late, missing, on leave, by location', async () => {
    await withTenant(A.id, async (tx) => {
      const room = await controlRoom(tx, { date: '2026-10-06', timezone: 'Asia/Kolkata', weekPattern: 'five_day' })
      expect(room.counts.expected).toBe(2)                              // Rahul and the manager
      expect(room.counts.in).toBe(1)
      expect(room.counts.late).toBe(1)
      expect(room.late[0]).toMatchObject({ employeeId: A.employeeId, lateMinutes: 30, lateReason: 'Metro breakdown', autoClosed: true })
      expect(room.counts.missing).toBe(1)
      expect(room.missing[0]!.employeeId).toBe(manager)
      const sunday = await controlRoom(tx, { date: '2026-10-04', timezone: 'Asia/Kolkata', weekPattern: 'five_day' })
      expect(sunday.counts.expected).toBe(0)
      expect(sunday.counts.weeklyOff).toBe(2)
    })
    const self = await api(token, 'GET', '/api/v1/attendance/control-room')
    expect(self.status).toBe(403)                                        // employees do not get the room
    const mgr = await api(mgrToken, 'GET', '/api/v1/attendance/control-room?date=2026-10-06')
    expect(mgr.status).toBe(200)
    expect(mgr.body.counts.late).toBe(1)
  })
})

describe('QR punch', () => {
  it('a code is valid for two minutes, forged or stale ones are refused, and a scan punches at the site with no location', async () => {
    await withTenant(A.id, async (tx) => {
      const now = new Date('2026-10-07T03:30:00Z')
      const q = await qrCode(tx, siteId, now)
      expect(q.payload).toMatch(/^pepl:qr:/)
      expect(await verifyQr(tx, q.payload, now)).toEqual({ siteId })
      expect(await verifyQr(tx, q.payload, new Date(now.getTime() + 90_000))).toEqual({ siteId })       // next minute: still good
      await expect(verifyQr(tx, q.payload, new Date(now.getTime() + 3 * 60_000))).rejects.toMatchObject({ code: 'QR_EXPIRED' })
      await expect(verifyQr(tx, q.payload.slice(0, -1) + (q.payload.endsWith('A') ? 'B' : 'A'), now)).rejects.toMatchObject({ code: 'QR_INVALID' })
      await expect(verifyQr(tx, 'hello', now)).rejects.toMatchObject({ code: 'QR_INVALID' })
      await rotateQrSecret(tx)
      await expect(verifyQr(tx, q.payload, now)).rejects.toMatchObject({ code: 'QR_INVALID' })            // every old code dies at once
    })
    const kiosk = await api(mgrToken, 'GET', `/api/v1/attendance/qr?siteId=${siteId}`)
    expect(kiosk.status).toBe(200)
    // Showing a live code is traced to the person who showed it, once per ten minutes, not per poll.
    await api(mgrToken, 'GET', `/api/v1/attendance/qr?siteId=${siteId}`)
    const issued = await withTenant(A.id, async (tx) => Number((await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_events WHERE action = 'attendance.qr.issued' AND entity_id = $1`, [siteId])).rows[0]!.n))
    expect(issued).toBe(1)
    const denied = await api(token, 'GET', `/api/v1/attendance/qr?siteId=${siteId}`)
    expect(denied.status).toBe(403)                                      // an employee cannot show codes
    const punch = await api(token, 'POST', '/api/v1/attendance/punch', { direction: 'in', localDate: TODAY, clientPunchId: 'qr1', qr: kiosk.body.payload })
    expect(punch.status).toBe(200)
    expect(punch.body.geofence).toMatchObject({ status: 'inside', siteId })
    await withTenant(A.id, async (tx) => {
      const p = (await tx.query<{ via: string; site_id: string; within_geofence: boolean }>(`SELECT via, site_id, within_geofence FROM attendance_punches WHERE client_punch_id = 'qr1'`)).rows[0]!
      expect(p).toMatchObject({ via: 'qr', site_id: siteId, within_geofence: true })
    })
  })
})
