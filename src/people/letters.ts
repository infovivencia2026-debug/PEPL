/**
 * Letters and probation.
 *
 * A template is a heading plus paragraphs with {{merge.fields}}. Issuing one
 * resolves the fields from the record (never typed twice), renders a PDF with
 * the company header, files it under the person's documents, and records the
 * issue with a reference number HR can quote. Defaults are seeded per tenant
 * on first use and are then the company's to edit.
 */
import type { PoolClient } from 'pg'
import { PdfPage, renderPdf, measure } from '../pdf/document.ts'
import { putDocument, type DocumentMeta } from '../documents/index.ts'
import { currentPosting } from './profile.ts'
import { notify } from '../comms/index.ts'

export class LetterError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'LetterError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface LetterTemplate { id: string; code: string; name: string; title: string; body: string; category: string; confidential: boolean; status: string; updated_at: string }
const T_COLS = `id, code, name, title, body, category, confidential, status, updated_at::text`

export const DEFAULT_TEMPLATES: Array<Omit<LetterTemplate, 'id' | 'status' | 'updated_at'>> = [
  { code: 'appointment', name: 'Appointment letter', title: 'LETTER OF APPOINTMENT', category: 'appointment', confidential: true,
    body: `Dear {{employee.first_name}},

We are pleased to appoint you as {{employee.designation}} in the {{employee.department}} department of {{company.name}}, with effect from {{employee.joining_date}}.

Your annual cost to company will be {{ctc.annual}} ({{ctc.annual_words}}), structured as set out in the attached compensation statement. You will be on probation for a period ending {{employee.probation_end}}, during which either party may end this engagement with {{employee.notice_days}} days' notice.

You will be governed by the policies of the company as amended from time to time. Please sign and return a copy of this letter as your acceptance.

We look forward to a long and rewarding association.` },
  { code: 'confirmation', name: 'Confirmation letter', title: 'CONFIRMATION OF EMPLOYMENT', category: 'appointment', confidential: true,
    body: `Dear {{employee.first_name}},

We are pleased to confirm your employment with {{company.name}} as {{employee.designation}}, with effect from {{custom.confirmed_on}}, on successful completion of your probation.

All other terms of your appointment remain unchanged. We thank you for your contribution and look forward to your continued association.` },
  { code: 'increment', name: 'Increment letter', title: 'REVISION OF COMPENSATION', category: 'salary_revision', confidential: true,
    body: `Dear {{employee.first_name}},

In recognition of your performance and contribution, we are pleased to revise your annual cost to company to {{ctc.annual}} ({{ctc.annual_words}}) with effect from {{custom.effective_from}}.

The revised structure is set out in the attached compensation statement. All other terms of your employment remain unchanged.` },
  { code: 'experience', name: 'Experience letter', title: 'TO WHOMSOEVER IT MAY CONCERN', category: 'experience', confidential: false,
    body: `This is to certify that {{employee.name}} (Employee No. {{employee.number}}) was employed with {{company.name}} from {{employee.joining_date}} to {{custom.last_day}}, last holding the position of {{employee.designation}} in the {{employee.department}} department.

During this period we found {{employee.first_name}} to be sincere, hardworking and professional. We wish {{employee.first_name}} success in all future endeavours.` },
  { code: 'address_proof', name: 'Address proof letter', title: 'TO WHOMSOEVER IT MAY CONCERN', category: 'address', confidential: false,
    body: `This is to certify that {{employee.name}} (Employee No. {{employee.number}}) is employed with {{company.name}} as {{employee.designation}} since {{employee.joining_date}}.

As per our records, {{employee.first_name}}'s current residential address is:
{{employee.address}}

This letter is issued at the employee's request for the purpose of {{custom.purpose}}.` },
  { code: 'salary_certificate', name: 'Salary certificate', title: 'SALARY CERTIFICATE', category: 'salary_revision', confidential: true,
    body: `This is to certify that {{employee.name}} (Employee No. {{employee.number}}) is employed with {{company.name}} as {{employee.designation}} since {{employee.joining_date}}.

The current annual cost to company is {{ctc.annual}} ({{ctc.annual_words}}), which is {{ctc.monthly}} per month.

This certificate is issued at the employee's request for the purpose of {{custom.purpose}} and does not constitute a guarantee of continued employment.` },
  { code: 'warning', name: 'Warning letter', title: 'WARNING LETTER', category: 'disciplinary', confidential: true,
    body: `Dear {{employee.first_name}},

This letter is to formally record that {{custom.incident}}.

This conduct falls short of the standards expected under the company's policies. You are advised to correct it with immediate effect. Any recurrence may lead to further disciplinary action, up to and including termination of employment.

Please acknowledge receipt of this letter.` },
]

export async function listTemplates(tx: PoolClient, includeRetired = false): Promise<LetterTemplate[]> {
  const tid = await tenantId(tx)
  const have = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM letter_templates`)
  if (have.rows[0]!.n === '0') {
    for (const t of DEFAULT_TEMPLATES) {
      await tx.query(`INSERT INTO letter_templates (tenant_id, code, name, title, body, category, confidential) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tenant_id, code) DO NOTHING`,
        [tid, t.code, t.name, t.title, t.body, t.category, t.confidential])
    }
  }
  return (await tx.query<LetterTemplate>(`SELECT ${T_COLS} FROM letter_templates WHERE $1 OR status = 'active' ORDER BY name`, [includeRetired])).rows
}

export async function upsertTemplate(tx: PoolClient, args: { code: string; name: string; title: string; body: string; category?: string; confidential?: boolean }): Promise<LetterTemplate> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 40)
  if (!code || !args.name?.trim() || !args.title?.trim() || !args.body?.trim()) throw new LetterError('VALIDATION_FAILED', 'code, name, title and body are required')
  const unknown = [...args.body.matchAll(/{{\s*([a-z_.]+)\s*}}/g)].map((m) => m[1]!).filter((f) => !FIELDS.has(f) && !f.startsWith('custom.'))
  if (unknown.length) throw new LetterError('VALIDATION_FAILED', `unknown merge field(s): ${unknown.join(', ')} — use custom.* for anything the record does not hold`)
  const { rows } = await tx.query<LetterTemplate>(
    `INSERT INTO letter_templates (tenant_id, code, name, title, body, category, confidential) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, title = EXCLUDED.title, body = EXCLUDED.body, category = EXCLUDED.category, confidential = EXCLUDED.confidential, status = 'active', updated_at = now()
     RETURNING ${T_COLS}`, [tid, code, args.name.trim(), args.title.trim(), args.body.trim(), args.category ?? 'other', args.confidential ?? true])
  return rows[0]!
}

export async function retireTemplate(tx: PoolClient, code: string): Promise<void> {
  const r = await tx.query(`UPDATE letter_templates SET status = 'retired', updated_at = now() WHERE code = $1 AND status = 'active'`, [code])
  if (!r.rowCount) throw new LetterError('NOT_FOUND', 'no such active template')
}

// ── merge fields ─────────────────────────────────────────────────────────────

export const FIELDS: ReadonlySet<string> = new Set([
  'employee.name', 'employee.first_name', 'employee.number', 'employee.designation', 'employee.department', 'employee.location',
  'employee.joining_date', 'employee.probation_end', 'employee.notice_days', 'employee.address', 'employee.email',
  'ctc.annual', 'ctc.annual_words', 'ctc.monthly', 'company.name', 'company.legal_name', 'today', 'reference_no',
])
const fmtDate = (d: string | null | undefined): string => d ? new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '—'
const inr = (paise: bigint): string => '₹' + (Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })

/** Indian-system number words for rupees: 12,50,000 → "Rupees Twelve Lakh Fifty Thousand only". */
export function rupeesInWords(paise: bigint): string {
  let n = Math.round(Number(paise) / 100)
  if (n === 0) return 'Rupees Zero only'
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (x: number): string => x < 20 ? ones[x]! : `${tens[Math.floor(x / 10)]}${x % 10 ? ' ' + ones[x % 10] : ''}`
  const three = (x: number): string => `${x >= 100 ? ones[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : ''}${x % 100 ? two(x % 100) : ''}`
  const parts: string[] = []
  const crore = Math.floor(n / 1e7); n %= 1e7
  const lakh = Math.floor(n / 1e5); n %= 1e5
  const thousand = Math.floor(n / 1e3); n %= 1e3
  if (crore) parts.push(`${two(crore)} Crore`)
  if (lakh) parts.push(`${two(lakh)} Lakh`)
  if (thousand) parts.push(`${two(thousand)} Thousand`)
  if (n) parts.push(three(n))
  return `Rupees ${parts.join(' ')} only`
}

export async function mergeValues(tx: PoolClient, employeeId: string, custom: Record<string, string> = {}): Promise<Record<string, string>> {
  const e = (await tx.query<{ first_name: string; last_name: string | null; employee_number: string; date_of_joining: string; probation_end: string | null; notice_period_days: number; address: Record<string, string>; work_email: string | null }>(
    `SELECT first_name, last_name, employee_number, date_of_joining::text, probation_end::text, notice_period_days, address, work_email FROM employees WHERE id = $1`, [employeeId])).rows[0]
  if (!e) throw new LetterError('NOT_FOUND', 'no such employee')
  const posting = await currentPosting(tx, employeeId)
  const comp = (await tx.query<{ annual_ctc_paise: string }>(`SELECT annual_ctc_paise::text FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL AND effective_from <= CURRENT_DATE ORDER BY effective_from DESC LIMIT 1`, [employeeId])).rows[0]
  const company = (await tx.query<{ legal_name: string; display_name: string }>(`SELECT legal_name, display_name FROM tenants`)).rows[0]
  const annual = comp ? BigInt(comp.annual_ctc_paise) : 0n
  const addr = e.address ?? {}
  const v: Record<string, string> = {
    'employee.name': [e.first_name, e.last_name].filter(Boolean).join(' '), 'employee.first_name': e.first_name, 'employee.number': e.employee_number,
    'employee.designation': posting?.designation ?? '—', 'employee.department': posting?.department ?? '—', 'employee.location': posting?.location_code ?? '—',
    'employee.joining_date': fmtDate(e.date_of_joining), 'employee.probation_end': fmtDate(e.probation_end), 'employee.notice_days': String(e.notice_period_days),
    'employee.address': [addr.line1, addr.line2, addr.city, addr.state, addr.pincode].filter(Boolean).join(', ') || '—', 'employee.email': e.work_email ?? '—',
    'ctc.annual': inr(annual), 'ctc.annual_words': rupeesInWords(annual), 'ctc.monthly': inr(annual / 12n),
    'company.name': company?.display_name ?? '', 'company.legal_name': company?.legal_name ?? '', today: fmtDate(new Date().toISOString().slice(0, 10)),
  }
  for (const [k, val] of Object.entries(custom)) v[`custom.${k}`] = String(val)
  return v
}

export function merge(text: string, values: Record<string, string>): { text: string; missing: string[] } {
  const missing: string[] = []
  const out = text.replace(/{{\s*([a-z_.]+)\s*}}/g, (_, f: string) => { if (values[f] === undefined) { missing.push(f); return `[${f}]` } return values[f]! })
  return { text: out, missing }
}

// ── issue ────────────────────────────────────────────────────────────────────

export interface IssuedLetter { id: string; employee_id: string; template_id: string; code: string; reference_no: string; document_id: string; merge_values: Record<string, string>; issued_by_user_id: string | null; issued_at: string }
const I_COLS = `id, employee_id, template_id, code, reference_no, document_id, merge_values, issued_by_user_id, issued_at::text`

function wrap(text: string, size: number, width: number): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    if (!para.trim()) { out.push(''); continue }
    let line = ''
    for (const word of para.split(/\s+/)) {
      const probe = line ? `${line} ${word}` : word
      if (measure(probe, size) > width && line) { out.push(line); line = word } else line = probe
    }
    out.push(line)
  }
  return out
}

export async function previewLetter(tx: PoolClient, args: { code: string; employeeId: string; custom?: Record<string, string> }): Promise<{ title: string; text: string; missing: string[]; category: string }> {
  const t = (await listTemplates(tx)).find((x) => x.code === args.code)
  if (!t) throw new LetterError('NOT_FOUND', 'no such letter template')
  const values = await mergeValues(tx, args.employeeId, args.custom)
  const m = merge(t.body, values)
  return { title: t.title, text: m.text, missing: m.missing, category: t.category }
}

export async function issueLetter(
  tx: PoolClient, args: { code: string; employeeId: string; custom?: Record<string, string>; actorUserId: string; signatory?: string; notifyEmployee?: boolean },
): Promise<{ letter: IssuedLetter; document: DocumentMeta }> {
  const tid = await tenantId(tx)
  const t = (await listTemplates(tx)).find((x) => x.code === args.code)
  if (!t) throw new LetterError('NOT_FOUND', 'no such letter template')
  // Check the merge BEFORE taking a reference number, so a refused issue leaves no gap in the sequence.
  const base = await mergeValues(tx, args.employeeId, args.custom)
  const missing = merge(t.body, base).missing.filter((f) => f !== 'reference_no')
  if (missing.length) throw new LetterError('MERGE_INCOMPLETE', `fill in: ${missing.join(', ')}`)
  const year = new Date().getFullYear()
  const { rows: c } = await tx.query<{ last_no: number }>(
    `INSERT INTO letter_counters (tenant_id, year, last_no) VALUES ($1, $2, 1) ON CONFLICT (tenant_id, year) DO UPDATE SET last_no = letter_counters.last_no + 1 RETURNING last_no`, [tid, year])
  const referenceNo = `${(await tx.query<{ d: string }>(`SELECT upper(left(regexp_replace(display_name, '[^A-Za-z]', '', 'g'), 4)) AS d FROM tenants`)).rows[0]?.d ?? 'PEPL'}/HR/${year}/${String(c[0]!.last_no).padStart(4, '0')}`
  const values: Record<string, string> = { ...base, reference_no: referenceNo }
  const m = merge(t.body, values)

  const page = new PdfPage()
  let y = 760
  page.text(values['company.name']!, 72, y, { font: 'bold', size: 16 }); y -= 18
  page.text(values['company.legal_name']!, 72, y, { size: 9, grey: 0.4 }); y -= 30
  page.text(`Ref: ${referenceNo}`, 72, y, { size: 10 }); page.text(`Date: ${values.today}`, 400, y, { size: 10 }); y -= 28
  page.text(t.title, 72, y, { font: 'bold', size: 12 }); y -= 28
  for (const line of wrap(m.text, 11, 450)) { if (y < 120) break; page.text(line, 72, y, { size: 11 }); y -= line ? 16 : 10 }
  y -= 24
  page.text(`For ${values['company.name']}`, 72, y, { font: 'bold' }); y -= 48
  page.text(args.signatory ?? 'Authorised Signatory', 72, y)
  page.text('This letter is system-generated and valid without a physical signature.', 72, 60, { size: 8, grey: 0.5 })
  const bytes = renderPdf(page, `${t.name} - ${values['employee.name']}`)

  const document = await putDocument(tx, {
    ownerType: 'employee', ownerId: args.employeeId, fileName: `${t.code}-${values['employee.number']}-${year}.pdf`, contentType: 'application/pdf',
    bytes, category: t.category, isConfidential: t.confidential, uploadedByUserId: args.actorUserId,
  })
  const { rows } = await tx.query<IssuedLetter>(
    `INSERT INTO issued_letters (tenant_id, employee_id, template_id, code, reference_no, document_id, merge_values, issued_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING ${I_COLS}`,
    [tid, args.employeeId, t.id, t.code, referenceNo, document.id, JSON.stringify(args.custom ?? {}), args.actorUserId])
  if (args.notifyEmployee !== false) {
    const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [args.employeeId])).rows[0]?.id
    if (u) await notify(tx, { userId: u, eventType: 'letter.issued', title: `${t.name} issued (${referenceNo})`, body: 'It is in your documents.', entityType: 'document', entityId: document.id, dedupeKey: `letter:${rows[0]!.id}`, attachmentDocumentIds: [document.id] })
  }
  return { letter: rows[0]!, document }
}

export async function listIssued(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; code?: string }): Promise<IssuedLetter[]> {
  return (await tx.query<IssuedLetter>(
    `SELECT ${I_COLS} FROM issued_letters WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR code = $3) ORDER BY issued_at DESC, reference_no DESC LIMIT 500`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.code ?? null])).rows
}

// ── probation ────────────────────────────────────────────────────────────────

export interface ProbationReview { id: string; employee_id: string; probation_end: string; reviewer_employee_id: string | null; status: string; rating: number | null; remarks: string | null; extended_to: string | null; decided_by_user_id: string | null; decided_at: string | null; letter_id: string | null; created_at: string }
const P_COLS = `id, employee_id, probation_end::text, reviewer_employee_id, status, rating, remarks, extended_to::text, decided_by_user_id, decided_at::text, letter_id, created_at::text`

/** Opens a review for everyone on probation whose end is within `daysAhead`; tells the manager and HR. Idempotent. */
export async function openDueProbationReviews(tx: PoolClient, daysAhead: number, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ id: string; probation_end: string; first_name: string }>(
    `SELECT e.id, e.probation_end::text, e.first_name FROM employees e
      WHERE e.status = 'active' AND e.employment_type = 'probation' AND e.probation_end IS NOT NULL AND e.probation_end <= ($1::date + $2::int)
        AND NOT EXISTS (SELECT 1 FROM probation_reviews r WHERE r.employee_id = e.id AND r.status = 'pending')
        AND NOT EXISTS (SELECT 1 FROM probation_reviews r WHERE r.employee_id = e.id AND r.probation_end = e.probation_end AND r.status <> 'pending')`, [today, daysAhead])
  for (const e of rows) {
    const posting = await currentPosting(tx, e.id)
    const { rows: ins } = await tx.query<{ id: string }>(`INSERT INTO probation_reviews (tenant_id, employee_id, probation_end, reviewer_employee_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [tid, e.id, e.probation_end, posting?.manager_employee_id ?? null])
    const tell = new Set<string>()
    if (posting?.manager_employee_id) { const m = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [posting.manager_employee_id])).rows[0]?.id; if (m) tell.add(m) }
    for (const h of (await tx.query<{ user_id: string }>(`SELECT user_id FROM user_roles WHERE role = 'hr_admin'`)).rows) tell.add(h.user_id)
    for (const u of tell) await notify(tx, { userId: u, eventType: 'probation.review.due', title: `${e.first_name}'s probation ends ${fmtDate(e.probation_end)} — review due`, entityType: 'probation_review', entityId: ins[0]!.id, dedupeKey: `probation:${ins[0]!.id}:${u}` })
  }
  return rows.length
}

export async function listProbationReviews(tx: PoolClient, args: { employeeIds?: string[] | null; status?: string; reviewerEmployeeId?: string }): Promise<ProbationReview[]> {
  return (await tx.query<ProbationReview>(
    `SELECT ${P_COLS} FROM probation_reviews WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::text IS NULL OR status = $2) AND ($3::uuid IS NULL OR reviewer_employee_id = $3) ORDER BY probation_end`,
    [args.employeeIds ?? null, args.status ?? null, args.reviewerEmployeeId ?? null])).rows
}

export async function decideProbation(
  tx: PoolClient,
  args: { reviewId: string; decision: 'confirm' | 'extend' | 'separate'; rating?: number; remarks?: string; extendedTo?: string; actorUserId: string; issueLetter?: boolean },
): Promise<ProbationReview> {
  const r = (await tx.query<ProbationReview>(`SELECT ${P_COLS} FROM probation_reviews WHERE id = $1 FOR UPDATE`, [args.reviewId])).rows[0]
  if (!r) throw new LetterError('NOT_FOUND', 'no such review')
  if (r.status !== 'pending') throw new LetterError('REVIEW_DECIDED', `already ${r.status}`)
  if (args.rating !== undefined && (!Number.isInteger(args.rating) || args.rating < 1 || args.rating > 5)) throw new LetterError('VALIDATION_FAILED', 'rating is 1–5')
  if (args.decision !== 'confirm' && !args.remarks?.trim()) throw new LetterError('VALIDATION_FAILED', 'extending or separating needs remarks')
  let letterId: string | null = null
  if (args.decision === 'confirm') {
    const confirmedOn = r.probation_end
    await tx.query(`UPDATE employees SET employment_type = 'permanent', confirmed_on = $2 WHERE id = $1`, [r.employee_id, confirmedOn])
    if (args.issueLetter !== false) {
      const issued = await issueLetter(tx, { code: 'confirmation', employeeId: r.employee_id, custom: { confirmed_on: fmtDate(confirmedOn) }, actorUserId: args.actorUserId })
      letterId = issued.letter.id
    }
  } else if (args.decision === 'extend') {
    if (!args.extendedTo || args.extendedTo <= r.probation_end) throw new LetterError('VALIDATION_FAILED', 'extend to a date after the current probation end')
    await tx.query(`UPDATE employees SET probation_end = $2 WHERE id = $1`, [r.employee_id, args.extendedTo])
  }
  const { rows } = await tx.query<ProbationReview>(
    `UPDATE probation_reviews SET status = $2, rating = $3, remarks = $4, extended_to = $5, decided_by_user_id = $6, decided_at = now(), letter_id = $7 WHERE id = $1 RETURNING ${P_COLS}`,
    [r.id, args.decision === 'confirm' ? 'confirmed' : args.decision === 'extend' ? 'extended' : 'separated', args.rating ?? null, args.remarks?.trim() || null, args.extendedTo ?? null, args.actorUserId, letterId])
  const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [r.employee_id])).rows[0]?.id
  if (u && args.decision !== 'separate') await notify(tx, { userId: u, eventType: 'probation.decided', title: args.decision === 'confirm' ? 'Your employment is confirmed' : `Your probation is extended to ${fmtDate(args.extendedTo)}`, entityType: 'probation_review', entityId: r.id, dedupeKey: `probation:decided:${r.id}` })
  return rows[0]!
}
