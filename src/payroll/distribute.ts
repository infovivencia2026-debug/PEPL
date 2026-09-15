/**
 * Sending payslips.
 *
 * A payslip nobody receives is a support ticket every month. This renders the
 * PDF that already exists, stores it as a document owned by the employee (so
 * it is downloadable later and covered by retention and erasure), attaches it
 * to a notification email from the company's own sender mailbox, and records
 * that it went — once per payslip, whatever happens to the job afterwards.
 *
 * Locked runs only, because an unlocked payslip can still change and an
 * emailed PDF cannot be recalled.
 */
import type { PoolClient } from 'pg'
import { payslipPdf } from './payslip-pdf.ts'
import { putDocument } from '../documents/index.ts'
import { notify } from '../comms/index.ts'

export class DistributionError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'DistributionError'
  }
}

export interface DistributionResult {
  runId: string
  sent: number
  skipped: { employeeNumber: string; reason: string }[]
  failed: { employeeNumber: string; error: string }[]
}

/**
 * One pass over a locked run. Idempotent: a payslip already marked
 * distributed is left alone, so a retry after a crash sends nothing twice.
 */
export async function distributeRun(
  tx: PoolClient,
  args: { runId: string; periodLabel?: string; actorUserId?: string },
): Promise<DistributionResult> {
  const { rows: run } = await tx.query<{ status: string; label: string }>(
    `SELECT r.status::text, pp.label FROM payroll_runs r
       JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
      WHERE r.id = $1`, [args.runId])
  if (!run[0]) throw new DistributionError('NOT_FOUND', 'no such payroll run')
  if (run[0].status !== 'locked') {
    throw new DistributionError('RUN_NOT_LOCKED', 'payslips are sent from a locked run; this one can still change')
  }
  const period = args.periodLabel ?? run[0].label

  const { rows: slips } = await tx.query<{ id: string; employee_id: string; employee_number: string; name: string; user_id: string | null; email: string | null }>(
    `SELECT p.id, p.employee_id, e.employee_number, concat_ws(' ', e.first_name, e.last_name) AS name,
            u.id AS user_id, u.email
       FROM payslips p
       JOIN employees e ON (e.tenant_id, e.id) = (p.tenant_id, p.employee_id)
       LEFT JOIN app_users u ON (u.tenant_id, u.employee_id) = (e.tenant_id, e.id) AND u.status = 'active'
      WHERE p.run_id = $1 AND p.distributed_at IS NULL
      ORDER BY e.employee_number`, [args.runId])

  const result: DistributionResult = { runId: args.runId, sent: 0, skipped: [], failed: [] }
  for (const slip of slips) {
    if (!slip.user_id) {
      result.skipped.push({ employeeNumber: slip.employee_number, reason: 'no active login to notify' })
      continue
    }
    // A SAVEPOINT per payslip: a database error inside the loop poisons the
    // whole transaction otherwise, and one bad row must not stop the payroll's
    // worth of payslips behind it.
    await tx.query('SAVEPOINT payslip')
    try {
      const pdf = await payslipPdf(tx, slip.id)
      const doc = await putDocument(tx, {
        ownerType: 'employee', ownerId: slip.employee_id, fileName: pdf.fileName,
        contentType: 'application/pdf', bytes: pdf.bytes, category: 'payslip',
        isConfidential: true, uploadedByUserId: args.actorUserId ?? null,
      })
      await notify(tx, {
        userId: slip.user_id, eventType: 'payroll.payslip.available',
        title: `Your payslip for ${period}`,
        body: 'Your payslip is attached and is also on your pay history in PEPL.',
        entityType: 'payslip', entityId: slip.id,
        channels: ['in_app', 'email', 'push'],
        dedupeKey: `payslip:${slip.id}`,
        attachmentDocumentIds: [doc.id],
      })
      await tx.query(`UPDATE payslips SET distributed_at = now(), distribution_error = NULL WHERE id = $1`, [slip.id])
      await tx.query('RELEASE SAVEPOINT payslip')
      result.sent++
    } catch (err) {
      await tx.query('ROLLBACK TO SAVEPOINT payslip')
      const message = (err as Error).message.slice(0, 300)
      await tx.query(`UPDATE payslips SET distribution_error = $2 WHERE id = $1`, [slip.id, message])
      result.failed.push({ employeeNumber: slip.employee_number, error: message })
    }
  }
  return result
}

/** Locked runs with payslips still undelivered — what the job works through. */
export async function pendingRuns(tx: PoolClient, limit = 20): Promise<{ run_id: string; label: string; pending: number }[]> {
  const { rows } = await tx.query<{ run_id: string; label: string; pending: string }>(
    `SELECT r.id AS run_id, pp.label, count(*)::text AS pending
       FROM payslips p
       JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
       JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
      WHERE r.status = 'locked' AND p.distributed_at IS NULL
      GROUP BY r.id, pp.label, pp.period_start
      ORDER BY pp.period_start DESC
      LIMIT $1`, [limit])
  return rows.map((r) => ({ run_id: r.run_id, label: r.label, pending: Number(r.pending) }))
}
