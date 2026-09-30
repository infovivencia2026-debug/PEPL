/**
 * Bank file generation.
 *
 * The governing risk is DOUBLE PAYMENT, which is not fully recoverable: getting
 * an overpayment back from an employee is a legal and human problem, not a
 * database fix. Every rule here exists for that reason:
 *
 *   - only a LOCKED run can produce a batch
 *   - one batch per (run, channel), enforced by a unique constraint
 *   - regenerating returns the SAME file and the same checksum
 *   - the row count and total are recorded, so "the bank got a different file"
 *     is answerable
 *
 * Formats are per-bank templates in configuration, not code. Expect to add one
 * per customer early on; that is data entry, not engineering.
 */
import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'

export class PaymentError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'PaymentError'
  }
}

export type BankFormat = 'hdfc_neft_csv' | 'icici_csv' | 'axis_csv' | 'generic_neft_csv'

export interface Instruction {
  employeeId: string
  employeeNumber: string
  beneficiaryName: string
  accountNumber: string
  ifsc: string
  amountPaise: bigint
  reference: string
}

interface FormatSpec {
  header: string[]
  /** Rupees with two decimals is what every Indian bank portal expects. */
  row: (i: Instruction, ctx: { valueDate: string }) => string[]
}

const rupees = (paise: bigint): string => (Number(paise) / 100).toFixed(2)

const FORMATS: Record<BankFormat, FormatSpec> = {
  generic_neft_csv: {
    header: ['Beneficiary Name', 'Account Number', 'IFSC', 'Amount', 'Reference'],
    row: (i) => [i.beneficiaryName, i.accountNumber, i.ifsc, rupees(i.amountPaise), i.reference],
  },
  hdfc_neft_csv: {
    header: ['Transaction Type', 'Beneficiary Account', 'Beneficiary Name', 'Amount',
             'Value Date', 'IFSC', 'Remarks'],
    row: (i, ctx) => ['NEFT', i.accountNumber, i.beneficiaryName, rupees(i.amountPaise),
                      ctx.valueDate, i.ifsc, i.reference],
  },
  icici_csv: {
    header: ['PYMT_MODE', 'BENEFICIARY_NAME', 'BENEFICIARY_ACCOUNT', 'IFSC_CODE',
             'AMOUNT', 'VALUE_DATE', 'REMARKS'],
    row: (i, ctx) => ['NEFT', i.beneficiaryName, i.accountNumber, i.ifsc,
                      rupees(i.amountPaise), ctx.valueDate, i.reference],
  },
  axis_csv: {
    header: ['Payment Type', 'Beneficiary Name', 'Account No', 'IFSC', 'Amount',
             'Value Date', 'Narration'],
    row: (i, ctx) => ['NEFT', i.beneficiaryName, i.accountNumber, i.ifsc,
                      rupees(i.amountPaise), ctx.valueDate, i.reference],
  },
}

/** CSV injection guard: a leading =, +, - or @ is executed by spreadsheet apps. */
const cell = (v: string): string =>
  '"' + String(v ?? '').replace(/^[=+@\-\t\r]/, "'$&").replaceAll('"', '""') + '"'

export function renderBankFile(
  instructions: readonly Instruction[],
  format: BankFormat,
  valueDate: string,
): { content: string; checksum: string; lineCount: number; totalPaise: bigint } {
  const spec = FORMATS[format]
  if (!spec) throw new PaymentError('UNKNOWN_FORMAT', `no bank file format "${format}"`)

  const lines = [
    spec.header.map(cell).join(','),
    ...instructions.map((i) => spec.row(i, { valueDate }).map(cell).join(',')),
  ]
  const content = lines.join('\r\n') + '\r\n'

  return {
    content,
    checksum: createHash('sha256').update(content).digest('hex'),
    lineCount: instructions.length,
    totalPaise: instructions.reduce((s, i) => s + i.amountPaise, 0n),
  }
}

export interface BatchResult {
  batchId: string
  checksum: string
  lineCount: number
  totalPaise: string
  content: string
  reused: boolean
}

/**
 * Generates — or returns — the batch for a locked run. Calling twice is safe and
 * yields the identical file, which is what makes a retried download harmless.
 */
export async function generateBankFile(
  tx: PoolClient,
  args: {
    runId: string
    format: BankFormat
    valueDate: string
    generatedByUserId: string
    bankAccountId?: string
  },
): Promise<BatchResult> {
  const { rows: tRows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const tenantId = tRows[0]?.t
  if (!tenantId) throw new PaymentError('NO_TENANT_CONTEXT', 'no tenant context')

  const { rows: runRows } = await tx.query<{ status: string; period_label: string; revision: number; supersedes_run_id: string | null }>(
    `SELECT r.status, p.label AS period_label, r.revision, r.supersedes_run_id
       FROM payroll_runs r
       JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id)
      WHERE r.id = $1`,
    [args.runId],
  )
  const run = runRows[0]
  if (!run) throw new PaymentError('RUN_NOT_FOUND', 'no such payroll run')
  if (run.status !== 'locked') {
    throw new PaymentError(
      'RUN_NOT_LOCKED',
      `a bank file can only be generated from a locked run; this one is ${run.status}`,
    )
  }

  // One batch per run per channel. A second call returns the first file rather
  // than minting a new one — the structural defence against paying twice.
  const existing = await tx.query<{ id: string; file_checksum_sha256: string; instruction_count: number; total_paise: string; file_content: string }>(
    `SELECT id, file_checksum_sha256, instruction_count, total_paise::text, file_content
       FROM payment_batches WHERE source_type = 'payroll_run' AND source_id = $1 AND channel = 'bank_file'`,
    [args.runId],
  )
  if (existing.rows[0]) {
    const e = existing.rows[0]
    return {
      batchId: e.id, checksum: e.file_checksum_sha256, lineCount: e.instruction_count,
      totalPaise: e.total_paise, content: e.file_content, reused: true,
    }
  }

  const { rows: slips } = await tx.query<{
    employee_id: string; employee_number: string; first_name: string; last_name: string | null
    net_paise: string; account_number: string | null; ifsc: string | null
  }>(
    // What is TRANSFERRED for each person: their net, less what the run this one supersedes
    // already owed them. For an ordinary run there is nothing to subtract. A revision is a
    // full recomputation, and its original was paid -- the whole net again would be a second
    // month's salary. Only an increase is a payment: a decrease is a recovery from the
    // employee, which is not something a bank file can do, so it produces no line at all.
    `SELECT s.employee_id, e.employee_number, e.first_name, e.last_name,
            (s.net_paise - coalesce(prev.net_paise, 0))::text AS net_paise, b.account_number, b.ifsc
       FROM payslips s
       JOIN employees e ON (e.tenant_id, e.id) = (s.tenant_id, s.employee_id)
       LEFT JOIN payslips prev
              ON (prev.tenant_id, prev.employee_id) = (s.tenant_id, s.employee_id)
             AND prev.run_id = $2::uuid
       LEFT JOIN employee_bank_accounts b
              ON (b.tenant_id, b.employee_id) = (s.tenant_id, s.employee_id)
             AND b.is_primary
      WHERE s.run_id = $1 AND (s.net_paise - coalesce(prev.net_paise, 0)) > 0
      ORDER BY e.employee_number`,
    [args.runId, run.supersedes_run_id],
  )

  const missing = slips.filter((s) => !s.account_number || !s.ifsc)
  if (missing.length) {
    throw new PaymentError(
      'MISSING_BANK_DETAILS',
      `${missing.length} employee(s) have no bank account on file: ${missing.map((m) => m.employee_number).join(', ')}`,
    )
  }

  const instructions: Instruction[] = slips.map((s) => ({
    employeeId: s.employee_id,
    employeeNumber: s.employee_number,
    beneficiaryName: `${s.first_name} ${s.last_name ?? ''}`.trim(),
    accountNumber: s.account_number!,
    ifsc: s.ifsc!,
    amountPaise: BigInt(s.net_paise),
    // A revision's transfer is a DIFFERENT payment from the original salary: say so, so the
    // two cannot be mistaken for one another (or for a duplicate) on a bank statement.
    reference: run.supersedes_run_id
      ? `SAL ${run.period_label} REV${run.revision} ${s.employee_number}`
      : `SAL ${run.period_label} ${s.employee_number}`,
  }))

  const file = renderBankFile(instructions, args.format, args.valueDate)

  const { rows: created } = await tx.query<{ id: string }>(
    `INSERT INTO payment_batches
       (tenant_id, source_type, source_id, channel, format, value_date,
        instruction_count, total_paise, file_checksum_sha256, file_content,
        generated_by_user_id, status)
     VALUES ($1,'payroll_run',$2,'bank_file',$3,$4,$5,$6,$7,$8,$9,'ready')
     RETURNING id`,
    [tenantId, args.runId, args.format, args.valueDate, file.lineCount,
     String(file.totalPaise), file.checksum, file.content, args.generatedByUserId],
  )
  const batchId = created[0]!.id

  for (const i of instructions) {
    await tx.query(
      `INSERT INTO payment_instructions
         (tenant_id, batch_id, employee_id, beneficiary_name, account_number, ifsc,
          amount_paise, reference)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tenantId, batchId, i.employeeId, i.beneficiaryName, i.accountNumber, i.ifsc,
       String(i.amountPaise), i.reference],
    )
  }

  return {
    batchId,
    checksum: file.checksum,
    lineCount: file.lineCount,
    totalPaise: String(file.totalPaise),
    content: file.content,
    reused: false,
  }
}
