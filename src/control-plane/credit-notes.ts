/**
 * Credit notes.
 *
 * An invoice raised in error is VOIDED, and only while it is unpaid — that is
 * `voidInvoice`. Once the money has arrived the invoice is a record of a real
 * movement, and making it disappear leaves our books and the customer's
 * disagreeing. The instrument for reducing a settled invoice is a credit note:
 * its own document, its own number series, referencing what it reduces.
 *
 * Two rules do the real work here:
 *
 *   - The notes against an invoice can never exceed it. A customer who has been
 *     credited twice for the same month is owed money nobody recorded owing.
 *   - GST is recomputed at the ORIGINAL invoice's rate and against its place of
 *     supply, not today's. A credit note that moves tax between heads because
 *     the customer relocated is a filing problem for them.
 */
import type { PoolClient } from 'pg'
import { controlDb, ControlPlaneError } from './index.ts'
import { GST_RATE } from './billing.ts'
import { financialYear } from './financial-year.ts'

export interface CreditNote {
  id: string
  tenant_id: string
  invoice_id: string
  number: string
  reason: string
  subtotal_paise: string
  gst_rate: string
  gst_paise: string
  total_paise: string
  issued_on: string
}

const COLS = `id, tenant_id, invoice_id, number, reason, subtotal_paise::text,
              gst_rate::text, gst_paise::text, total_paise::text, issued_on::text`

/** `CRN/26-27/00001`. Same rule and the same reasoning as the invoice series. */
async function nextCreditNoteNumber(client: PoolClient, _tenantId: string, issuedOn: string): Promise<string> {
  const fy = financialYear(issuedOn)
  const { rows } = await client.query<{ next: number }>(
    `INSERT INTO control_plane.document_series (kind, fy, next) VALUES ('credit_note', $1, 2)
     ON CONFLICT (kind, fy) DO UPDATE SET next = control_plane.document_series.next + 1
     RETURNING next - 1 AS next`, [fy])
  return `CRN/${fy}/${String(rows[0]!.next).padStart(5, '0')}`
}

/** What has already been credited against an invoice, in paise. */
export async function creditedAgainst(invoiceId: string): Promise<bigint> {
  const { rows } = await controlDb.query<{ total: string }>(
    `SELECT coalesce(sum(total_paise), 0)::text AS total
       FROM control_plane.credit_notes WHERE invoice_id = $1`, [invoiceId])
  return BigInt(rows[0]!.total)
}

/**
 * Credit part or all of a paid invoice.
 *
 * `subtotalPaise` is the taxable value being reversed; GST is added at the
 * invoice's own rate, so the caller never has to restate the tax and cannot
 * get it wrong. Omit it to credit the whole invoice.
 */
export async function issueCreditNote(args: {
  invoiceId: string
  reason: string
  subtotalPaise?: number | bigint
}): Promise<CreditNote> {
  if (!args.reason?.trim()) {
    throw new ControlPlaneError('VALIDATION_FAILED', 'a credit note must say why it was issued')
  }

  const client = await controlDb.connect()
  try {
    await client.query('BEGIN')

    // Locked, because two concurrent credit notes could each pass the
    // "does not exceed the invoice" check and jointly break it.
    const { rows: inv } = await client.query<{
      id: string; tenant_id: string; status: string; subtotal_paise: string
      gst_rate: string; total_paise: string
    }>(
      `SELECT id, tenant_id, status, subtotal_paise::text, gst_rate::text, total_paise::text
         FROM control_plane.invoices WHERE id = $1 FOR UPDATE`, [args.invoiceId])
    const invoice = inv[0]
    if (!invoice) throw new ControlPlaneError('INVOICE_NOT_FOUND', 'no such invoice')
    if (invoice.status !== 'paid') {
      throw new ControlPlaneError(
        'INVOICE_NOT_PAID',
        `this invoice is ${invoice.status}; an unpaid invoice is voided, not credited`)
    }

    const invoiceSubtotal = BigInt(invoice.subtotal_paise)
    const subtotal = args.subtotalPaise === undefined
      ? invoiceSubtotal
      : BigInt(args.subtotalPaise)
    if (subtotal <= 0n) {
      throw new ControlPlaneError('VALIDATION_FAILED', 'a credit note must be for a positive amount')
    }

    // The invoice's own rate, not today's: the customer claimed input credit at
    // the rate that was charged and the reversal has to match it.
    //
    // `Number(x) || GST_RATE` did the OPPOSITE of that comment for a 0% invoice,
    // because 0 is falsy -- so an invoice raised before this supplier was
    // GST-registered would be credited at 18%. A full credit then exceeded the
    // invoice and was refused outright; a partial one reversed tax the customer
    // never paid. Only a missing or unparseable rate falls back.
    const recorded = Number(invoice.gst_rate)
    const rate = Number.isFinite(recorded) ? recorded : GST_RATE
    const gst = (subtotal * BigInt(Math.round(rate * 10_000))) / 10_000n
    const total = subtotal + gst

    const already = await client.query<{ total: string }>(
      `SELECT coalesce(sum(total_paise), 0)::text AS total
         FROM control_plane.credit_notes WHERE invoice_id = $1`, [args.invoiceId])
    const credited = BigInt(already.rows[0]!.total)
    if (credited + total > BigInt(invoice.total_paise)) {
      throw new ControlPlaneError(
        'CREDIT_EXCEEDS_INVOICE',
        `this invoice is ${invoice.total_paise} paise and ${credited} is already credited; ` +
        `${total} more would over-credit it`)
    }

    const issuedOn = (await client.query<{ d: string }>('SELECT CURRENT_DATE::text AS d')).rows[0]!.d
    const number = await nextCreditNoteNumber(client, invoice.tenant_id, issuedOn)

    const { rows } = await client.query<CreditNote>(
      `INSERT INTO control_plane.credit_notes
         (tenant_id, invoice_id, number, reason, subtotal_paise, gst_rate, gst_paise, total_paise, issued_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::date)
       RETURNING ${COLS}`,
      [invoice.tenant_id, invoice.id, number, args.reason.trim().slice(0, 500),
       subtotal.toString(), rate, gst.toString(), total.toString(), issuedOn])

    await client.query(
      `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('invoice.credited', $1, $2::jsonb)`,
      [invoice.tenant_id, JSON.stringify({ creditNote: number, invoiceId: invoice.id, totalPaise: total.toString(), reason: args.reason })])

    await client.query('COMMIT')
    return rows[0]!
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function listCreditNotes(tenantId: string): Promise<CreditNote[]> {
  const { rows } = await controlDb.query<CreditNote>(
    `SELECT ${COLS} FROM control_plane.credit_notes
      WHERE tenant_id = $1 ORDER BY issued_on DESC, created_at DESC`, [tenantId])
  return rows
}
