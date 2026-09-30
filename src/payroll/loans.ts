/**
 * Loans and advances — see 045_loans.sql.
 *
 * The instalment is computed once at grant: principal plus simple interest
 * over the term, divided into equal rupee instalments with the remainder on
 * the last. Each freeze takes the next instalment (or the balance if less)
 * as a LOAN_EMI deduction and records it against the run; unfreeze gives it
 * back. The balance is always principal + interest − repayments, never a
 * stored number. At exit the whole balance is recovered in the settlement.
 */
import type { PoolClient } from 'pg'

export class LoanError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LoanError'
  }
}

export interface Loan {
  id: string
  employee_id: string
  kind: 'loan' | 'advance'
  principal_paise: string
  annual_interest_pct: string
  instalments: number
  instalment_paise: string
  starts_on: string
  disbursed_on: string
  reason: string | null
  status: 'active' | 'settled' | 'written_off' | 'cancelled'
  closed_at: string | null
  closed_reason: string | null
}

const COLUMNS = `id, employee_id, kind, principal_paise::text, annual_interest_pct::text, instalments, instalment_paise::text,
  starts_on::text, disbursed_on::text, reason, status, closed_at::text, closed_reason`

/** Total repayable and the equal rupee instalment. Simple interest over the term in months. */
export function schedule(principalPaise: number, annualInterestPct: number, instalments: number): { totalPaise: number; instalmentPaise: number } {
  const interest = Math.round(principalPaise * (annualInterestPct / 100) * (instalments / 12))
  const total = Math.round((principalPaise + interest) / 100) * 100
  const instalment = Math.ceil(total / instalments / 100) * 100
  return { totalPaise: total, instalmentPaise: instalment }
}

export async function grantLoan(
  tx: PoolClient,
  i: { employeeId: string; kind: 'loan' | 'advance'; principalPaise: number; annualInterestPct?: number; instalments: number
       startsOn: string; disbursedOn?: string; reason?: string; approvedByUserId?: string; actorUserId?: string },
): Promise<Loan> {
  if (!Number.isSafeInteger(i.principalPaise) || i.principalPaise <= 0) throw new LoanError('VALIDATION_FAILED', 'principalPaise must be a positive integer')
  if (!Number.isInteger(i.instalments) || i.instalments < 1 || i.instalments > 120) throw new LoanError('VALIDATION_FAILED', 'instalments is 1–120')
  const rate = i.annualInterestPct ?? 0
  if (!(rate >= 0 && rate <= 36)) throw new LoanError('VALIDATION_FAILED', 'annualInterestPct is 0–36')
  if (i.kind === 'advance' && i.instalments > 12) throw new LoanError('VALIDATION_FAILED', 'a salary advance is recovered within twelve months; longer is a loan')
  const { instalmentPaise } = schedule(i.principalPaise, rate, i.instalments)
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { rows } = await tx.query<Loan>(
    `INSERT INTO employee_loans (tenant_id, employee_id, kind, principal_paise, annual_interest_pct, instalments, instalment_paise,
                                 starts_on, disbursed_on, reason, approved_by_user_id, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date, CURRENT_DATE),$10,$11,$12) RETURNING ${COLUMNS}`,
    [tid, i.employeeId, i.kind, i.principalPaise, rate, i.instalments, instalmentPaise, i.startsOn, i.disbursedOn ?? null,
     i.reason ?? null, i.approvedByUserId ?? null, i.actorUserId ?? null])
  return rows[0]!
}

export interface LoanView extends Loan { total_paise: number; repaid_paise: number; balance_paise: number; instalments_taken: number }

export async function loanView(tx: PoolClient, loan: Loan): Promise<LoanView> {
  const { rows } = await tx.query<{ repaid: string; n: string }>(
    `SELECT coalesce(sum(amount_paise), 0)::text AS repaid, count(*)::text AS n FROM loan_repayments WHERE loan_id = $1`, [loan.id])
  const total = schedule(Number(loan.principal_paise), Number(loan.annual_interest_pct), loan.instalments).totalPaise
  const repaid = Number(rows[0]!.repaid)
  return { ...loan, total_paise: total, repaid_paise: repaid, balance_paise: Math.max(0, total - repaid), instalments_taken: Number(rows[0]!.n) }
}

export async function listLoans(tx: PoolClient, employeeId: string, includeClosed = false): Promise<LoanView[]> {
  const { rows } = await tx.query<Loan>(`SELECT ${COLUMNS} FROM employee_loans WHERE employee_id = $1 AND ($2 OR status = 'active') ORDER BY disbursed_on DESC`, [employeeId, includeClosed])
  const out: LoanView[] = []
  for (const l of rows) out.push(await loanView(tx, l))
  return out
}

/** A repayment outside payroll (cash, bank transfer). Settles the loan when the balance hits zero. */
export async function repayManually(tx: PoolClient, loanId: string, amountPaise: number, note?: string): Promise<LoanView> {
  const { rows } = await tx.query<Loan>(`SELECT ${COLUMNS} FROM employee_loans WHERE id = $1 AND status = 'active'`, [loanId])
  if (!rows[0]) throw new LoanError('NOT_FOUND', 'no active loan with that id')
  const view = await loanView(tx, rows[0])
  if (!Number.isSafeInteger(amountPaise) || amountPaise <= 0 || amountPaise > view.balance_paise) {
    throw new LoanError('VALIDATION_FAILED', `amount must be between 1 and the balance (${view.balance_paise})`)
  }
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  await tx.query(`INSERT INTO loan_repayments (tenant_id, loan_id, amount_paise, kind, note) VALUES ($1,$2,$3,'manual',$4)`, [tid, loanId, amountPaise, note ?? null])
  return settleIfClear(tx, rows[0])
}

export async function closeLoan(tx: PoolClient, loanId: string, status: 'written_off' | 'cancelled', reason: string): Promise<Loan> {
  if (!reason.trim()) throw new LoanError('REASON_REQUIRED', 'closing a loan needs a reason on the record')
  const { rows } = await tx.query<Loan>(
    `UPDATE employee_loans SET status = $2, closed_at = now(), closed_reason = $3 WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`,
    [loanId, status, reason.trim()])
  if (!rows[0]) throw new LoanError('NOT_FOUND', 'no active loan with that id')
  return rows[0]
}

async function settleIfClear(tx: PoolClient, loan: Loan): Promise<LoanView> {
  const v = await loanView(tx, loan)
  if (v.balance_paise === 0 && v.status === 'active') {
    await tx.query(`UPDATE employee_loans SET status = 'settled', closed_at = now() WHERE id = $1`, [loan.id])
    v.status = 'settled'
  }
  return v
}

/**
 * Called by freezeInputs. Takes this period's instalment from every active
 * loan that has started, records it against the run, and returns the total.
 * `all` takes the whole balance — the exit settlement.
 */
export async function deductForRun(
  tx: PoolClient,
  args: { employeeId: string; runId: string; periodStart: string; all?: boolean },
): Promise<{ amountPaise: number; loans: { loanId: string; amountPaise: number }[]; settlement?: boolean }> {
  // A revision recomputes a month that has already been recovered. It carries the SAME
  // deduction on the corrected payslip -- so the correction does not look like the employee
  // was let off the instalment -- but records nothing: the loan was repaid once, and a second
  // repayment row would take a second instalment off its balance for the same month.
  const prior = await tx.query<{ loan_id: string; amount_paise: string; kind: string }>(
    `WITH RECURSIVE chain(id, sup) AS (
       SELECT id, supersedes_run_id FROM payroll_runs WHERE id = $1
       UNION ALL
       SELECT r.id, r.supersedes_run_id FROM payroll_runs r JOIN chain c ON r.id = c.sup)
     SELECT lr.loan_id, lr.amount_paise::text, lr.kind
       FROM loan_repayments lr
       JOIN employee_loans l ON l.id = lr.loan_id
      WHERE lr.run_id IN (SELECT id FROM chain WHERE id <> $1) AND l.employee_id = $2`,
    [args.runId, args.employeeId])
  const isRevision = (await tx.query(`SELECT 1 FROM payroll_runs WHERE id = $1 AND supersedes_run_id IS NOT NULL`, [args.runId])).rowCount
  if (isRevision) {
    const loans = prior.rows.map((r) => ({ loanId: r.loan_id, amountPaise: Number(r.amount_paise) }))
    return {
      amountPaise: loans.reduce((n, l) => n + l.amountPaise, 0), loans,
      settlement: prior.rows.some((r) => r.kind === 'exit'),
    }
  }
  const { rows } = await tx.query<Loan>(
    `SELECT ${COLUMNS} FROM employee_loans WHERE employee_id = $1 AND status = 'active' AND starts_on <= $2::date ORDER BY disbursed_on`,
    [args.employeeId, args.periodStart])
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const taken: { loanId: string; amountPaise: number }[] = []
  for (const loan of rows) {
    const already = await tx.query(`SELECT 1 FROM loan_repayments WHERE loan_id = $1 AND run_id = $2`, [loan.id, args.runId])
    if (already.rowCount) continue
    const v = await loanView(tx, loan)
    const amount = args.all ? v.balance_paise : Math.min(Number(loan.instalment_paise), v.balance_paise)
    if (amount <= 0) continue
    await tx.query(
      `INSERT INTO loan_repayments (tenant_id, loan_id, run_id, amount_paise, kind) VALUES ($1,$2,$3,$4,$5)`,
      [tid, loan.id, args.runId, amount, args.all ? 'exit' : 'payroll'])
    taken.push({ loanId: loan.id, amountPaise: amount })
  }
  return { amountPaise: taken.reduce((n, t) => n + t.amountPaise, 0), loans: taken }
}

export async function releaseRun(tx: PoolClient, runId: string): Promise<void> {
  await tx.query(`DELETE FROM loan_repayments WHERE run_id = $1`, [runId])
}

/** Lock: any loan whose balance is now zero is settled. */
export async function settleClearedByRun(tx: PoolClient, runId: string): Promise<number> {
  const { rows } = await tx.query<Loan>(
    `SELECT ${COLUMNS} FROM employee_loans
      WHERE status = 'active' AND id IN (SELECT loan_id FROM loan_repayments WHERE run_id = $1)`, [runId])
  let n = 0
  for (const l of rows) if ((await settleIfClear(tx, l)).status === 'settled') n++
  return n
}
