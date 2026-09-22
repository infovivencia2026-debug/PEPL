/**
 * A company signs up without talking to us, sees its plan and bill, changes
 * plan, gets invoiced when a period ends, and is suspended — modules off,
 * data kept — when it stops paying. Then reactivated when it pays.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createHandler } from '../src/http/router.ts'
import { buildRouter } from '../src/http/app.ts'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { closePeriods, runDunning, markInvoicePaid, voidInvoice, listInvoices, priceFor, GST_RATE } from '../src/control-plane/billing.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { resolveConfig } from '../src/config/resolver.ts'

let server: Server
let base: string
let tenantId: string
let token: string
const stamp = Date.now()
const email = `founder-${stamp}@newco.test`

const api = async (method: string, path: string, body?: unknown, tok?: string) => {
  const r = await fetch(`${base}/api/v1${path}`, {
    method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: r.status, body: (r.status === 204 ? {} : (await r.json())) as Record<string, unknown> & { error?: { code: string } } }
}

afterAll(async () => { server?.close(); await closePools(); await controlDb.end() })

describe('signup and billing', () => {
  it('plans are public; signup provisions a trial tenant and signs the admin in', async () => {
    server = createServer(createHandler(buildRouter()))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`

    const plans = await api('GET', '/plans')
    expect(plans.status).toBe(200)
    expect((plans.body.plans as { code: string }[]).map((p) => p.code)).toContain('professional')

    // Cheapest first, because a plan table is read left to right and a sales
    // deck is built on that order. The prices are text in the payload, so an
    // unqualified ORDER BY on the aliased column sorts 12000 before 2000.
    const prices = (plans.body.plans as { base_price_paise: string }[]).map((p) => Number(p.base_price_paise))
    expect(prices).toEqual([...prices].sort((a, b) => a - b))

    expect((await api('POST', '/signup', { legalName: 'NewCo', adminEmail: 'bad', adminName: 'F', password: 'a-long-passphrase' })).status).toBe(422)
    expect((await api('POST', '/signup', { legalName: 'NewCo', adminEmail: email, adminName: 'F', password: 'short' })).body.error?.code).toBe('WEAK_PASSWORD')

    const s = await api('POST', '/signup', { legalName: `NewCo ${stamp} Pvt Ltd`, adminEmail: email, adminName: 'Founder', password: 'a-long-passphrase-1', stateCode: 'TS' })
    if (s.status !== 201) console.log('signup:', JSON.stringify(s.body))
    expect(s.status).toBe(201)
    tenantId = s.body.tenantId as string
    token = s.body.token as string
    expect((s.body.user as { roles: string[] }).roles).toEqual(['org_admin'])

    // the same email cannot start a second company
    expect((await api('POST', '/signup', { legalName: 'Again', adminEmail: email, adminName: 'F', password: 'a-long-passphrase-1' })).body.error?.code).toBe('EMAIL_TAKEN')

    const me = await api('GET', '/me', undefined, token)
    expect(me.status).toBe(200)
    const bill = await api('GET', '/billing', undefined, token)
    expect(bill.status).toBe(200)
    expect(bill.body).toMatchObject({ status: 'trialing', active_employees: 0 })
    expect((bill.body.plan as { code: string }).code).toBe('trial')
    expect(bill.body.trial_ends_on).toBeTruthy()
  })

  it('billing details validate GSTIN; plan change is immediate and refuses an over-limit downgrade', async () => {
    expect((await api('PATCH', '/billing', { gstin: 'not-a-gstin' }, token)).status).toBe(422)
    const ok = await api('PATCH', '/billing', { gstin: '36aaaaa0000a1z5', address: 'Hyderabad', email: `accounts-${stamp}@newco.test` }, token)
    expect(ok.status).toBe(200)
    expect(ok.body.billing_gstin).toBe('36AAAAA0000A1Z5')

    expect((await api('POST', '/billing/plan', { planCode: 'nope' }, token)).status).toBe(404)
    const up = await api('POST', '/billing/plan', { planCode: 'professional' }, token)
    expect(up.status).toBe(200)
    expect(up.body.status).toBe('active')
    expect((up.body.plan as { code: string }).code).toBe('professional')

    // fill past the starter limit, then try to downgrade to it
    const starter = (await controlDb.query<{ limits: { employees: number } }>(`SELECT limits FROM control_plane.plans WHERE code = 'starter'`)).rows[0]!
    const limit = starter.limits.employees
    await withTenant(tenantId, async (tx) => {
      for (let i = 0; i <= limit; i++) {
        await tx.query(`INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining) VALUES ($1,$2,'E',DATE '2026-01-01')`, [tenantId, `N-${String(i).padStart(4, '0')}`])
      }
    })
    const down = await api('POST', '/billing/plan', { planCode: 'starter' }, token)
    expect(down.status).toBe(409)
    expect(down.body.error?.code).toBe('OVER_PLAN_LIMIT')
    const est = await api('GET', '/billing', undefined, token)
    expect(est.body.active_employees).toBe(limit + 1)
  })

  it('a period end produces an invoice with GST; dunning suspends an unpaid company (modules off), payment reactivates it', async () => {
    // end the current period yesterday
    await controlDb.query(`UPDATE control_plane.subscriptions SET current_period_start = CURRENT_DATE - 31, current_period_end = CURRENT_DATE - 1 WHERE tenant_id = $1`, [tenantId])
    const closed = await closePeriods()
    expect(closed.invoiced).toBeGreaterThanOrEqual(1)
    const inv = await api('GET', '/billing/invoices', undefined, token)
    const invoices = inv.body.invoices as { id: string; number: string; status: string; employees: number; subtotal_paise: string; gst_paise: string; total_paise: string; due_on: string }[]
    expect(invoices).toHaveLength(1)
    const plan = (await controlDb.query<{ code: string; name: string; base_price_paise: string; per_employee_price_paise: string; features: Record<string, boolean>; limits: Record<string, number> }>(
      `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits FROM control_plane.plans WHERE code = 'professional'`)).rows[0]!
    const p = priceFor(plan, invoices[0]!.employees)
    expect(invoices[0]!.subtotal_paise).toBe(String(p.subtotal))
    expect(invoices[0]!.gst_paise).toBe(String(p.gst))
    expect(Number(invoices[0]!.gst_paise)).toBe(Math.round(Number(invoices[0]!.subtotal_paise) * GST_RATE))
    expect(invoices[0]!.number).toMatch(/^INV-\d{4}-[0-9A-F]{6}-00001$/)
    // running the close again invoices nothing new
    expect((await closePeriods()).invoiced).toBe(0)

    // 20 days past due: past_due, still working
    await controlDb.query(`UPDATE control_plane.invoices SET due_on = CURRENT_DATE - 20 WHERE tenant_id = $1`, [tenantId])
    await runDunning()
    expect((await api('GET', '/billing', undefined, token)).body.status).toBe('past_due')
    expect((await api('GET', '/payroll/periods', undefined, token)).status).toBe(200)

    // 50 days: suspended — the subscription sells nothing, so payroll is off, data intact
    await controlDb.query(`UPDATE control_plane.invoices SET due_on = CURRENT_DATE - 50 WHERE tenant_id = $1`, [tenantId])
    await runDunning()
    expect((await api('GET', '/billing', undefined, token)).body.status).toBe('suspended')
    const off = await withTenant(tenantId, async (tx) => (await resolveConfig(tx, tenantId)).isEnabled('payroll.enabled'))
    expect(off).toBe(false)
    expect((await api('GET', '/payroll/periods', undefined, token)).status).toBe(403)
    const still = await withTenant(tenantId, async (tx) => (await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM employees`)).rows[0]!.n)
    expect(Number(still)).toBeGreaterThan(1)

    // payment: reactivated on the spot
    const paid = await markInvoicePaid(invoices[0]!.id, 'UTR-TEST-001')
    expect(paid.status).toBe('paid')
    expect((await api('GET', '/billing', undefined, token)).body.status).toBe('active')
    expect((await api('GET', '/payroll/periods', undefined, token)).status).toBe(200)

    // A paid invoice is not voidable. Reversing one is a credit note, which is a
    // different document with its own number; silently voiding it would leave the
    // customer's ledger and ours disagreeing about money already received.
    await expect(voidInvoice(invoices[0]!.id, 'changed my mind')).rejects.toMatchObject({ code: 'INVOICE_NOT_FOUND' })
  })

  it('an invoice raised in error is voided, not deleted, and stops being chased', async () => {
    // Bill a fresh period so there is an unpaid invoice to void.
    await closePeriods(new Date(Date.UTC(2027, 0, 15)))
    const due = (await listInvoices(tenantId)).filter((i) => i.status === 'due')
    expect(due.length).toBeGreaterThan(0)

    const voided = await voidInvoice(due[0]!.id, 'billed on the wrong headcount')
    expect(voided.status).toBe('void')

    // The number survives: a gap in an invoice sequence is the first thing a
    // CFO asks about, and dunning must stop chasing a debt that is not owed.
    const after = await listInvoices(tenantId)
    expect(after.map((i) => i.number)).toContain(voided.number)
    expect(after.find((i) => i.id === due[0]!.id)?.status).toBe('void')
  })

  it('support access is granted by the tenant, listed, and revoked; another tenant\'s grant is not reachable', async () => {
    const agent = '99999999-9999-4999-8999-999999999999'
    const g = await api('POST', '/support-access', { agentId: agent, reason: 'ticket 1: payslip PF', hours: 2 }, token)
    expect(g.status).toBe(201)
    const list = await api('GET', '/support-access', undefined, token)
    expect((list.body.grants as { id: string; active: boolean }[]).find((x) => x.id === g.body.id)!.active).toBe(true)
    expect((await api('POST', `/support-access/${g.body.id}/revoke`, undefined, token)).status).toBe(204)
    expect((await api('GET', '/support-access', undefined, token)).body.grants).toEqual(expect.arrayContaining([expect.objectContaining({ id: g.body.id, active: false })]))
    expect((await api('POST', `/support-access/00000000-0000-4000-8000-000000000000/revoke`, undefined, token)).status).toBe(404)
  })
})
