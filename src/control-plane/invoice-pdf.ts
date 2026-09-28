/**
 * The tax invoice.
 *
 * A finance team will not pay against a line in a web page; they need a
 * document with a number on it, and in India it has to be a GST tax invoice or
 * the customer cannot claim input credit. That makes this a revenue document,
 * not a report.
 *
 * The one rule that decides the whole layout: GST splits by PLACE OF SUPPLY.
 * A customer registered in the supplier's own state pays CGST + SGST at half
 * the rate each; a customer anywhere else pays IGST at the full rate. The
 * totals are identical, the tax heads are not, and a wrong head is the
 * customer's problem at their next filing — so the split is computed here from
 * the state on file and never guessed.
 *
 * The supplier's own identity comes from the environment, because it belongs to
 * the deployment rather than to any tenant. Without PEPL_GSTIN the document is
 * still produced, marked as not a tax invoice, so a demo or a dev box never
 * emits something that looks fileable and is not.
 */
import { PdfPage, renderPdf, PAGE_HEIGHT, PAGE_WIDTH } from '../pdf/document.ts'
import { rupees, amountInWords } from '../payroll/payslip-pdf.ts'
import { controlDb, ControlPlaneError } from './index.ts'

/** SAC for "on-line software services" — what a subscription to PEPL is. */
const SAC_CODE = '997331'

export interface Supplier {
  legalName: string
  address: string
  gstin: string | null
  stateCode: string | null
  email: string | null
  /** Where the money goes. An invoice that asks for a transfer and names no
   *  account cannot be acted on by the customer's accounts team. */
  bank: { name: string; accountName: string; accountNumber: string; ifsc: string } | null
}

export function supplierFromEnv(): Supplier {
  return {
    legalName: process.env.PEPL_LEGAL_NAME ?? 'PEPL',
    address: process.env.PEPL_ADDRESS ?? '',
    gstin: process.env.PEPL_GSTIN ?? null,
    stateCode: process.env.PEPL_STATE_CODE ?? null,
    email: process.env.PEPL_BILLING_EMAIL ?? null,
    // All four or none: a half-filled block is worse than no block, because it
    // looks like remittance instructions and cannot be paid against.
    bank: process.env.PEPL_BANK_ACCOUNT_NUMBER && process.env.PEPL_BANK_IFSC
      ? {
        name: process.env.PEPL_BANK_NAME ?? '',
        accountName: process.env.PEPL_BANK_ACCOUNT_NAME ?? (process.env.PEPL_LEGAL_NAME ?? ''),
        accountNumber: process.env.PEPL_BANK_ACCOUNT_NUMBER,
        ifsc: process.env.PEPL_BANK_IFSC,
      }
      : null,
  }
}

export interface TaxSplit {
  /** true when supplier and customer are in the same state. */
  intraState: boolean
  cgstPaise: bigint
  sgstPaise: bigint
  igstPaise: bigint
  ratePct: number
}

/**
 * Split the tax that was already charged. The total never changes — only which
 * heads it sits under — so this can never alter what the customer owes.
 */
export function splitGst(totalGstPaise: bigint, ratePct: number, supplierState: string | null, placeOfSupply: string | null): TaxSplit {
  // With either state unknown we cannot claim the supply is intra-state, and
  // IGST is the head that is recoverable either way, so it is the safe default.
  const intraState = !!supplierState && !!placeOfSupply &&
    supplierState.toUpperCase() === placeOfSupply.toUpperCase()
  if (!intraState) {
    return { intraState: false, cgstPaise: 0n, sgstPaise: 0n, igstPaise: totalGstPaise, ratePct }
  }
  // Halve to the paisa, giving any odd paisa to CGST so the two always re-add
  // to the charged total rather than drifting by rounding.
  const half = totalGstPaise / 2n
  const odd = totalGstPaise - half * 2n
  return { intraState: true, cgstPaise: half + odd, sgstPaise: half, igstPaise: 0n, ratePct }
}

interface InvoiceRow {
  number: string; period_start: string; period_end: string; plan_code: string; plan_name: string
  employees: number; base_paise: string; per_employee_paise: string; subtotal_paise: string
  gst_rate: string; gst_paise: string; total_paise: string; status: string; due_on: string
  paid_at: string | null; payment_reference: string | null; created_at: string
  customer_name: string; billing_gstin: string | null; billing_address: string | null
  billing_state_code: string | null; billing_email: string | null
}

export async function loadInvoice(invoiceId: string): Promise<InvoiceRow> {
  const { rows } = await controlDb.query<InvoiceRow>(
    `SELECT i.number, i.period_start::text, i.period_end::text, i.plan_code,
            coalesce(p.name, i.plan_code) AS plan_name,
            i.employees, i.base_paise::text, i.per_employee_paise::text, i.subtotal_paise::text,
            i.gst_rate::text, i.gst_paise::text, i.total_paise::text, i.status, i.due_on::text,
            i.paid_at::text, i.payment_reference, i.created_at::text,
            t.legal_name AS customer_name,
            s.billing_gstin, s.billing_address, s.billing_state_code, s.billing_email
       FROM control_plane.invoices i
       JOIN tenants t ON t.id = i.tenant_id
       LEFT JOIN control_plane.subscriptions s ON s.tenant_id = i.tenant_id
       LEFT JOIN control_plane.plans p ON p.code = i.plan_code
      WHERE i.id = $1`, [invoiceId])
  if (!rows[0]) throw new ControlPlaneError('INVOICE_NOT_FOUND', 'no such invoice')
  return rows[0]
}

const DATE = (iso: string): string =>
  new Date(`${iso.slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' })

export function renderInvoicePdf(inv: InvoiceRow, supplier: Supplier): Buffer {
  const page = new PdfPage()
  const M = 46
  const right = PAGE_WIDTH - M
  let y = PAGE_HEIGHT - 52

  const filable = !!supplier.gstin
  page.text(filable ? 'TAX INVOICE' : 'INVOICE', M, y, { size: 19, font: 'bold' })
  page.textRight(supplier.legalName, right, y, { size: 14, font: 'bold' })
  y -= 15
  if (!filable) {
    // Never let a document that cannot be filed look like one that can.
    page.text('Not a tax invoice - no GSTIN configured for the supplier', M, y, { size: 8.5, grey: 0.35 })
  }
  page.textRight(supplier.address.slice(0, 70), right, y, { size: 8.5, grey: 0.35 })
  y -= 11
  if (supplier.gstin) page.textRight(`GSTIN ${supplier.gstin}`, right, y, { size: 8.5, grey: 0.35 })
  y -= 11
  if (supplier.email) page.textRight(supplier.email, right, y, { size: 8.5, grey: 0.35 })

  y -= 18
  page.line(M, y, right, y)
  y -= 20

  // Invoice identity on the right, the customer on the left.
  const midpoint = M + (right - M) / 2
  const topOfBlock = y
  page.text('BILL TO', M, y, { size: 8, font: 'bold', grey: 0.4 })
  y -= 13
  page.text(inv.customer_name, M, y, { size: 11, font: 'bold' })
  y -= 12
  for (const addressLine of (inv.billing_address ?? '-').split(/\r?\n/).slice(0, 3)) {
    page.text(addressLine.slice(0, 52), M, y, { size: 9 })
    y -= 11
  }
  if (inv.billing_gstin) {
    page.text(`GSTIN ${inv.billing_gstin}`, M, y, { size: 9 })
    y -= 11
  }
  page.text(`Place of supply: ${inv.billing_state_code ?? 'not on file'}`, M, y, { size: 9 })
  const leftBottom = y

  let ry = topOfBlock
  const field = (label: string, value: string) => {
    page.text(label, midpoint, ry, { size: 8, font: 'bold', grey: 0.4 })
    page.textRight(value, right, ry, { size: 9 })
    ry -= 13
  }
  field('Invoice number', inv.number)
  field('Invoice date', DATE(inv.created_at))
  field('Due date', DATE(inv.due_on))
  field('Billing period', `${DATE(inv.period_start)} - ${DATE(inv.period_end)}`)
  field('Status', inv.status === 'paid' ? `Paid ${inv.paid_at ? DATE(inv.paid_at) : ''}`.trim() : inv.status)
  if (inv.payment_reference) field('Reference', inv.payment_reference.slice(0, 32))

  y = Math.min(leftBottom, ry) - 20
  page.line(M, y, right, y)
  y -= 18

  const cols = { desc: M, sac: M + 250, qty: M + 350, rate: M + 430, amount: right }
  page.text('DESCRIPTION', cols.desc, y, { size: 8, font: 'bold', grey: 0.4 })
  page.text('SAC', cols.sac, y, { size: 8, font: 'bold', grey: 0.4 })
  page.textRight('QTY', cols.qty, y, { size: 8, font: 'bold', grey: 0.4 })
  page.textRight('RATE', cols.rate, y, { size: 8, font: 'bold', grey: 0.4 })
  page.textRight('AMOUNT', cols.amount, y, { size: 8, font: 'bold', grey: 0.4 })
  y -= 8
  page.line(M, y, right, y)
  y -= 16

  const row = (desc: string, qty: string, rate: string, amount: string) => {
    page.text(desc, cols.desc, y, { size: 9.5 })
    page.text(SAC_CODE, cols.sac, y, { size: 9 })
    page.textRight(qty, cols.qty, y, { size: 9 })
    page.textRight(rate, cols.rate, y, { size: 9 })
    page.textRight(amount, cols.amount, y, { size: 9.5 })
    y -= 16
  }
  row(`${inv.plan_name} plan - platform fee`, '1', rupees(inv.base_paise), rupees(inv.base_paise))
  const perPerson = BigInt(inv.per_employee_paise)
  if (perPerson > 0n) {
    row(`${inv.plan_name} plan - per person`, String(inv.employees),
      rupees(inv.per_employee_paise), rupees(perPerson * BigInt(inv.employees)))
  }

  y -= 4
  page.line(M, y, right, y)
  y -= 18

  // Totals, with the tax split that the place of supply decides.
  const rate = Number(inv.gst_rate) * 100
  const split = splitGst(BigInt(inv.gst_paise), rate, supplier.stateCode, inv.billing_state_code)
  const total = (label: string, value: string, bold = false) => {
    page.textRight(label, cols.rate, y, { size: bold ? 10 : 9, font: bold ? 'bold' : 'regular' })
    page.textRight(value, cols.amount, y, { size: bold ? 11 : 9.5, font: bold ? 'bold' : 'regular' })
    y -= 15
  }
  total('Taxable value', rupees(inv.subtotal_paise))
  if (split.intraState) {
    total(`CGST @ ${(rate / 2).toFixed(2)}%`, rupees(split.cgstPaise))
    total(`SGST @ ${(rate / 2).toFixed(2)}%`, rupees(split.sgstPaise))
  } else {
    total(`IGST @ ${rate.toFixed(2)}%`, rupees(split.igstPaise))
  }
  y -= 3
  page.line(cols.rate - 80, y, right, y)
  y -= 16
  total('Total', rupees(inv.total_paise), true)

  y -= 10
  page.text('Amount in words', M, y, { size: 8, font: 'bold', grey: 0.4 })
  y -= 12
  page.text(amountInWords(BigInt(inv.total_paise)), M, y, { size: 9.5 })

  y -= 30
  page.line(M, y, right, y)
  y -= 15

  if (supplier.bank) {
    page.text('PAY BY TRANSFER TO', M, y, { size: 8, font: 'bold', grey: 0.4 })
    y -= 13
    const pair = (label: string, value: string) => {
      page.text(label, M, y, { size: 9, grey: 0.4 })
      page.text(value, M + 96, y, { size: 9.5 })
      y -= 12
    }
    if (supplier.bank.accountName) pair('Account name', supplier.bank.accountName)
    if (supplier.bank.name) pair('Bank', supplier.bank.name)
    pair('Account number', supplier.bank.accountNumber)
    pair('IFSC', supplier.bank.ifsc)
    y -= 3
    page.text(`Quote ${inv.number} as the payment reference.`, M, y, { size: 8.5, grey: 0.35 })
    y -= 13
  } else {
    // Say what is missing rather than instructing a transfer to nowhere.
    page.text('Bank details are not configured on this deployment; ask your account manager where to remit.', M, y, { size: 8.5, grey: 0.35 })
    y -= 13
  }
  page.text('This is a computer-generated document and is valid without a signature.', M, y, { size: 8.5, grey: 0.35 })

  return renderPdf(page, `Invoice ${inv.number}`)
}

export async function invoicePdf(invoiceId: string): Promise<{ fileName: string; bytes: Buffer }> {
  const inv = await loadInvoice(invoiceId)
  return { fileName: `${inv.number}.pdf`, bytes: renderInvoicePdf(inv, supplierFromEnv()) }
}
