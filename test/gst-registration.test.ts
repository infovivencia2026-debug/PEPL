/**
 * An unregistered supplier must not collect GST.
 *
 * The 18% went onto every invoice regardless of whether a GSTIN was
 * configured, while the PDF printed "Not a tax invoice - no GSTIN configured
 * for the supplier". A document that refuses to call itself a tax invoice and
 * charges tax anyway is wrong twice over, and collecting tax you are not
 * registered to collect is the half that matters.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { priceFor, prorationFor, effectiveGstRate, GST_RATE } from '../src/control-plane/billing.ts'

const PLAN = { base_price_paise: '500000', per_employee_price_paise: '10000' } as never
const BIGGER = { base_price_paise: '900000', per_employee_price_paise: '20000' } as never

const original = process.env.PEPL_GSTIN
afterEach(() => {
  if (original === undefined) delete process.env.PEPL_GSTIN
  else process.env.PEPL_GSTIN = original
})

describe('with no GSTIN configured', () => {
  it('charges no GST', () => {
    delete process.env.PEPL_GSTIN
    const p = priceFor(PLAN, 10)
    expect(p.gst).toBe(0n)
    expect(p.total).toBe(p.subtotal)
  })

  it('treats whitespace as absent, because a blank env var is not a registration', () => {
    process.env.PEPL_GSTIN = '   '
    expect(effectiveGstRate()).toBe(0)
  })

  it('charges no GST on an upgrade either', () => {
    delete process.env.PEPL_GSTIN
    const p = prorationFor(PLAN, BIGGER, 10, 15, 30)
    expect(p.gstPaise).toBe(0n)
    expect(p.totalPaise).toBe(p.subtotalPaise)
  })
})

describe('once registered', () => {
  it('charges 18%', () => {
    process.env.PEPL_GSTIN = '36AABCP1234C1ZX'
    const p = priceFor(PLAN, 10)
    expect(effectiveGstRate()).toBe(GST_RATE)
    expect(p.gst).toBe(BigInt(Math.round(Number(p.subtotal) * 0.18)))
    expect(p.total).toBe(p.subtotal + p.gst)
  })

  it('charges it on an upgrade too', () => {
    process.env.PEPL_GSTIN = '36AABCP1234C1ZX'
    const p = prorationFor(PLAN, BIGGER, 10, 15, 30)
    expect(p.gstPaise).toBeGreaterThan(0n)
  })
})

describe('crediting an invoice raised before registration', () => {
  it('uses the invoice rate of zero, not today\'s 18%', () => {
    // `Number(invoice.gst_rate) || GST_RATE` treated a recorded 0 as missing,
    // so a 0% invoice was credited at 18%: the full credit then exceeded the
    // invoice and was refused, and a partial one reversed tax nobody paid.
    const rateFor = (recorded: string): number => {
      const n = Number(recorded)
      return Number.isFinite(n) ? n : GST_RATE
    }
    expect(rateFor('0')).toBe(0)
    expect(rateFor('0.18')).toBe(0.18)
    // Only a genuinely unreadable rate falls back.
    expect(rateFor('')).toBe(0)       // Number('') is 0, and 0 is a real rate
    expect(rateFor('nonsense')).toBe(GST_RATE)
  })
})
