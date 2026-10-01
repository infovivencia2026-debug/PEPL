/**
 * Arrears — see 044_arrears.sql.
 *
 * For each locked, non-superseded run whose period ended before the run being
 * frozen: if a compensation record now in force for that period's end is NEWER
 * than what the run was frozen with (its monthly components differ), the
 * difference in gross, prorated by the days the run actually paid, is owed.
 * Summed into one ARREARS line on the current freeze, and recorded so it is
 * paid once.
 *
 * The comparison is component totals, not a recomputation of the old run:
 * statutory deductions on the arrears are computed by the engine on the run
 * that pays them, which is how the tax authority expects arrears to be taxed
 * (in the year received; s.89 relief is the employee's claim, not payroll's).
 */
import type { PoolClient } from 'pg'

export interface ArrearsLine {
  sourceRunId: string
  periodLabel: string
  compensationRecordId: string
  oldGrossPaise: number
  newGrossPaise: number
  amountPaise: number
}

const total = (c: Record<string, number>): number => Object.values(c).reduce((n, v) => n + Number(v), 0)

/** What is owed and not yet paid, as of a period start. Pure read. */
export async function arrearsOwed(tx: PoolClient, employeeId: string, beforePeriodStart: string): Promise<ArrearsLine[]> {
  const { rows } = await tx.query<{
    run_id: string; label: string; period_end: string; monthly_components: Record<string, number>
    calendar_days: string; payable_days: string; lop_days: string
    record_id: string | null; components: Record<string, number> | null
  }>(
    `SELECT r.id AS run_id, pp.label, pp.period_end::text, i.monthly_components,
            i.calendar_days::text, i.payable_days::text, i.lop_days::text,
            c.id AS record_id, c.components
       FROM payroll_inputs i
       JOIN payroll_runs r ON (r.tenant_id, r.id) = (i.tenant_id, i.run_id)
       JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
       LEFT JOIN LATERAL (
         SELECT id, components FROM compensation_records c
          WHERE (c.tenant_id, c.employee_id) = (i.tenant_id, i.employee_id) AND c.superseded_at IS NULL
            AND c.effective_from <= pp.period_end AND (c.effective_to IS NULL OR c.effective_to > pp.period_end)
          ORDER BY c.effective_from DESC LIMIT 1
       ) c ON true
      WHERE i.employee_id = $1 AND r.status = 'locked' AND pp.period_end < $2::date
        AND NOT EXISTS (SELECT 1 FROM payroll_runs n WHERE n.tenant_id = r.tenant_id AND n.supersedes_run_id = r.id AND n.status = 'locked')
        AND c.id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM arrears_paid a WHERE a.employee_id = i.employee_id AND a.source_run_id = r.id AND a.compensation_record_id = c.id)
      ORDER BY pp.period_start`,
    [employeeId, beforePeriodStart])

  const out: ArrearsLine[] = []
  for (const r of rows) {
    const oldGross = total(r.monthly_components)
    const newGross = total(r.components!)
    if (newGross === oldGross) continue
    // The run paid (payable + lop) / calendar of the month before LOP, and
    // LOP took lop/calendar of that; net factor is payable/calendar.
    const factor = Number(r.payable_days) / Math.max(1, Number(r.calendar_days))
    // What the run paid is compared with the CURRENT record, so anything already paid out for this
    // month under an earlier version of the record must come off. A correction creates a new record
    // id, which the per-record "already paid" test above cannot see: the whole retro amount was paid
    // again on top of what the first record had paid.
    const prior = await tx.query<{ n: string }>(
      `SELECT coalesce(sum(amount_paise), 0)::text AS n FROM arrears_paid WHERE employee_id = $1 AND source_run_id = $2`,
      [employeeId, r.run_id])
    const amount = Math.round((newGross - oldGross) * factor / 100) * 100 - Number(prior.rows[0]!.n)
    if (amount === 0) continue
    out.push({ sourceRunId: r.run_id, periodLabel: r.label, compensationRecordId: r.record_id!,
      oldGrossPaise: oldGross, newGrossPaise: newGross, amountPaise: amount })
  }
  return out
}

/** Records the lines as paid in `runId` and returns the total. Negative arrears (a cut) are recovered the same way. */
export async function recordArrears(tx: PoolClient, employeeId: string, runId: string, lines: ArrearsLine[]): Promise<number> {
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  for (const l of lines) {
    await tx.query(
      `INSERT INTO arrears_paid (tenant_id, employee_id, compensation_record_id, source_run_id, paid_in_run_id, old_gross_paise, new_gross_paise, amount_paise)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [tid, employeeId, l.compensationRecordId, l.sourceRunId, runId, l.oldGrossPaise, l.newGrossPaise, l.amountPaise])
  }
  return lines.reduce((n, l) => n + l.amountPaise, 0)
}

export async function releaseArrears(tx: PoolClient, runId: string): Promise<void> {
  await tx.query(`DELETE FROM arrears_paid WHERE paid_in_run_id = $1`, [runId])
}
