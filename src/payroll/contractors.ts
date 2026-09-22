/**
 * Contractor workforce: paid on invoice, outside the payroll run.
 *
 * A contractor is an employee row with `contractor_terms`. Their fees carry
 * TDS under 194C (works contract: 1% individual/HUF, 2% others), 194J
 * (professional fees: 10%; technical services 2%), or 194H (commission: 2%
 * from Oct 2024) — 20% with no PAN. Thresholds: 194C applies once a single
 * invoice exceeds ₹30,000 or the year's total exceeds ₹1,00,000; 194J and
 * 194H once the year's total exceeds their limits (₹50,000 / ₹20,000 from
 * FY 2025-26). TDS is on fees, never on GST. The register feeds Form 26Q.
 *
 * `statutoryBonus` is the Payment of Bonus Act arithmetic, exposed for the
 * annual bonus run.
 */
import type { PoolClient } from 'pg'

export class ContractorError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ContractorError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const fyStart = (d: string): string => { const y = Number(d.slice(0, 4)); return Number(d.slice(5, 7)) >= 4 ? `${y}-04-01` : `${y - 1}-04-01` }

export type TdsSection = '194C' | '194J' | '194H' | 'none'
export type EntityType = 'individual' | 'huf' | 'firm' | 'company'

/** Statutory rate for a section and payee; 20% when the payee has no PAN (s.206AA). */
export function tdsRate(section: TdsSection, entity: EntityType, hasPan: boolean, override?: number | null): number {
  if (section === 'none') return 0
  if (override !== null && override !== undefined) return override
  if (!hasPan) return 20
  switch (section) {
    case '194C': return entity === 'individual' || entity === 'huf' ? 1 : 2
    case '194J': return 10
    case '194H': return 2
  }
}
/** Whether the section's threshold is crossed for this payment given the FY's earlier fees. */
export function tdsApplies(section: TdsSection, amountPaise: number, fyToDatePaise: number): boolean {
  if (section === 'none') return false
  if (section === '194C') return amountPaise > 30_000 * 100 || fyToDatePaise + amountPaise > 100_000 * 100
  if (section === '194J') return fyToDatePaise + amountPaise > 50_000 * 100
  return fyToDatePaise + amountPaise > 20_000 * 100
}

export interface Terms { employee_id: string; employee_name: string; employee_number: string; pan: string | null; gstin: string | null; entity_type: EntityType; tds_section: TdsSection; tds_rate_pct: string | null; rate_type: string; rate_paise: string; invoice_required: boolean; contract_start: string | null; contract_end: string | null; notes: string | null }
const T_COLS = `t.employee_id, concat_ws(' ', e.first_name, e.last_name) AS employee_name, e.employee_number, t.pan, t.gstin, t.entity_type, t.tds_section, t.tds_rate_pct::text, t.rate_type, t.rate_paise::text, t.invoice_required, t.contract_start::text, t.contract_end::text, t.notes`
const T_FROM = `FROM contractor_terms t JOIN employees e ON (e.tenant_id, e.id) = (t.tenant_id, t.employee_id)`

export async function setTerms(tx: PoolClient, args: { employeeId: string; pan?: string | null; gstin?: string | null; entityType?: EntityType; tdsSection?: TdsSection; tdsRatePct?: number | null; rateType?: Terms['rate_type']; ratePaise?: number; invoiceRequired?: boolean; contractStart?: string | null; contractEnd?: string | null; notes?: string | null }): Promise<Terms> {
  const tid = await tenantId(tx)
  const pan = args.pan?.trim().toUpperCase() || null
  if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new ContractorError('VALIDATION_FAILED', 'PAN is 5 letters, 4 digits, 1 letter')
  const gstin = args.gstin?.trim().toUpperCase() || null
  if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) throw new ContractorError('VALIDATION_FAILED', 'GSTIN is 15 characters')
  if (args.tdsRatePct != null && (args.tdsRatePct < 0 || args.tdsRatePct > 30)) throw new ContractorError('VALIDATION_FAILED', 'tdsRatePct is 0–30')
  // the PAN's fourth character says what the payee is: P person, H HUF, F firm, C company
  const entity: EntityType = args.entityType ?? (pan ? ({ P: 'individual', H: 'huf', F: 'firm', C: 'company' } as Record<string, EntityType>)[pan[3]!] ?? 'individual' : 'individual')
  const emp = (await tx.query<{ status: string }>(`SELECT status FROM employees WHERE id = $1`, [args.employeeId])).rows[0]
  if (!emp) throw new ContractorError('NOT_FOUND', 'no such person')
  await tx.query(
    `INSERT INTO contractor_terms (tenant_id, employee_id, pan, gstin, entity_type, tds_section, tds_rate_pct, rate_type, rate_paise, invoice_required, contract_start, contract_end, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, employee_id) DO UPDATE SET pan = EXCLUDED.pan, gstin = EXCLUDED.gstin, entity_type = EXCLUDED.entity_type, tds_section = EXCLUDED.tds_section, tds_rate_pct = EXCLUDED.tds_rate_pct, rate_type = EXCLUDED.rate_type, rate_paise = EXCLUDED.rate_paise, invoice_required = EXCLUDED.invoice_required, contract_start = EXCLUDED.contract_start, contract_end = EXCLUDED.contract_end, notes = EXCLUDED.notes, updated_at = now()`,
    [tid, args.employeeId, pan, gstin, entity, args.tdsSection ?? '194J', args.tdsRatePct ?? null, args.rateType ?? 'monthly', String(args.ratePaise ?? 0), args.invoiceRequired ?? true, args.contractStart ?? null, args.contractEnd ?? null, args.notes ?? null])
  // a contractor is never on the payroll; mark the employment type so lists say so
  await tx.query(`UPDATE employees SET employment_type = 'consultant' WHERE id = $1 AND employment_type NOT IN ('contract','consultant')`, [args.employeeId])
  return (await getTerms(tx, args.employeeId))!
}
export async function getTerms(tx: PoolClient, employeeId: string): Promise<Terms | null> {
  return (await tx.query<Terms>(`SELECT ${T_COLS} ${T_FROM} WHERE t.employee_id = $1`, [employeeId])).rows[0] ?? null
}
export async function listContractors(tx: PoolClient, employeeIds?: string[] | null): Promise<Terms[]> {
  return (await tx.query<Terms>(`SELECT ${T_COLS} ${T_FROM} WHERE e.status <> 'exited' AND ($1::uuid[] IS NULL OR t.employee_id = ANY($1)) ORDER BY e.first_name`, [employeeIds ?? null])).rows
}
export async function isContractor(tx: PoolClient, employeeId: string): Promise<boolean> {
  return Boolean((await tx.query(`SELECT 1 FROM contractor_terms WHERE employee_id = $1`, [employeeId])).rowCount)
}
export async function removeTerms(tx: PoolClient, employeeId: string): Promise<void> {
  if ((await tx.query(`SELECT 1 FROM contractor_invoices WHERE employee_id = $1 AND status IN ('submitted','approved')`, [employeeId])).rowCount) throw new ContractorError('INVOICES_OPEN', 'settle or reject the open invoices first')
  await tx.query(`DELETE FROM contractor_terms WHERE employee_id = $1`, [employeeId])
}

export interface Invoice { id: string; employee_id: string; employee_name: string; invoice_no: string; invoice_date: string; period_start: string; period_end: string; description: string | null; units: string | null; amount_paise: string; gst_paise: string; tds_section: string; tds_rate_pct: string; tds_paise: string; net_paise: string; status: string; document_id: string | null; approved_at: string | null; paid_at: string | null; payment_ref: string | null; rejection_reason: string | null; created_at: string }
const I_COLS = `i.id, i.employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = i.employee_id) AS employee_name, i.invoice_no, i.invoice_date::text, i.period_start::text, i.period_end::text, i.description, i.units::text, i.amount_paise::text, i.gst_paise::text, i.tds_section, i.tds_rate_pct::text, i.tds_paise::text, i.net_paise::text, i.status, i.document_id, i.approved_at::text, i.paid_at::text, i.payment_ref, i.rejection_reason, i.created_at::text`

/** Fees paid or approved so far this fiscal year (for the threshold), excluding a given invoice. */
async function fyToDate(tx: PoolClient, employeeId: string, invoiceDate: string): Promise<number> {
  const r = (await tx.query<{ s: string }>(`SELECT coalesce(sum(amount_paise), 0)::text AS s FROM contractor_invoices WHERE employee_id = $1 AND status IN ('approved','paid') AND invoice_date >= $2::date AND invoice_date <= $3::date`, [employeeId, fyStart(invoiceDate), invoiceDate])).rows[0]!
  return Number(r.s)
}
export function computeInvoice(terms: Pick<Terms, 'tds_section' | 'entity_type' | 'pan' | 'tds_rate_pct'>, amountPaise: number, gstPaise: number, fyToDatePaise: number): { ratePct: number; tdsPaise: number; netPaise: number; section: string } {
  const section = terms.tds_section as TdsSection
  const applies = tdsApplies(section, amountPaise, fyToDatePaise)
  const ratePct = applies ? tdsRate(section, terms.entity_type, Boolean(terms.pan), terms.tds_rate_pct === null ? null : Number(terms.tds_rate_pct)) : 0
  const tdsPaise = Math.round(amountPaise * ratePct / 100 / 100) * 100   // to the rupee
  return { ratePct, tdsPaise, netPaise: amountPaise + gstPaise - tdsPaise, section }
}
export async function submitInvoice(tx: PoolClient, args: { employeeId: string; invoiceNo: string; invoiceDate: string; periodStart: string; periodEnd: string; description?: string | null; units?: number | null; amountPaise?: number; gstPaise?: number; documentId?: string | null; submittedByUserId: string }): Promise<Invoice> {
  const tid = await tenantId(tx)
  const terms = await getTerms(tx, args.employeeId)
  if (!terms) throw new ContractorError('NOT_CONTRACTOR', 'this person has no contractor terms')
  const invoiceNo = args.invoiceNo?.trim()
  if (!invoiceNo) throw new ContractorError('VALIDATION_FAILED', 'invoice number is required')
  if ((await tx.query(`SELECT 1 FROM contractor_invoices WHERE employee_id = $1 AND invoice_no = $2`, [args.employeeId, invoiceNo])).rowCount) throw new ContractorError('DUPLICATE_INVOICE', `invoice ${invoiceNo} already exists for this contractor`)
  // amount from units × rate when the terms are per unit and the caller gave units
  let amount = args.amountPaise ?? null
  if (amount === null && args.units != null && ['daily', 'hourly', 'per_unit'].includes(terms.rate_type)) amount = Math.round(args.units * Number(terms.rate_paise))
  if (amount === null && terms.rate_type === 'monthly') amount = Number(terms.rate_paise)
  if (!amount || amount <= 0) throw new ContractorError('VALIDATION_FAILED', 'give the fee amount (or units, for a per-unit contract)')
  const gst = args.gstPaise ?? 0
  if (gst > 0 && !terms.gstin) throw new ContractorError('VALIDATION_FAILED', 'GST charged by a contractor with no GSTIN on file')
  if (gst < 0) throw new ContractorError('VALIDATION_FAILED', 'gstPaise is not negative')
  const c = computeInvoice(terms, amount, gst, await fyToDate(tx, args.employeeId, args.invoiceDate))
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO contractor_invoices (tenant_id, employee_id, invoice_no, invoice_date, period_start, period_end, description, units, amount_paise, gst_paise, tds_section, tds_rate_pct, tds_paise, net_paise, document_id, submitted_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
    [tid, args.employeeId, invoiceNo, args.invoiceDate, args.periodStart, args.periodEnd, args.description ?? null, args.units ?? null, String(amount), String(gst), c.section, c.ratePct, String(c.tdsPaise), String(c.netPaise), args.documentId ?? null, args.submittedByUserId])
  return (await getInvoice(tx, rows[0]!.id))!
}
export async function getInvoice(tx: PoolClient, id: string): Promise<Invoice | null> {
  return (await tx.query<Invoice>(`SELECT ${I_COLS} FROM contractor_invoices i WHERE i.id = $1`, [id])).rows[0] ?? null
}
export async function listInvoices(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string; from?: string; to?: string }): Promise<Invoice[]> {
  return (await tx.query<Invoice>(`SELECT ${I_COLS} FROM contractor_invoices i WHERE ($1::uuid[] IS NULL OR i.employee_id = ANY($1)) AND ($2::uuid IS NULL OR i.employee_id = $2) AND ($3::text IS NULL OR i.status = $3) AND ($4::date IS NULL OR i.invoice_date >= $4) AND ($5::date IS NULL OR i.invoice_date <= $5) ORDER BY i.invoice_date DESC, i.created_at DESC LIMIT 1000`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null, args.from ?? null, args.to ?? null])).rows
}
/** Approval recomputes TDS: the FY-to-date total may have crossed a threshold since submission. */
export async function decideInvoice(tx: PoolClient, args: { id: string; status: 'approved' | 'rejected'; reason?: string | null; actorUserId: string }): Promise<Invoice> {
  const inv = await getInvoice(tx, args.id)
  if (!inv) throw new ContractorError('NOT_FOUND', 'no such invoice')
  if (inv.status !== 'submitted') throw new ContractorError('INVOICE_STATE', `invoice is ${inv.status}`)
  if (args.status === 'rejected') {
    if (!args.reason?.trim()) throw new ContractorError('VALIDATION_FAILED', 'say why it is rejected')
    await tx.query(`UPDATE contractor_invoices SET status = 'rejected', rejection_reason = $2, approved_by_user_id = $3, approved_at = now() WHERE id = $1`, [inv.id, args.reason.trim(), args.actorUserId])
    return (await getInvoice(tx, inv.id))!
  }
  const terms = (await getTerms(tx, inv.employee_id))!
  const c = computeInvoice(terms, Number(inv.amount_paise), Number(inv.gst_paise), await fyToDate(tx, inv.employee_id, inv.invoice_date))
  await tx.query(`UPDATE contractor_invoices SET status = 'approved', tds_rate_pct = $2, tds_paise = $3, net_paise = $4, approved_by_user_id = $5, approved_at = now() WHERE id = $1`, [inv.id, c.ratePct, String(c.tdsPaise), String(c.netPaise), args.actorUserId])
  return (await getInvoice(tx, inv.id))!
}
export async function markInvoicePaid(tx: PoolClient, args: { id: string; paymentRef: string; paidOn?: string }): Promise<Invoice> {
  if (!args.paymentRef?.trim()) throw new ContractorError('VALIDATION_FAILED', 'payment reference is required')
  const r = await tx.query(`UPDATE contractor_invoices SET status = 'paid', payment_ref = $2, paid_at = coalesce($3::timestamptz, now()) WHERE id = $1 AND status = 'approved'`, [args.id, args.paymentRef.trim(), args.paidOn ?? null])
  if (!r.rowCount) throw new ContractorError('INVOICE_STATE', 'only an approved invoice is paid')
  return (await getInvoice(tx, args.id))!
}
/** Form 26Q feed: TDS deducted on contractor payments in a quarter, by deductee and section. */
export async function tdsRegister26Q(tx: PoolClient, args: { from: string; to: string }): Promise<{ rows: Array<{ employee_name: string; pan: string | null; section: string; invoices: number; amount_paise: number; tds_paise: number }>; totals: { amount_paise: number; tds_paise: number }; missingPan: string[] }> {
  const { rows } = await tx.query<{ employee_name: string; pan: string | null; section: string; invoices: string; amount_paise: string; tds_paise: string }>(
    `SELECT concat_ws(' ', e.first_name, e.last_name) AS employee_name, t.pan, i.tds_section AS section, count(*)::text AS invoices, sum(i.amount_paise)::text AS amount_paise, sum(i.tds_paise)::text AS tds_paise
       FROM contractor_invoices i JOIN employees e ON (e.tenant_id, e.id) = (i.tenant_id, i.employee_id) LEFT JOIN contractor_terms t ON (t.tenant_id, t.employee_id) = (i.tenant_id, i.employee_id)
      WHERE i.status IN ('approved','paid') AND i.invoice_date BETWEEN $1::date AND $2::date AND i.tds_paise > 0
      GROUP BY e.first_name, e.last_name, t.pan, i.tds_section ORDER BY 1`, [args.from, args.to])
  const out = rows.map((r) => ({ employee_name: r.employee_name, pan: r.pan, section: r.section, invoices: Number(r.invoices), amount_paise: Number(r.amount_paise), tds_paise: Number(r.tds_paise) }))
  return { rows: out, totals: { amount_paise: out.reduce((s, r) => s + r.amount_paise, 0), tds_paise: out.reduce((s, r) => s + r.tds_paise, 0) }, missingPan: out.filter((r) => !r.pan).map((r) => r.employee_name) }
}

// ── Payment of Bonus Act ─────────────────────────────────────────────────────

/**
 * Statutory bonus for one employee for an accounting year. Eligible when the
 * monthly salary/wage (basic + DA) is ≤ ₹21,000 and at least 30 working days
 * were worked. The bonus is computed on min(wage, ₹7,000 or the scheduled
 * minimum wage, whichever is higher) at the company's rate (8.33%–20%),
 * pro-rated by months worked.
 */
export function statutoryBonus(args: { monthlyWagePaise: number; monthsWorked: number; daysWorked: number; ratePct: number; minimumWagePaise?: number }): { eligible: boolean; bonusPaise: number; basisPaise: number; reason?: string } {
  if (args.monthlyWagePaise > 21_000 * 100) return { eligible: false, bonusPaise: 0, basisPaise: 0, reason: 'wage above ₹21,000' }
  if (args.daysWorked < 30) return { eligible: false, bonusPaise: 0, basisPaise: 0, reason: 'fewer than 30 working days' }
  const rate = Math.min(20, Math.max(8.33, args.ratePct))
  const ceiling = Math.max(7_000 * 100, args.minimumWagePaise ?? 0)
  const basis = Math.min(args.monthlyWagePaise, ceiling)
  const bonus = Math.round(basis * Math.min(12, Math.max(0, args.monthsWorked)) * rate / 100 / 100) * 100
  return { eligible: true, bonusPaise: bonus, basisPaise: basis }
}
