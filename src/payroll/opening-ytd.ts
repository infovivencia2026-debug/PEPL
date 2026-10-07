/**
 * Opening year-to-date figures (migration 110): taxable income and tax already deducted for a financial year
 * BEFORE the employee's first PEPL run. `yearToDate` in run.ts adds the latest row for the year to what PEPL
 * has locked itself, so TDS for a mid-year start is computed on the real year, not on one that began today.
 *
 * Append-only: a correction is a new row, and the latest one is in force.
 */
import type { PoolClient } from 'pg'

export class OpeningYtdError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'OpeningYtdError'
  }
}

export interface OpeningYtd {
  id: string; employee_id: string; fiscal_year: string
  taxable_paise: string; tds_paise: string; reason: string; entered_by: string | null; created_at: string
}

export async function recordOpeningYtd(
  tx: PoolClient,
  i: { employeeId: string; fiscalYear: string; taxablePaise: bigint; tdsPaise: bigint; reason: string; enteredBy?: string },
): Promise<OpeningYtd> {
  if (!/^\d{4}-\d{2}$/.test(i.fiscalYear)) throw new OpeningYtdError('VALIDATION_FAILED', 'fiscalYear looks like 2026-27')
  if (i.taxablePaise < 0n || i.tdsPaise < 0n) throw new OpeningYtdError('VALIDATION_FAILED', 'amounts cannot be negative')
  if (!i.reason?.trim()) throw new OpeningYtdError('VALIDATION_FAILED', 'say where these figures come from')
  const emp = await tx.query(`SELECT 1 FROM employees WHERE id = $1`, [i.employeeId])
  if (!emp.rowCount) throw new OpeningYtdError('NOT_FOUND', 'no such employee')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const id = crypto.randomUUID()   // generated here: INSERT ... RETURNING would need the new row to be visible
  await tx.query(
    `INSERT INTO payroll_opening_ytd (tenant_id, id, employee_id, fiscal_year, taxable_paise, tds_paise, reason, entered_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [tid, id, i.employeeId, i.fiscalYear, i.taxablePaise.toString(), i.tdsPaise.toString(), i.reason.trim(), i.enteredBy ?? null])
  return (await tx.query<OpeningYtd>(
    `SELECT id, employee_id, fiscal_year, taxable_paise::text, tds_paise::text, reason, entered_by, created_at::text
       FROM payroll_opening_ytd WHERE id = $1`, [id])).rows[0]!
}

/** Every entry for the employee, newest first: the history, not just the figure in force. */
export async function listOpeningYtd(tx: PoolClient, employeeId: string): Promise<OpeningYtd[]> {
  return (await tx.query<OpeningYtd>(
    `SELECT id, employee_id, fiscal_year, taxable_paise::text, tds_paise::text, reason, entered_by, created_at::text
       FROM payroll_opening_ytd WHERE employee_id = $1 ORDER BY created_at DESC, id`, [employeeId])).rows
}
