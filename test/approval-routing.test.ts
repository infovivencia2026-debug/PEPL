/**
 * Approval routing after the blueprint's Phase A2:
 *  - a step with nobody to approve it goes to HR by default instead of being
 *    skipped into an auto-approval; auto-approve is an explicit setting;
 *  - a stale step nudges its approver once a day and copies HR when it is
 *    the last step;
 *  - bulk approve decides and settles each request on its own savepoint, so
 *    one refusal does not undo the others.
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
import { resolveConfig } from '../src/config/resolver.ts'
import { raiseWithPolicy, remindStale } from '../src/approvals/policy.ts'
import { requestRemote } from '../src/attendance/remote.ts'

let A: Tenant
let hrUser: string; let empUser: string; let mgrUser: string; let manager: string; let loner: string; let lonerUser: string
let server: Server; let base: string
beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => {
    manager = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-RMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    loner = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-LON','Loner',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    await tx.query(`UPDATE employee_assignments SET manager_employee_id = $2 WHERE employee_id = $1 AND effective_to IS NULL`, [A.employeeId, manager])
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'rmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: manager })
    hrUser = await createUser(tx, { tenantId: A.id, email: 'rhr@acme.test', fullName: 'HR', password: 'a-long-password-1', roles: ['hr_admin'] })
    empUser = await createUser(tx, { tenantId: A.id, email: 'remp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
    lonerUser = await createUser(tx, { tenantId: A.id, email: 'rlon@acme.test', fullName: 'Loner', password: 'a-long-password-1', roles: ['employee'], employeeId: loner })
  })
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })

const login = async (email: string) => {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: 'a-long-password-1' }) })
  return ((await r.json()) as { token: string }).token
}
const api = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: (await r.json()) as Record<string, any> }
}

describe('a step with nobody to approve it', () => {
  it('routes to HR by default and stays pending; the step says why', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await raiseWithPolicy(tx, { entityType: 'test', entityId: crypto.randomUUID(), requestedByUserId: lonerUser, subjectEmployeeId: loner, magnitude: 1, fallback: 'manager', title: 'Loner asks' })
      const req = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [r.requestId])).rows[0]!
      expect(req.status).toBe('pending')
      const step = (await tx.query<{ approver_user_id: string; routed_to_hr: boolean; status: string }>(`SELECT approver_user_id, routed_to_hr, status FROM approval_steps WHERE approval_request_id = $1`, [r.requestId])).rows[0]!
      expect(step).toMatchObject({ approver_user_id: hrUser, routed_to_hr: true, status: 'pending' })
      const told = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'approval.requested'`, [hrUser])).rows[0]!.n
      expect(Number(told)).toBe(1)
    })
  })

  it('a manager asking for themself is not their own approver — HR gets it', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await raiseWithPolicy(tx, { entityType: 'test', entityId: crypto.randomUUID(), requestedByUserId: mgrUser, subjectEmployeeId: manager, magnitude: 1, fallback: 'manager', title: 'Mgr asks' })
      const step = (await tx.query<{ approver_user_id: string; routed_to_hr: boolean }>(`SELECT approver_user_id, routed_to_hr FROM approval_steps WHERE approval_request_id = $1`, [r.requestId])).rows[0]!
      expect(step).toMatchObject({ approver_user_id: hrUser, routed_to_hr: true })
    })
  })

  it('auto-approves only when the company chooses that', async () => {
    await withTenant(A.id, async (tx) => {
      await setSetting(tx, { key: 'approvals.no_approver_fallback', value: 'auto_approve', reason: 'test' })
      const r = await raiseWithPolicy(tx, { entityType: 'test', entityId: crypto.randomUUID(), requestedByUserId: lonerUser, subjectEmployeeId: loner, magnitude: 1, fallback: 'manager', title: 'Loner asks again' })
      expect((await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [r.requestId])).rows[0]!.status).toBe('approved')
      await setSetting(tx, { key: 'approvals.no_approver_fallback', value: 'route_to_hr', reason: 'test' })
    })
  })
})

describe('reminders', () => {
  it('nudges the approver once a day after the threshold and copies HR when it is the last step', async () => {
    await withTenant(A.id, async (tx) => {
      const r = await raiseWithPolicy(tx, { entityType: 'test', entityId: crypto.randomUUID(), requestedByUserId: empUser, subjectEmployeeId: A.employeeId, magnitude: 1, fallback: 'manager', title: 'Old request' })
      await tx.query(`UPDATE approval_requests SET created_at = now() - interval '5 days' WHERE id = $1`, [r.requestId])
      expect(await remindStale(tx, 2)).toBe(1)
      expect(await remindStale(tx, 2)).toBe(0)                                  // same day: throttled
      expect(await remindStale(tx, 2, new Date(Date.now() + 86_400_000))).toBe(1) // tomorrow: again
      const mgrNudges = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'approval.reminder' AND entity_id = $2`, [mgrUser, r.requestId])).rows[0]!.n
      const hrStuck = (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'approval.stuck' AND entity_id = $2`, [hrUser, r.requestId])).rows[0]!.n
      expect([Number(mgrNudges), Number(hrStuck)]).toEqual([2, 2])
      expect(await remindStale(tx, 0)).toBe(0)                                  // off
    })
  })
})

describe('bulk decisions over HTTP', () => {
  it('approves several, settles each, and one bad id does not undo the rest', async () => {
    const cfgIds: string[] = []
    await withTenant(A.id, async (tx) => {
      const cfg = await resolveConfig(tx, A.id)
      for (const d of ['2026-11-09', '2026-11-11']) {
        const r = await requestRemote(tx, cfg, { employeeId: A.employeeId, requestedByUserId: empUser, kind: 'wfh', startsOn: d, endsOn: d })
        cfgIds.push(r.approvalRequestId!)
      }
    })
    const mgr = await login('rmgr@acme.test')
    const bad = crypto.randomUUID()
    const res = await api(mgr, 'POST', '/api/v1/approvals/bulk', { ids: [cfgIds[0], bad, cfgIds[1]], action: 'approve', comment: 'ok' })
    expect(res.status).toBe(200)
    expect(res.body.results.map((r: { status?: string; error?: string }) => r.status ?? r.error)).toEqual(['approved', 'NOT_FOUND', 'approved'])
    await withTenant(A.id, async (tx) => {
      const { rows } = await tx.query<{ status: string }>(`SELECT status FROM remote_requests WHERE approval_request_id = ANY($1::uuid[]) ORDER BY starts_on`, [cfgIds])
      expect(rows.map((r) => r.status)).toEqual(['approved', 'approved'])
    })
    const again = await api(mgr, 'POST', '/api/v1/approvals/bulk', { ids: cfgIds, action: 'reject' })
    expect(again.status).toBe(422)                                              // a bulk rejection needs a comment
    const rejectDone = await api(mgr, 'POST', '/api/v1/approvals/bulk', { ids: cfgIds, action: 'reject', comment: 'late' })
    expect(rejectDone.body.results.map((r: { status?: string }) => r.status)).toEqual(['approved', 'approved']) // already decided: idempotent, unchanged
  })
})
