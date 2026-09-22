/**
 * B6. Work reports: templates seed by organisation type, fields validate by
 * type, a daily report files once, a returned report tells the author, the
 * missing list is punched-in people without today's report. Branding: colours
 * and domain validate, the custom domain resolves pre-login through the owner
 * lookup and is unique across companies, the email footer and payslip header
 * are read from it. WhatsApp: opt-in needs E.164; delivery sends only to
 * opted-in people through the company's provider; a failing provider retries
 * up to the limit; the Meta payload is a template when one is mapped.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { notify } from '../src/comms/index.ts'
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { listTemplates, upsertTemplate, submitReport, reviewReport, listReports, missingDaily } from '../src/work/reports.ts'
import { getBranding, setBranding, brandingForHost } from '../src/control-plane/branding.ts'
import { setProvider, optIn, optOut, status, deliverWhatsApp, buildPayload, getProvider } from '../src/comms/whatsapp.ts'

let A: Tenant; let B: Tenant
let empUser: string; let mgrUser: string
beforeAll(async () => {
  const s = await resetAndSeed(); A = s.a; B = s.b
  await controlPool.query(`UPDATE tenants SET organisation_type = 'manufacturing' WHERE id = $1`, [A.id])
  await withTenant(A.id, async (tx) => {
    const mgr = (await tx.query<{ id: string }>(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,'A-WMG','Mgr',DATE '2024-01-01') RETURNING id`, [A.id])).rows[0]!.id
    mgrUser = await createUser(tx, { tenantId: A.id, email: 'wmgr@acme.test', fullName: 'Mgr', password: 'a-long-password-1', roles: ['manager'], employeeId: mgr })
    empUser = await createUser(tx, { tenantId: A.id, email: 'wemp@acme.test', fullName: 'Emp', password: 'a-long-password-1', roles: ['employee'], employeeId: A.employeeId })
  })
})
afterAll(async () => { await closePools(); await controlPool.end() })

describe('work reports', () => {
  it('seeds the DPR for a manufacturing company, validates by field type, files once a day, returns with a note, lists the missing', async () => {
    await withTenant(A.id, async (tx) => {
      const t = await listTemplates(tx)
      expect(t.map((x) => x.code)).toEqual(['DPR'])
      await expect(upsertTemplate(tx, { code: 'X', name: 'X', fields: [{ key: 'Bad Key', label: 'x', type: 'text' }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(upsertTemplate(tx, { code: 'X', name: 'X', fields: [{ key: 'c', label: 'c', type: 'choice' }] })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const base = { templateCode: 'DPR', employeeId: A.employeeId, reportDate: '2026-10-06' }
      await expect(submitReport(tx, { ...base, values: { site: 'B' } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })                          // manpower required
      await expect(submitReport(tx, { ...base, values: { site: 'B', manpower: 'forty', work_done: 'x', incidents: false } })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const r = await submitReport(tx, { ...base, values: { site: 'Block B', manpower: 42, work_done: 'Slab L3', incidents: 'false', blockers: '' }, geo: { lat: 17.4, lng: 78.3 } })
      expect(r.values).toEqual({ site: 'Block B', manpower: 42, work_done: 'Slab L3', incidents: false })
      await expect(submitReport(tx, { ...base, values: { site: 'B', manpower: 1, work_done: 'x', incidents: false } })).rejects.toMatchObject({ code: 'REPORT_EXISTS' })
      await expect(reviewReport(tx, { reportId: r.id, status: 'returned', actorUserId: mgrUser })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const back = await reviewReport(tx, { reportId: r.id, status: 'returned', note: 'Count the contractor team', actorUserId: mgrUser })
      expect(back.status).toBe('returned')
      expect((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM notifications WHERE user_id = $1 AND event_type = 'report.returned'`, [empUser])).rows[0]!.n).toBe('1')
      expect((await listReports(tx, { templateCode: 'DPR', status: 'returned' })).length).toBe(1)
      // Rahul punched in on the 7th and has no DPR yet → he is on the list; the manager did not punch → not on it
      await recordPunch(tx, { employeeId: A.employeeId, punchedAt: '2026-10-07T03:30:00Z', localDate: '2026-10-07', direction: 'in', source: 'web' })
      await recomputeDay(tx, A.employeeId, '2026-10-07')
      expect((await missingDaily(tx, { templateCode: 'DPR', date: '2026-10-07' })).map((m) => m.employeeId)).toEqual([A.employeeId])
    })
    await withTenant(B.id, async (tx) => { expect(await listTemplates(tx)).toEqual([]) })   // no type: nothing seeded, nothing invented
  })
})

describe('branding', () => {
  it('validates colours and domain, resolves the domain pre-login, keeps domains unique across companies', async () => {
    await withTenant(A.id, async (tx) => {
      expect((await getBranding(tx)).product_name).toBeNull()
      await expect(setBranding(tx, { primaryColor: 'green' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(setBranding(tx, { customDomain: 'not a domain' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const b = await setBranding(tx, { productName: 'Acme People', primaryColor: '#1f6b4d', emailFooter: 'Acme Technologies · HR', payslipHeader: 'CIN U12345KA2020PTC000001', customDomain: 'People.Acme.in' })
      expect(b).toMatchObject({ product_name: 'Acme People', primary_color: '#1f6b4d', custom_domain: 'people.acme.in' })
      const again = await setBranding(tx, { accentColor: '#e39a5c' })
      expect(again.product_name).toBe('Acme People')                                     // a partial update keeps the rest
    })
    expect(await brandingForHost('people.acme.in:443')).toMatchObject({ tenantId: A.id, productName: 'Acme People', primaryColor: '#1f6b4d' })
    expect(await brandingForHost('unknown.example')).toBeNull()
    await withTenant(B.id, async (tx) => {
      await expect(setBranding(tx, { customDomain: 'people.acme.in' })).rejects.toMatchObject({ code: 'DOMAIN_TAKEN' })
      expect((await getBranding(tx)).product_name).toBeNull()                            // B sees nothing of A
    })
  })
})

describe('whatsapp', () => {
  let server: Server; let base = ''; const received: Array<{ auth: string | undefined; body: Record<string, unknown> }> = []; let failNext = 0
  beforeAll(async () => {
    server = createServer((req, res) => { let d = ''; req.on('data', (c) => { d += c }); req.on('end', () => { received.push({ auth: req.headers.authorization, body: JSON.parse(d) }); if (failNext > 0) { failNext--; res.statusCode = 500; res.end('boom') } else { res.statusCode = 200; res.end('{"messages":[{"id":"wamid.1"}]}') } }) })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

  it('opt-in needs E.164; only opted-in people get messages; a provider failure retries to the limit; Meta gets a template when mapped', async () => {
    const MASTER = 'test-master-key-for-whatsapp-0000000001'
    await withTenant(A.id, async (tx) => {
      await expect(optIn(tx, { userId: empUser, phone: '98765 43210' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await optIn(tx, { userId: empUser, phone: '+91 98765-43210' })
      expect(await status(tx, empUser)).toMatchObject({ optedIn: true, phone: '+919876543210', companyEnabled: false })
      await expect(setProvider(tx, { provider: 'generic_webhook', endpoint: 'ftp://x', master: MASTER })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(setProvider(tx, { provider: 'generic_webhook', endpoint: 'https://relay.example', secret: 'k', master: undefined })).rejects.toMatchObject({ code: 'MAIL_KEY_MISSING' })
      const p = await setProvider(tx, { provider: 'generic_webhook', endpoint: `${base}/send`, fromNumber: '+911234567890', secret: 'super-secret-token', master: MASTER })
      expect(p.has_secret).toBe(true)
      // two notifications: one for the opted-in employee (a whitelisted event), one for the manager who never opted in
      await notify(tx, { userId: empUser, eventType: 'approval.requested', title: 'Leave: Rahul, 2 days', body: 'Approve or reject', dedupeKey: 'wa1' })
      await notify(tx, { userId: mgrUser, eventType: 'approval.requested', title: 'For the manager', dedupeKey: 'wa2' })
      await notify(tx, { userId: empUser, eventType: 'chat.message', title: 'Not a WhatsApp event', dedupeKey: 'wa3' })
      failNext = 1
      expect(await deliverWhatsApp(tx, { master: MASTER })).toEqual({ sent: 0, failed: 1, skipped: 0 })        // provider down: attempt 1
      expect(await deliverWhatsApp(tx, { master: MASTER })).toEqual({ sent: 1, failed: 0, skipped: 0 })        // attempt 2 lands
      expect(received.length).toBe(2)
      expect(received[1]!.auth).toBe('Bearer super-secret-token')
      expect(received[1]!.body).toMatchObject({ to: '+919876543210', from: '+911234567890', text: 'Leave: Rahul, 2 days\nApprove or reject' })
      expect(await deliverWhatsApp(tx, { master: MASTER })).toEqual({ sent: 0, failed: 0, skipped: 0 })        // nothing left: the manager is not opted in, chat is not a WhatsApp event
      const row = (await tx.query<{ whatsapp_sent_at: string | null; whatsapp_attempts: number }>(`SELECT whatsapp_sent_at, whatsapp_attempts FROM notifications WHERE dedupe_key = 'wa1'`)).rows[0]!
      expect(row.whatsapp_sent_at).toBeTruthy(); expect(row.whatsapp_attempts).toBe(1)
      // a wrong master key: nothing is sent and nothing is claimed
      await notify(tx, { userId: empUser, eventType: 'payslip.published', title: 'Payslip for September', dedupeKey: 'wa4' })
      expect(await deliverWhatsApp(tx, { master: 'wrong-key' })).toEqual({ sent: 0, failed: 0, skipped: 0 })
      // opt-out stops it
      await optOut(tx, empUser)
      expect(await deliverWhatsApp(tx, { master: MASTER })).toEqual({ sent: 0, failed: 0, skipped: 0 })
      // Meta payload shape
      const meta = { ...(await getProvider(tx))!, provider: 'meta_cloud' as const, templates: { 'approval.requested': 'pepl_approval' } }
      expect(buildPayload(meta, { to: '+919876543210', text: 'x', template: 'pepl_approval', params: ['Leave', 'Approve'] }).body).toMatchObject({ messaging_product: 'whatsapp', to: '919876543210', type: 'template', template: { name: 'pepl_approval' } })
      expect(buildPayload(meta, { to: '+919876543210', text: 'hello', params: [] }).body).toMatchObject({ type: 'text', text: { body: 'hello' } })
    })
  })
})
