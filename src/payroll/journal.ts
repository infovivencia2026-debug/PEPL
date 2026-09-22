/**
 * Accounting journal for a locked payroll run.
 *
 * Every payroll line posts to two heads: earnings debit an expense account
 * and credit Salary Payable; employee deductions debit Salary Payable and
 * credit the liability they belong to (PF Payable, TDS Payable, …); employer
 * contributions debit an expense and credit the same liability. Net pay is
 * what remains in Salary Payable and is cleared when the bank file settles.
 * The journal balances by construction; the export refuses to render if it
 * does not. Mappings are per company (Tally ledger names, ERP codes); the
 * defaults below are what an Indian SME's chart of accounts calls them.
 */
import type { PoolClient } from 'pg'

export class JournalError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'JournalError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface Mapping { id: string; component_code: string; component_type: string | null; debit_account: string | null; credit_account: string | null; cost_centre_by: string }
export const DEFAULT_MAPPINGS: Array<Omit<Mapping, 'id'>> = [
  { component_code: '*', component_type: 'earning', debit_account: 'Salaries & Wages', credit_account: 'Salary Payable', cost_centre_by: 'department' },
  { component_code: '*', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'Other Deductions Payable', cost_centre_by: 'none' },
  { component_code: '*', component_type: 'employer_contribution', debit_account: 'Employer Contributions', credit_account: 'Statutory Payable', cost_centre_by: 'department' },
  { component_code: 'PF_EE', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'PF Payable', cost_centre_by: 'none' },
  { component_code: 'PF_ER', component_type: 'employer_contribution', debit_account: 'PF Employer Contribution', credit_account: 'PF Payable', cost_centre_by: 'department' },
  { component_code: 'ESI_EE', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'ESI Payable', cost_centre_by: 'none' },
  { component_code: 'ESI_ER', component_type: 'employer_contribution', debit_account: 'ESI Employer Contribution', credit_account: 'ESI Payable', cost_centre_by: 'department' },
  { component_code: 'PT', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'Professional Tax Payable', cost_centre_by: 'none' },
  { component_code: 'TDS', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'TDS Payable (192)', cost_centre_by: 'none' },
  { component_code: 'LOAN', component_type: 'deduction', debit_account: 'Salary Payable', credit_account: 'Staff Loans & Advances', cost_centre_by: 'none' },
  { component_code: 'REIMB', component_type: 'earning', debit_account: 'Staff Reimbursements', credit_account: 'Salary Payable', cost_centre_by: 'department' },
]

export async function listMappings(tx: PoolClient): Promise<Mapping[]> {
  const tid = await tenantId(tx)
  if ((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM ledger_mappings`)).rows[0]!.n === '0') {
    for (const m of DEFAULT_MAPPINGS) {
      await tx.query(`INSERT INTO ledger_mappings (tenant_id, component_code, component_type, debit_account, credit_account, cost_centre_by) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, component_code) DO NOTHING`,
        [tid, m.component_code === '*' ? `*:${m.component_type}` : m.component_code, m.component_type, m.debit_account, m.credit_account, m.cost_centre_by])
    }
  }
  return (await tx.query<Mapping>(`SELECT id, component_code, component_type, debit_account, credit_account, cost_centre_by FROM ledger_mappings ORDER BY component_code`)).rows
}
export async function upsertMapping(tx: PoolClient, m: { componentCode: string; componentType?: string | null; debitAccount: string; creditAccount: string; costCentreBy?: string }): Promise<Mapping> {
  const tid = await tenantId(tx)
  if (!m.componentCode?.trim() || !m.debitAccount?.trim() || !m.creditAccount?.trim()) throw new JournalError('VALIDATION_FAILED', 'componentCode, debitAccount and creditAccount are required')
  const { rows } = await tx.query<Mapping>(
    `INSERT INTO ledger_mappings (tenant_id, component_code, component_type, debit_account, credit_account, cost_centre_by) VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, component_code) DO UPDATE SET component_type = EXCLUDED.component_type, debit_account = EXCLUDED.debit_account, credit_account = EXCLUDED.credit_account, cost_centre_by = EXCLUDED.cost_centre_by
     RETURNING id, component_code, component_type, debit_account, credit_account, cost_centre_by`,
    [tid, m.componentCode.trim().toUpperCase(), m.componentType ?? null, m.debitAccount.trim(), m.creditAccount.trim(), m.costCentreBy ?? 'department'])
  return rows[0]!
}

export interface JournalLine { account: string; costCentre: string | null; debitPaise: bigint; creditPaise: bigint; narration: string }
export interface Journal { runId: string; period: string; date: string; lines: JournalLine[]; totalDebitPaise: bigint; totalCreditPaise: bigint; balanced: boolean; unmapped: string[] }

export async function buildJournal(tx: PoolClient, runId: string): Promise<Journal> {
  const run = (await tx.query<{ status: string; period_start: string; period_end: string }>(
    `SELECT r.status, p.period_start::text, p.period_end::text FROM payroll_runs r JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id) WHERE r.id = $1`, [runId])).rows[0]
  if (!run) throw new JournalError('NOT_FOUND', 'no such run')
  if (run.status !== 'locked') throw new JournalError('RUN_NOT_LOCKED', 'only a locked run posts to the books')
  const mappings = await listMappings(tx)
  const byCode = new Map(mappings.map((m) => [m.component_code, m]))
  const { rows } = await tx.query<{ component_code: string; component_type: string; amount: string; department: string | null; location: string | null; cost_centre: string | null }>(
    `SELECT l.component_code, l.component_type, sum(l.amount_paise)::text AS amount, a.department, a.location_code AS location, e.cost_centre
       FROM payroll_lines l JOIN employees e ON e.id = l.employee_id
       LEFT JOIN LATERAL (SELECT department, location_code FROM employee_assignments x WHERE x.employee_id = l.employee_id AND x.superseded_at IS NULL AND x.effective_from <= $2::date ORDER BY effective_from DESC LIMIT 1) a ON true
      WHERE l.run_id = $1 AND l.component_type IN ('earning','deduction','employer_contribution')
      GROUP BY l.component_code, l.component_type, a.department, a.location_code, e.cost_centre ORDER BY l.component_type, l.component_code`, [runId, run.period_end])
  const acc = new Map<string, JournalLine>()
  const post = (account: string, cc: string | null, dr: bigint, cr: bigint, narration: string): void => {
    const k = `${account}|${cc ?? ''}`
    const line = acc.get(k) ?? { account, costCentre: cc, debitPaise: 0n, creditPaise: 0n, narration }
    line.debitPaise += dr; line.creditPaise += cr; acc.set(k, line)
  }
  const unmapped = new Set<string>()
  for (const r of rows) {
    const m = byCode.get(r.component_code) ?? byCode.get(`*:${r.component_type}`)
    if (!m?.debit_account || !m.credit_account) { unmapped.add(r.component_code); continue }
    const amt = BigInt(r.amount)
    if (amt === 0n) continue
    const cc = m.cost_centre_by === 'department' ? r.department : m.cost_centre_by === 'location' ? r.location : m.cost_centre_by === 'cost_centre' ? r.cost_centre : null
    const narr = `Payroll ${run.period_start.slice(0, 7)} · ${r.component_code}`
    // Cost centres belong to expense heads only; a payable split by department never nets to zero.
    const expenseSide = r.component_type === 'earning' || r.component_type === 'employer_contribution'
    post(m.debit_account, expenseSide ? cc : null, amt, 0n, narr)
    post(m.credit_account, null, 0n, amt, narr)
  }
  // Employee deductions were credited to their liabilities and debited to Salary Payable; net pay = payable balance
  const lines = [...acc.values()].filter((l) => l.debitPaise !== l.creditPaise || l.debitPaise !== 0n).sort((a, b) => a.account.localeCompare(b.account) || (a.costCentre ?? '').localeCompare(b.costCentre ?? ''))
  const totalDebit = lines.reduce((s, l) => s + l.debitPaise, 0n), totalCredit = lines.reduce((s, l) => s + l.creditPaise, 0n)
  return { runId, period: run.period_start.slice(0, 7), date: run.period_end, lines, totalDebitPaise: totalDebit, totalCreditPaise: totalCredit, balanced: totalDebit === totalCredit, unmapped: [...unmapped] }
}

const inr = (p: bigint): string => (Number(p) / 100).toFixed(2)
const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export function journalCsv(j: Journal): string {
  const head = 'Date,Account,Cost centre,Debit,Credit,Narration'
  const body = j.lines.map((l) => [j.date, l.account, l.costCentre ?? '', l.debitPaise ? inr(l.debitPaise) : '', l.creditPaise ? inr(l.creditPaise) : '', l.narration].map((v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(','))
  return [head, ...body, `,TOTAL,,${inr(j.totalDebitPaise)},${inr(j.totalCreditPaise)},`].join('\n') + '\n'
}

/** Tally Prime import: one Journal voucher, debit amounts negative per Tally's convention. */
export function journalTallyXml(j: Journal, company: string): string {
  if (!j.balanced) throw new JournalError('JOURNAL_UNBALANCED', 'the journal does not balance; fix the ledger mappings first')
  const d = j.date.replace(/-/g, '')
  const entries = j.lines.map((l) => `      <ALLLEDGERENTRIES.LIST>
        <LEDGERNAME>${xml(l.account)}</LEDGERNAME>
        <ISDEEMEDPOSITIVE>${l.debitPaise ? 'Yes' : 'No'}</ISDEEMEDPOSITIVE>
        <AMOUNT>${l.debitPaise ? '-' + inr(l.debitPaise) : inr(l.creditPaise)}</AMOUNT>${l.costCentre ? `
        <CATEGORYALLOCATIONS.LIST><CATEGORY>Primary Cost Category</CATEGORY><COSTCENTREALLOCATIONS.LIST><NAME>${xml(l.costCentre)}</NAME><AMOUNT>${l.debitPaise ? '-' + inr(l.debitPaise) : inr(l.creditPaise)}</AMOUNT></COSTCENTREALLOCATIONS.LIST></CATEGORYALLOCATIONS.LIST>` : ''}
      </ALLLEDGERENTRIES.LIST>`).join('\n')
  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>Vouchers</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${xml(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>
  <REQUESTDATA><TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="Journal" ACTION="Create">
      <DATE>${d}</DATE>
      <VOUCHERTYPENAME>Journal</VOUCHERTYPENAME>
      <NARRATION>Payroll ${j.period}</NARRATION>
${entries}
    </VOUCHER>
  </TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY>
</ENVELOPE>
`
}

// ── payment reconciliation ───────────────────────────────────────────────────

export interface ReconLine { reference?: string; accountNumber?: string; amountPaise?: number; status: 'settled' | 'failed' | 'returned'; utr?: string; reason?: string }
/** Apply a bank's return file to a batch: match by reference (else account + amount); settled lines get the UTR. */
export async function reconcileBatch(tx: PoolClient, args: { batchId: string; lines: ReconLine[] }): Promise<{ matched: number; unmatched: ReconLine[]; settled: number; failed: number }> {
  const batch = (await tx.query<{ id: string; status: string }>(`SELECT id, status FROM payment_batches WHERE id = $1`, [args.batchId])).rows[0]
  if (!batch) throw new JournalError('NOT_FOUND', 'no such batch')
  let matched = 0, settled = 0, failed = 0
  const unmatched: ReconLine[] = []
  for (const l of args.lines) {
    if (!['settled', 'failed', 'returned'].includes(l.status)) throw new JournalError('VALIDATION_FAILED', 'status is settled, failed or returned')
    const r = await tx.query<{ id: string }>(
      `UPDATE payment_instructions SET status = $2, utr = coalesce($3, utr), failure_reason = $4, settled_at = CASE WHEN $2 = 'settled' THEN now() ELSE NULL END
        WHERE batch_id = $1 AND status IN ('pending','submitted') AND (($5::text IS NOT NULL AND reference = $5) OR ($5::text IS NULL AND account_number = $6 AND amount_paise = $7)) RETURNING id`,
      [args.batchId, l.status, l.utr ?? null, l.status === 'settled' ? null : (l.reason ?? null), l.reference ?? null, l.accountNumber ?? null, l.amountPaise ?? null])
    if (r.rowCount) { matched++; if (l.status === 'settled') settled++; else failed++ } else unmatched.push(l)
  }
  const { rows: c } = await tx.query<{ left: string; failed: string }>(`SELECT count(*) FILTER (WHERE status IN ('pending','submitted'))::text AS left, count(*) FILTER (WHERE status IN ('failed','returned'))::text AS failed FROM payment_instructions WHERE batch_id = $1`, [args.batchId])
  const status = c[0]!.left !== '0' ? 'partially_settled' : c[0]!.failed === '0' ? 'settled' : 'partially_settled'
  await tx.query(`UPDATE payment_batches SET status = $2 WHERE id = $1`, [args.batchId, status])
  return { matched, unmatched, settled, failed }
}
export async function paymentStatus(tx: PoolClient, runId: string): Promise<{ batches: number; instructions: number; settled: number; failed: number; pending: number; failures: Array<{ employeeId: string; amountPaise: string; reason: string | null }> }> {
  const { rows } = await tx.query<{ status: string; n: string }>(
    `SELECT i.status, count(*)::text AS n FROM payment_instructions i JOIN payment_batches b ON b.id = i.batch_id WHERE b.source_type = 'payroll_run' AND b.source_id = $1 GROUP BY i.status`, [runId])
  const by = Object.fromEntries(rows.map((r) => [r.status, Number(r.n)]))
  const batches = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM payment_batches WHERE source_type = 'payroll_run' AND source_id = $1`, [runId])).rows[0]!.n)
  const { rows: failures } = await tx.query<{ employee_id: string; amount_paise: string; failure_reason: string | null }>(
    `SELECT i.employee_id, i.amount_paise::text, i.failure_reason FROM payment_instructions i JOIN payment_batches b ON b.id = i.batch_id WHERE b.source_type = 'payroll_run' AND b.source_id = $1 AND i.status IN ('failed','returned')`, [runId])
  return { batches, instructions: rows.reduce((s, r) => s + Number(r.n), 0), settled: by.settled ?? 0, failed: (by.failed ?? 0) + (by.returned ?? 0), pending: (by.pending ?? 0) + (by.submitted ?? 0),
    failures: failures.map((f) => ({ employeeId: f.employee_id, amountPaise: f.amount_paise, reason: f.failure_reason })) }
}
