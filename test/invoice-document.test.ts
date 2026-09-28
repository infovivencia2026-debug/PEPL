/**
 * The tax invoice. What a CFO is handed, and the one calculation on it that
 * software gets wrong: which head the GST sits under.
 */
import { describe, it, expect } from 'vitest'
import { splitGst, renderInvoicePdf, type Supplier } from '../src/control-plane/invoice-pdf.ts'
import { amountInWords } from '../src/payroll/payslip-pdf.ts'

const supplier: Supplier = {
  legalName: 'PEPL Software Pvt Ltd',
  address: 'Plot 4, HITEC City, Hyderabad 500081',
  gstin: '36AAAAA0000A1Z5',
  stateCode: 'TS',
  email: 'accounts@pepl.test',
  bank: {
    name: 'HDFC Bank, Madhapur',
    accountName: 'PEPL Software Pvt Ltd',
    accountNumber: '50200012345678',
    ifsc: 'HDFC0001234',
  },
}

const invoice = {
  number: 'INV-2026-ABC123-00007', period_start: '2026-09-01', period_end: '2026-09-30',
  plan_code: 'growth', plan_name: 'Growth', employees: 24,
  base_paise: '500000', per_employee_paise: '8000', subtotal_paise: '692000',
  gst_rate: '0.18', gst_paise: '124560', total_paise: '816560',
  status: 'due', due_on: '2026-10-07', paid_at: null, payment_reference: null,
  created_at: '2026-10-01T00:00:00.000Z',
  customer_name: 'Vindhya Textiles Pvt Ltd',
  billing_gstin: '36BBBBB1111B1Z5', billing_address: 'Plot 9, Jeedimetla, Hyderabad 500055',
  billing_state_code: 'TS', billing_email: 'accounts@vindhya.test',
}

describe('GST is split by place of supply', () => {
  it('same state as the supplier is CGST + SGST at half the rate each', () => {
    const s = splitGst(124560n, 18, 'TS', 'TS')
    expect(s.intraState).toBe(true)
    expect(s.cgstPaise + s.sgstPaise).toBe(124560n)
    expect(s.cgstPaise).toBe(62280n)
    expect(s.igstPaise).toBe(0n)
  })

  it('a different state is IGST at the full rate', () => {
    const s = splitGst(124560n, 18, 'TS', 'MH')
    expect(s.intraState).toBe(false)
    expect(s.igstPaise).toBe(124560n)
    expect(s.cgstPaise).toBe(0n)
  })

  it('an odd paisa goes to CGST rather than vanishing', () => {
    // The halves must re-add to exactly what was charged. Rounding each half
    // independently is how an invoice ends up a paisa short of its own total.
    const s = splitGst(12345n, 18, 'KA', 'KA')
    expect(s.cgstPaise + s.sgstPaise).toBe(12345n)
    expect(s.cgstPaise - s.sgstPaise).toBe(1n)
  })

  it('an unknown state falls back to IGST, never to a same-state assumption', () => {
    // Claiming intra-state when we do not know is the expensive mistake: the
    // customer cannot claim credit for a head they should not have been charged.
    expect(splitGst(1000n, 18, 'TS', null).igstPaise).toBe(1000n)
    expect(splitGst(1000n, 18, null, 'TS').igstPaise).toBe(1000n)
    expect(splitGst(1000n, 18, null, null).intraState).toBe(false)
  })
})

describe('the document', () => {
  it('renders a PDF carrying the invoice number, both GSTINs and the total', () => {
    const bytes = renderInvoicePdf(invoice, supplier)
    const text = bytes.toString('latin1')
    expect(text.startsWith('%PDF-')).toBe(true)
    expect(text).toContain('TAX INVOICE')
    expect(text).toContain('INV-2026-ABC123-00007')
    expect(text).toContain('36AAAAA0000A1Z5')   // supplier
    expect(text).toContain('36BBBBB1111B1Z5')   // customer
    expect(text).toContain('997331')            // SAC
    expect(text).toContain('CGST')              // same state, so split
    expect(text).not.toContain('IGST')
  })

  it('an out-of-state customer gets IGST on the face of the document', () => {
    const text = renderInvoicePdf({ ...invoice, billing_state_code: 'MH' }, supplier).toString('latin1')
    expect(text).toContain('IGST')
    expect(text).not.toContain('CGST')
  })

  it('without a supplier GSTIN it refuses to call itself a tax invoice', () => {
    // A dev box or a demo must never emit something that looks fileable and is
    // not; a customer who files against it has a problem we created.
    const text = renderInvoicePdf(invoice, { ...supplier, gstin: null }).toString('latin1')
    expect(text).not.toContain('TAX INVOICE')
    expect(text).toContain('Not a tax invoice')
  })
})

describe('the amount in words', () => {
  it('says the paise, because on a tax invoice the words are the controlling figure', () => {
    // A payslip rounds every line to the rupee so paise never arise there; 18%
    // GST lands on a paisa constantly, and words that quietly drop them state a
    // different amount from the figures above them.
    expect(amountInWords(816560n)).toBe('Eight thousand one hundred and sixty-five rupees and sixty paise only')
    expect(amountInWords(100000n)).toBe('One thousand rupees only')
    expect(amountInWords(60n)).toBe('Zero rupees and sixty paise only')
  })

  it('is singular where it should be', () => {
    expect(amountInWords(101n)).toBe('One rupee and one paisa only')
    expect(amountInWords(100n)).toBe('One rupee only')
    expect(amountInWords(0n)).toBe('Zero rupees only')
  })
})

describe('how the customer pays it', () => {
  it('names the account, because "transfer to the account on file" is not payable', () => {
    // The invoice asked for a bank transfer and showed no account for months.
    // A finance team cannot act on that, and nobody notices until a customer
    // rings up to ask where to send the money.
    const text = renderInvoicePdf(invoice, supplier).toString('latin1')
    expect(text).toContain('PAY BY TRANSFER TO')
    expect(text).toContain('50200012345678')
    expect(text).toContain('HDFC0001234')
    expect(text).toContain('Quote INV-2026-ABC123-00007 as the payment reference.')
  })

  it('says the details are missing rather than instructing a transfer to nowhere', () => {
    const text = renderInvoicePdf(invoice, { ...supplier, bank: null }).toString('latin1')
    expect(text).not.toContain('PAY BY TRANSFER TO')
    expect(text).toContain('Bank details are not configured')
  })
})
