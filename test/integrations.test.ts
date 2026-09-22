/**
 * Integrations (C1). An API key authenticates as its service user with that
 * user's role (permissions and scope apply; org_admin refused; revocation is
 * immediate). Webhooks queue audit events past the cursor for matching
 * patterns only, deliver signed payloads a receiver can verify, back off on
 * failure and give up at the limit. Connections store secrets write-only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { createUser } from '../src/auth/index.ts'
import { emit } from '../src/audit/index.ts'
import { ROLE_PERMISSIONS } from '../src/authz/permissions.ts'
import { createApiKey, revokeApiKey, createWebhook, enqueueWebhookEvents, deliverWebhooks, verifySignature, recentDeliveries, listWebhooks, upsertConnection, listConnections, connectionSecret, MAX_DELIVERY_ATTEMPTS } from '../src/control-plane/integrations.ts'

let A: Tenant
let admin: string; let server: Server; let base: string
const MASTER = 'integrations-master-key-000000000000001'
beforeAll(async () => {
  A = (await resetAndSeed()).a
  server = createServer(createHandler(buildRouter()))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await withTenant(A.id, async (tx) => { admin = await createUser(tx, { tenantId: A.id, email: 'iadmin@acme.test', fullName: 'Admin', password: 'a-long-password-1', roles: ['org_admin'] }) })
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); await closePools(); await controlPool.end() })
const call = async (token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined })
  return { status: r.status, body: r.status === 204 ? {} : (await r.json()) as Record<string, any> }
}

describe('API keys', () => {
  it('acts as a service user with a role; refuses org_admin; scope applies; revocation is immediate', async () => {
    let secret = ''
    await withTenant(A.id, async (tx) => {
      await expect(createApiKey(tx, { name: 'Too much', role: 'org_admin', createdByUserId: admin, allowedRoles: Object.keys(ROLE_PERMISSIONS) })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const r = await createApiKey(tx, { name: 'Tally sync', role: 'finance', createdByUserId: admin, allowedRoles: Object.keys(ROLE_PERMISSIONS) })
      secret = r.secret
      expect(secret.startsWith('pk_')).toBe(true)
      expect(r.key).toMatchObject({ name: 'Tally sync', role: 'finance', prefix: secret.slice(0, 12) })
      expect((await tx.query<{ is_service: boolean }>(`SELECT is_service FROM app_users WHERE id = $1`, [r.key.user_id])).rows[0]!.is_service).toBe(true)
    })
    // finance may read employees? finance role: check a payroll read works and an HR write does not
    const ok = await call(secret, 'GET', '/api/v1/payroll/ledger-mappings')          // finance holds payroll.read
    expect(ok.status).toBe(200)
    const write = await call(secret, 'POST', '/api/v1/letters/templates', { code: 'x', name: 'x', title: 'x', body: 'x' })
    expect(write.status).toBe(403)                                                     // finance has no letter.manage
    expect((await call(secret, 'GET', '/api/v1/auth/mfa')).status).toBe(200)          // a key is never MFA-pending
    const keys = await withTenant(A.id, (tx) => tx.query<{ id: string; last_used_at: string | null }>(`SELECT id, last_used_at FROM api_keys`))
    await withTenant(A.id, (tx) => revokeApiKey(tx, keys.rows[0]!.id))
    const after = await call(secret, 'GET', '/api/v1/payroll/ledger-mappings')
    expect(after.status).toBe(401)
    expect((await call('pk_definitely_not_a_key', 'GET', '/api/v1/auth/mfa')).status).toBe(401)
  })
})

describe('webhooks', () => {
  let receiver: Server; let url = ''; let fail = 0; const got: Array<{ sig: string; event: string; body: string }> = []
  beforeAll(async () => {
    receiver = createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => { got.push({ sig: String(req.headers['x-pepl-signature']), event: String(req.headers['x-pepl-event']), body: d }); if (fail > 0) { fail--; res.statusCode = 503; res.end('down') } else { res.statusCode = 200; res.end('ok') } }) })
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r))
    url = `http://127.0.0.1:${(receiver.address() as { port: number }).port}/hook`
  })
  afterAll(async () => { await new Promise<void>((r) => receiver.close(() => r())) })

  it('queues only matching events after the cursor, signs deliveries a receiver can verify, backs off and gives up at the limit', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(createWebhook(tx, { name: 'x', url: 'http://evil.example', events: ['*'], master: MASTER, createdByUserId: admin })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createWebhook(tx, { name: 'x', url, events: ['nope.event'], master: MASTER, createdByUserId: admin })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createWebhook(tx, { name: 'x', url, events: ['leave.*'], master: undefined, createdByUserId: admin })).rejects.toMatchObject({ code: 'MAIL_KEY_MISSING' })
      // history before the hook exists is not replayed
      await emit(tx, { action: 'leave.request.approved', entityType: 'leave_request', entityId: crypto.randomUUID(), subjectEmployeeId: A.employeeId, actorUserId: admin })
      const { webhook, secret } = await createWebhook(tx, { name: 'ERP', url, events: ['leave.*', 'payroll.run.locked'], master: MASTER, createdByUserId: admin })
      expect(secret.startsWith('whsec_')).toBe(true)
      await emit(tx, { action: 'leave.request.approved', entityType: 'leave_request', entityId: crypto.randomUUID(), subjectEmployeeId: A.employeeId, actorUserId: admin })
      await emit(tx, { action: 'attendance.day.corrected', entityType: 'attendance', subjectEmployeeId: A.employeeId, actorUserId: admin, reason: 'x' })   // not subscribed
      expect(await enqueueWebhookEvents(tx)).toBe(1)
      expect(await enqueueWebhookEvents(tx)).toBe(0)                                     // cursor moved
      const t0 = new Date()
      fail = 1
      expect(await deliverWebhooks(tx, { master: MASTER, now: t0 })).toEqual({ delivered: 0, failed: 1 })
      expect(await deliverWebhooks(tx, { master: MASTER, now: t0 })).toEqual({ delivered: 0, failed: 0 })            // backing off: not due yet
      expect(await deliverWebhooks(tx, { master: MASTER, now: new Date(t0.getTime() + 2 * 60_000) })).toEqual({ delivered: 1, failed: 0 })
      expect(got.length).toBe(2)
      const last = got[1]!
      expect(last.event).toBe('leave.request.approved')
      expect(verifySignature(secret, last.body, last.sig, 300, Math.floor((t0.getTime() + 2 * 60_000) / 1000))).toBe(true)
      expect(verifySignature('whsec_wrong', last.body, last.sig, 300, Math.floor((t0.getTime() + 2 * 60_000) / 1000))).toBe(false)
      expect(verifySignature(secret, last.body, last.sig, 300, Math.floor(t0.getTime() / 1000) + 3600)).toBe(false)    // stale timestamp
      const payload = JSON.parse(last.body)
      expect(payload).toMatchObject({ type: 'leave.request.approved', subjectEmployeeId: A.employeeId })
      expect(Object.keys(payload).sort()).toEqual(['actorUserId', 'entityId', 'entityType', 'id', 'metadata', 'occurredAt', 'subjectEmployeeId', 'type'])   // ids only, no names
      const d = await recentDeliveries(tx, webhook.id)
      expect(d[0]).toMatchObject({ status: 'delivered', attempts: 2, response_status: 200 })
      expect((await listWebhooks(tx))[0]!.consecutive_failures).toBe(0)

      // a hook that never answers: attempts climb to the limit, then the delivery is failed
      fail = 99
      await emit(tx, { action: 'payroll.run.locked', entityType: 'payroll_run', entityId: crypto.randomUUID(), actorUserId: admin })
      await enqueueWebhookEvents(tx)
      let t = new Date(t0.getTime() + 3 * 60_000)
      for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i++) { await deliverWebhooks(tx, { master: MASTER, now: t }); t = new Date(t.getTime() + 24 * 3_600_000) }
      const failed = (await recentDeliveries(tx, webhook.id)).find((x) => x.event_type === 'payroll.run.locked')!
      expect(failed).toMatchObject({ status: 'failed', attempts: MAX_DELIVERY_ATTEMPTS, response_status: 503 })
      expect(await deliverWebhooks(tx, { master: MASTER, now: t })).toEqual({ delivered: 0, failed: 0 })            // nothing pending
      expect((await listWebhooks(tx))[0]!.consecutive_failures).toBe(MAX_DELIVERY_ATTEMPTS)
    })
  })
})

describe('connections', () => {
  it('stores a write-only secret an adapter can read back with the master key, and nothing without it', async () => {
    await withTenant(A.id, async (tx) => {
      await expect(upsertConnection(tx, { kind: 'fax', name: 'x', master: MASTER })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(upsertConnection(tx, { kind: 'razorpayx', name: 'Payouts', secret: 'k', master: undefined })).rejects.toMatchObject({ code: 'MAIL_KEY_MISSING' })
      const c = await upsertConnection(tx, { kind: 'razorpayx', name: 'Payouts', config: { accountNumber: '2323230012345678' }, secret: 'rzp_key:rzp_secret', master: MASTER })
      expect(c).toMatchObject({ kind: 'razorpayx', has_secret: true, config: { accountNumber: '2323230012345678' } })
      expect(JSON.stringify(await listConnections(tx))).not.toContain('rzp_secret')
      expect(await connectionSecret(tx, c.id, MASTER)).toBe('rzp_key:rzp_secret')
      expect(await connectionSecret(tx, c.id, 'wrong')).toBeNull()
      const same = await upsertConnection(tx, { kind: 'razorpayx', name: 'Payouts', config: { accountNumber: '999' }, master: MASTER })   // no secret given: the old one stays
      expect(same.has_secret).toBe(true)
      expect(await connectionSecret(tx, c.id, MASTER)).toBe('rzp_key:rzp_secret')
    })
  })
})
