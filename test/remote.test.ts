/**
 * Work-from-home and field duty as attendance modes: a request covers dates,
 * goes through approval (or not, per settings), and on an approved day the
 * geofence is not enforced and the day carries the mode. Field visits are
 * logged start → end with outcome; one open visit at a time.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { createUser } from '../src/auth/index.ts'
import { setSetting } from '../src/config/write.ts'
import { createSite, setMembership } from '../src/attendance/geofence.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { act } from '../src/approvals/index.ts'
import { requestRemote, remoteModeOn, settleRemoteDecision, cancelRemote, startVisit, endVisit, listVisits } from '../src/attendance/remote.ts'

let A: Tenant
const HQ = { lat: 17.4435, lng: 78.3772 }
const FAR = { lat: 17.3850, lng: 78.4867 }
let server: Server; let base: string; let token: string
let mgrUser: string; let manager: string; let empUser: string
const cfg = (tx: Parameters<typeof resolveConfig>[0]) => resolveConfig(tx, A.id)
/**
 * The server now decides which day a punch belongs to (it is the company's today), so a test that
 * punches on a particular calendar day sets the clock to that day. Only Date is faked: sockets and
 * timers run normally. 06:00 UTC is 11:30 in India, safely inside the day in either zone.
 */
const onDay = async <T>(day: string, fn: () => Promise<T>): Promise<T> => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(`${day}T06:00:00Z`))
  try { return await fn() } finally { vi.useRealTimers() }
}

beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-RMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'rmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    empUser = await createUser(tx, { tenantId: A.id, email: 'rm@acme.test', fullName: 'RM', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    const hq = await createSite(tx, { code: 'HQ', name: 'Head office', ...HQ, radiusM: 150 })
    await setMembership(tx, { employeeId: A.employeeId, siteIds: [hq.id], exempt: false })
    await setSetting(tx, { key: 'attendance.geofence_enforce', value: true, reason: 'test' })
  })
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'rm@acme.test', password: 'a-long-password-1' }) })
  token = ((await r.json()) as { token: string }).token
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })

const api = async (method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.status === 204 ? {} : (await r.json()) as Record<string, any> }
}

describe('remote requests', () => {
  it('needs approval by default, refuses overlap and the monthly cap, and settles through the engine', async () => {
    await withTenant(A.id, async (tx) => {
      const c = await cfg(tx)
      const r = await requestRemote(tx, c, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: '2026-10-06', endsOn: '2026-10-07', reason: 'plumber' })
      expect(r.request.status).toBe('pending')
      expect(r.request.place).toBe('Home')
      expect(r.approvalRequestId).toBeTruthy()
      expect(await remoteModeOn(tx, A.employeeId, '2026-10-06')).toBeNull()
      await expect(requestRemote(tx, c, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'field', startsOn: '2026-10-07', endsOn: '2026-10-08', place: 'Client' }))
        .rejects.toMatchObject({ code: 'REMOTE_OVERLAP' })
      await expect(requestRemote(tx, c, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'field', startsOn: '2026-10-09', endsOn: '2026-10-09' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })     // field duty needs a place
      await act(tx, { requestId: r.approvalRequestId!, actorUserId: mgrUser, action: 'approve' })
      await settleRemoteDecision(tx, { approvalRequestId: r.approvalRequestId!, status: 'approved' })
      expect(await remoteModeOn(tx, A.employeeId, '2026-10-06')).toBe('wfh')
      expect(await remoteModeOn(tx, A.employeeId, '2026-10-08')).toBeNull()

      await setSetting(tx, { key: 'attendance.wfh_max_days_per_month', value: 3, reason: 'test' })
      const c2 = await cfg(tx)
      await expect(requestRemote(tx, c2, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: '2026-10-20', endsOn: '2026-10-21' }))
        .rejects.toMatchObject({ code: 'WFH_CAP' })
      const one = await requestRemote(tx, c2, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: '2026-10-20', endsOn: '2026-10-20' })
      await cancelRemote(tx, one.request.id, A.employeeId)
      expect((await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [one.approvalRequestId])).rows[0]!.status).toBe('withdrawn')
      await setSetting(tx, { key: 'attendance.wfh_max_days_per_month', value: 0, reason: 'test' })
    })
  })

  it('approves on the spot when approval is switched off; is refused when WFH is off', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'attendance.wfh_requires_approval', value: false, reason: 'test' })
      const r = await requestRemote(tx, await cfg(tx), { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: '2026-11-02', endsOn: '2026-11-02' })
      expect(r.request.status).toBe('approved')
      expect(r.approvalRequestId).toBeNull()
      await setSetting(tx, { key: 'attendance.remote_enabled', value: false, reason: 'test' })
      await expect(requestRemote(tx, await cfg(tx), { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: '2026-11-03', endsOn: '2026-11-03' }))
        .rejects.toMatchObject({ code: 'REMOTE_NOT_ALLOWED' })
      await setSetting(tx, { key: 'attendance.remote_enabled', value: true, reason: 'test' })
      await setSetting(tx, { key: 'attendance.wfh_requires_approval', value: true, reason: 'test' })
    })
  })
})

describe('over HTTP', () => {
  it('an approved WFH day is not fenced and the punch marks the day remote; an ordinary day still is', async () => {
    const ordinary = await onDay('2026-10-05', () => api('POST', '/api/v1/attendance/punch', { direction: 'in', localDate: '2026-10-05', clientPunchId: 'r0', geo: FAR }))
    expect(ordinary.status).toBe(422)
    expect(ordinary.body.error.code).toBe('OUTSIDE_GEOFENCE')

    const home = await onDay('2026-10-06', () => api('POST', '/api/v1/attendance/punch', { direction: 'in', localDate: '2026-10-06', clientPunchId: 'r1', geo: FAR }))
    expect(home.status).toBe(200)
    expect(home.body.mode).toBe('wfh')
    const day = await withTenant(A.id, (tx) => tx.query<{ is_remote: boolean; status: string }>(
      `SELECT is_remote, status FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-06'`, [A.employeeId]))
    expect(day.rows[0]).toMatchObject({ is_remote: true, status: 'present' })

    const list = await api('GET', '/api/v1/attendance/remote-requests?status=approved')
    expect(list.status).toBe(200)
    expect(list.body.requests.map((r: { starts_on: string }) => r.starts_on)).toContain('2026-10-06')
  })

  it('a field request through the API lands in the manager inbox; a visit is logged start → end and marks the day on duty', async () => {
    const req = await api('POST', '/api/v1/attendance/remote-requests', { kind: 'field', startsOn: '2026-10-13', endsOn: '2026-10-13', place: 'DAV School', reason: 'demo' })
    expect(req.status).toBe(201)
    expect(req.body.request.status).toBe('pending')
    await withTenant(A.id, async (tx) => {
      const pend = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM approval_requests WHERE entity_type = 'remote' AND status = 'pending'`)).rows[0]!.n
      expect(Number(pend)).toBe(1)
    })

    const v = await onDay('2026-10-13', () => api('POST', '/api/v1/attendance/visits', { place: 'DAV School, Kondapur', contact: 'Principal', purpose: 'LMS demo', geo: HQ, localDate: '2026-10-13' }))
    expect(v.status).toBe(201)
    const again = await onDay('2026-10-13', () => api('POST', '/api/v1/attendance/visits', { place: 'Elsewhere', purpose: 'x', localDate: '2026-10-13' }))
    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('VISIT_OPEN')
    const ended = await api('POST', `/api/v1/attendance/visits/${v.body.id}/end`, { outcome: 'Pilot agreed', nextStep: 'Proposal by Friday', geo: FAR })
    expect(ended.status).toBe(200)
    expect(ended.body.outcome).toBe('Pilot agreed')
    expect(ended.body.end_lat).toBeCloseTo(FAR.lat)
    await withTenant(A.id, async (tx) => {
      expect((await listVisits(tx, { from: '2026-10-01', to: '2026-10-31' })).length).toBe(1)
      const day = (await tx.query<{ is_field_duty: boolean; status: string }>(`SELECT is_field_duty, status FROM daily_attendance WHERE employee_id = $1 AND work_date = '2026-10-13'`, [A.employeeId])).rows[0]!
      expect(day).toMatchObject({ is_field_duty: true, status: 'on_duty' })
      await expect(endVisit(tx, { visitId: v.body.id, employeeId: A.employeeId, outcome: 'again' })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(startVisit(tx, { employeeId: A.employeeId, workDate: '2026-10-13', place: '', purpose: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    })
  })
})
