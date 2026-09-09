/**
 * The payslip PDF.
 *
 * Everything on the page comes from the LOCKED run: the payslip is evidence,
 * and evidence that recalculates when a policy changes is worthless. Nothing
 * here reads live compensation, attendance or configuration.
 */
import type { PoolClient } from 'pg'
import { PdfPage, renderPdf, PAGE_HEIGHT, PAGE_WIDTH } from '../pdf/document.ts'

export class PayslipError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PayslipError'
  }
}

interface SlipRow {
  id: string
  employee_id: string
  gross_paise: string
  deductions_paise: string
  net_paise: string
  period_label: string
  period_start: string
  period_end: string
  pay_date: string
  run_status: string
  revision: number
  employee_code: string | null
  first_name: string
  last_name: string | null
  designation: string | null
  department: string | null
  date_of_joining: string | null
  company_name: string
}

interface LineRow {
  component_code: string
  component_type: string
  amount_paise: string
}

const MARGIN = 48
const RIGHT = PAGE_WIDTH - MARGIN

/** Paise to a rupee string with Indian digit grouping: 12,34,567.00 */
export function rupees(paise: bigint | string | number): string {
  const value = typeof paise === 'bigint' ? paise : BigInt(paise)
  const negative = value < 0n
  const abs = negative ? -value : value
  const whole = (abs / 100n).toString()
  const fraction = (abs % 100n).toString().padStart(2, '0')

  // Indian grouping: last three digits, then pairs.
  const last3 = whole.slice(-3)
  const rest = whole.slice(0, -3)
  const grouped = rest
    ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last3
    : last3
  return `${negative ? '-' : ''}${grouped}.${fraction}`
}

/** Words on a cheque: what an auditor checks the figures against. */
export function amountInWords(paise: bigint): string {
  const ones = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
    'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
    'eighteen', 'nineteen']
  const tens = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety']

  const under100 = (n: number): string =>
    n < 20 ? ones[n]! : tens[Math.floor(n / 10)]! + (n % 10 ? '-' + ones[n % 10]! : '')
  const under1000 = (n: number): string =>
    n < 100 ? under100(n)
      : ones[Math.floor(n / 100)]! + ' hundred' + (n % 100 ? ' and ' + under100(n % 100) : '')

  let rupeeValue = Number(paise / 100n)
  if (rupeeValue === 0) return 'Zero rupees only'

  const parts: string[] = []
  const scales: [number, string][] = [[10_000_000, 'crore'], [100_000, 'lakh'], [1000, 'thousand']]
  for (const [size, name] of scales) {
    const count = Math.floor(rupeeValue / size)
    if (count) {
      parts.push(`${under1000(count)} ${name}`)
      rupeeValue -= count * size
    }
  }
  if (rupeeValue) parts.push(under1000(rupeeValue))

  const words = parts.join(' ')
  return words.charAt(0).toUpperCase() + words.slice(1) + ' rupees only'
}

function dateLabel(value: string | null): string {
  if (!value) return '—'
  const d = new Date(value)
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })
}

/** Loads a payslip and everything printed on it. Locked runs only. */
export async function loadPayslip(
  tx: PoolClient,
  payslipId: string,
): Promise<{ slip: SlipRow; lines: LineRow[] }> {
  const { rows } = await tx.query<SlipRow>(
    `SELECT p.id, p.employee_id,
            p.gross_paise::text, p.deductions_paise::text, p.net_paise::text,
            pp.label AS period_label, pp.period_start::text, pp.period_end::text,
            pp.pay_date::text, r.status::text AS run_status, r.revision,
            e.employee_number AS employee_code, e.first_name, e.last_name,
            a.designation, a.department, e.date_of_joining::text,
            t.display_name AS company_name
       FROM payslips p
       JOIN payroll_runs r     ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
       JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
       JOIN employees e        ON (e.tenant_id, e.id) = (p.tenant_id, p.employee_id)
       JOIN tenants t          ON t.id = p.tenant_id
       LEFT JOIN LATERAL (
         SELECT designation, department FROM employee_assignments ea
          WHERE (ea.tenant_id, ea.employee_id) = (e.tenant_id, e.id)
            AND ea.superseded_at IS NULL
          ORDER BY ea.effective_from DESC LIMIT 1
       ) a ON true
      WHERE p.id = $1`,
    [payslipId],
  )
  const slip = rows[0]
  if (!slip) throw new PayslipError('NOT_FOUND', 'no such payslip')
  if (slip.run_status !== 'locked') {
    throw new PayslipError('NOT_LOCKED', 'a payslip is only issued from a locked payroll run')
  }

  const { rows: lines } = await tx.query<LineRow>(
    `SELECT l.component_code, l.component_type, l.amount_paise::text
       FROM payroll_lines l
       JOIN payslips p ON (p.tenant_id, p.run_id) = (l.tenant_id, l.run_id)
                      AND p.employee_id = l.employee_id
      WHERE p.id = $1
      ORDER BY l.component_type, l.component_code`,
    [payslipId],
  )
  return { slip, lines }
}

const LABELS: Record<string, string> = {
  BASIC: 'Basic', HRA: 'House rent allowance', SPECIAL: 'Special allowance',
  CONVEYANCE: 'Conveyance', MEDICAL: 'Medical allowance', LTA: 'Leave travel allowance',
  PF_EE: 'Provident fund (employee)', PF_ER: 'Provident fund (employer)',
  ESI_EE: 'ESI (employee)', ESI_ER: 'ESI (employer)', PT: 'Professional tax',
  TDS: 'Income tax (TDS)', LOP: 'Loss of pay',
}

const label = (code: string): string =>
  LABELS[code] ?? code.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase())

/** Renders the page. Two columns, earnings left, deductions right. */
export function renderPayslipPdf(slip: SlipRow, lines: LineRow[]): Buffer {
  const page = new PdfPage()
  const name = [slip.first_name, slip.last_name].filter(Boolean).join(' ')
  let y = PAGE_HEIGHT - MARGIN

  page.text(slip.company_name, MARGIN, y, { font: 'bold', size: 16 })
  page.textRight('Payslip', RIGHT, y, { font: 'bold', size: 16, grey: 0.45 })
  y -= 18
  page.text(`Pay period ${slip.period_label}`, MARGIN, y, { size: 9.5, grey: 0.4 })
  page.textRight(
    slip.revision > 1 ? `Revision ${slip.revision}` : `Paid ${dateLabel(slip.pay_date)}`,
    RIGHT, y, { size: 9.5, grey: 0.4 })
  y -= 14
  page.line(MARGIN, y, RIGHT, y, 0.75, 1)
  y -= 26

  // --- who this is for -----------------------------------------------------
  const facts: [string, string][] = [
    ['Employee', name],
    ['Employee code', slip.employee_code ?? '—'],
    ['Designation', slip.designation ?? '—'],
    ['Department', slip.department ?? '—'],
    ['Date of joining', dateLabel(slip.date_of_joining)],
    ['Period', `${dateLabel(slip.period_start)} – ${dateLabel(slip.period_end)}`],
  ]
  const factTop = y
  facts.forEach(([key, value], i) => {
    const column = i % 2
    const row = Math.floor(i / 2)
    const x = MARGIN + column * ((RIGHT - MARGIN) / 2)
    const lineY = factTop - row * 16
    page.text(key, x, lineY, { size: 8.5, grey: 0.45 })
    page.text(value, x + 96, lineY, { size: 10 })
  })
  y = factTop - Math.ceil(facts.length / 2) * 16 - 14
  page.line(MARGIN, y, RIGHT, y, 0.85)
  y -= 24

  // --- the money -----------------------------------------------------------
  const earnings = lines.filter((l) => l.component_type === 'earning')
  const deductions = lines.filter((l) => l.component_type === 'deduction')
  const employer = lines.filter((l) => l.component_type === 'employer_contribution')

  const columnWidth = (RIGHT - MARGIN - 24) / 2
  const leftX = MARGIN
  const rightX = MARGIN + columnWidth + 24
  const head = y

  page.text('Earnings', leftX, head, { font: 'bold', size: 10 })
  page.textRight('Amount', leftX + columnWidth, head, { font: 'bold', size: 10 })
  page.text('Deductions', rightX, head, { font: 'bold', size: 10 })
  page.textRight('Amount', rightX + columnWidth, head, { font: 'bold', size: 10 })
  page.line(leftX, head - 6, leftX + columnWidth, head - 6, 0.85)
  page.line(rightX, head - 6, rightX + columnWidth, head - 6, 0.85)

  const rowAt = (i: number) => head - 22 - i * 15
  earnings.forEach((l, i) => {
    page.text(label(l.component_code), leftX, rowAt(i), { size: 9.5 })
    page.textRight(rupees(l.amount_paise), leftX + columnWidth, rowAt(i), { size: 9.5 })
  })
  deductions.forEach((l, i) => {
    page.text(label(l.component_code), rightX, rowAt(i), { size: 9.5 })
    page.textRight(rupees(l.amount_paise), rightX + columnWidth, rowAt(i), { size: 9.5 })
  })

  const rows = Math.max(earnings.length, deductions.length)
  let totalsY = rowAt(rows) - 8
  page.line(leftX, totalsY + 10, leftX + columnWidth, totalsY + 10, 0.85)
  page.line(rightX, totalsY + 10, rightX + columnWidth, totalsY + 10, 0.85)
  page.text('Gross earnings', leftX, totalsY, { font: 'bold', size: 9.5 })
  page.textRight(rupees(slip.gross_paise), leftX + columnWidth, totalsY, { font: 'bold', size: 9.5 })
  page.text('Total deductions', rightX, totalsY, { font: 'bold', size: 9.5 })
  page.textRight(rupees(slip.deductions_paise), rightX + columnWidth, totalsY,
    { font: 'bold', size: 9.5 })

  // --- net pay -------------------------------------------------------------
  y = totalsY - 40
  page.rect(MARGIN, y - 12, RIGHT - MARGIN, 40, 0.94)
  page.text('Net pay', MARGIN + 14, y + 12, { font: 'bold', size: 11 })
  page.textRight(rupees(slip.net_paise), RIGHT - 14, y + 10, { font: 'bold', size: 15 })
  page.text(amountInWords(BigInt(slip.net_paise)), MARGIN + 14, y - 2, { size: 8.5, grey: 0.4 })

  y -= 42
  if (employer.length) {
    page.text('Employer contributions (not deducted from you)', MARGIN, y,
      { size: 8.5, font: 'bold', grey: 0.45 })
    y -= 14
    for (const l of employer) {
      page.text(label(l.component_code), MARGIN, y, { size: 9, grey: 0.3 })
      page.textRight(rupees(l.amount_paise), MARGIN + columnWidth, y, { size: 9, grey: 0.3 })
      y -= 13
    }
  }

  page.line(MARGIN, MARGIN + 26, RIGHT, MARGIN + 26, 0.9)
  page.text(
    'Computer generated payslip. No signature is required.',
    MARGIN, MARGIN + 12, { size: 8, grey: 0.5 })
  page.textRight(`Payslip ${slip.id.slice(0, 8)}`, RIGHT, MARGIN + 12, { size: 8, grey: 0.5 })

  return renderPdf(page, `Payslip ${slip.period_label} — ${name}`)
}

/** Loads and renders in one call: what the route needs. */
export async function payslipPdf(
  tx: PoolClient,
  payslipId: string,
): Promise<{ bytes: Buffer; fileName: string; employeeId: string }> {
  const { slip, lines } = await loadPayslip(tx, payslipId)
  const name = [slip.first_name, slip.last_name].filter(Boolean).join('-').toLowerCase()
  return {
    bytes: renderPayslipPdf(slip, lines),
    fileName: `payslip-${slip.period_label}-${name || slip.employee_id.slice(0, 8)}.pdf`,
    employeeId: slip.employee_id,
  }
}
