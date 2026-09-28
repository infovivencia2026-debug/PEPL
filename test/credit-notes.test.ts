/**
 * Credit notes: reversing money that has actually moved.
 *
 * The invoice suite already proves a PAID invoice cannot be voided. This is the
 * other half — what you do instead, and the two ways a credit note goes wrong:
 * crediting more than was invoiced, and restating the tax at today's rate
 * instead of the rate the customer was charged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { closePools } from '../src/db/pool.ts'
import { controlDb } from '../src/control-plane/index.ts'
import { signup, closePeriods, markInvoicePaid, listInvoices } from '../src/control-plane/billing.ts'
import { issueCreditNote, listCreditNotes, creditedAgainst } from '../src/control-plane/credit-notes.ts'

let tenantId: string
let invoiceId: string
let invoiceTotal: bigint
const stamp = Date.now()

beforeAll(async () => {
  const r = await signup({
    legalName: `CreditCo ${stamp}`,
    adminEmail: `credit-${stamp}@creditco.test`,
    adminName: 'Test Admin',
    password: 'a-long-enough-passphrase',
    planCode: 'growth',
    stateCode: 'TS',
  })
  tenantId = r.tenantId

  // End the period so there is something to invoice, then settle it: a credit
  // note only exists for money already received.
  await controlDb.query(
    `UPDATE control_plane.subscriptions
        SET current_period_start = CURRENT_DATE - 31, current_period_end = CURRENT_DATE - 1,
            status = 'active', trial_ends_on = NULL
      WHERE tenant_id = $1`, [tenantId])
  await closePeriods()
  const invoices = await listInvoices(tenantId)
  invoiceId = invoices[0]!.id
  invoiceTotal = BigInt(invoices[0]!.total_paise)
  await markInvoicePaid(invoiceId, 'UTR-CREDIT-TEST')
})

afterAll(async () => {
  await closePools()
  await controlDb.end()
})

describe('a credit note reverses a paid invoice', () => {
  it('numbers itself in its own series, never the invoice series', async () => {
    // A gap in either sequence has to mean exactly one thing, so the two cannot
    // share a counter.
    const note = await issueCreditNote({ invoiceId, subtotalPaise: 100000, reason: 'Agreed goodwill adjustment' })
    expect(note.number).toMatch(/^CRN-\d{4}-[0-9A-F]{6}-00001$/)
    expect(note.number.startsWith('INV-')).toBe(false)
  })

  it('adds GST at the invoice rate, so the reversal matches what was charged', async () => {
    const note = await issueCreditNote({ invoiceId, subtotalPaise: 100000, reason: 'Second adjustment' })
    // 18% of 1,00,000 paise is 18,000 — total 1,18,000.
    expect(note.gst_paise).toBe('18000')
    expect(note.total_paise).toBe('118000')
  })

  it('refuses to credit more than the invoice', async () => {
    // Two credits that each pass on their own and jointly exceed the invoice is
    // the failure this guards: the customer is owed money nobody recorded.
    await expect(
      issueCreditNote({ invoiceId, subtotalPaise: Number(invoiceTotal), reason: 'Over-credit attempt' }),
    ).rejects.toMatchObject({ code: 'CREDIT_EXCEEDS_INVOICE' })
  })

  it('refuses an amount that is not positive', async () => {
    await expect(issueCreditNote({ invoiceId, subtotalPaise: 0, reason: 'Nothing' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('insists on a reason, because a credit has to be explicable later', async () => {
    await expect(issueCreditNote({ invoiceId, subtotalPaise: 1000, reason: '   ' }))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('tracks the running total credited against the invoice', async () => {
    const credited = await creditedAgainst(invoiceId)
    const notes = await listCreditNotes(tenantId)
    const sum = notes.reduce((t, n) => t + BigInt(n.total_paise), 0n)
    expect(credited).toBe(sum)
    expect(credited).toBeLessThanOrEqual(invoiceTotal)
  })

  it('will not credit an invoice that was never paid', async () => {
    // An unpaid invoice is voided instead; crediting one would reverse money
    // that never arrived.
    await controlDb.query(
      `UPDATE control_plane.invoices SET status = 'due', paid_at = NULL WHERE id = $1`, [invoiceId])
    await expect(issueCreditNote({ invoiceId, subtotalPaise: 1000, reason: 'Not paid yet' }))
      .rejects.toMatchObject({ code: 'INVOICE_NOT_PAID' })
    await controlDb.query(
      `UPDATE control_plane.invoices SET status = 'paid', paid_at = now() WHERE id = $1`, [invoiceId])
  })
})
