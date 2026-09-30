/**
 * Approving a payroll run: the anomaly guards run first, then the approval.
 *
 * Both the API and the browser approve runs. The API ran the guards before
 * approving; the browser called approve() directly. approve() only refuses
 * findings that are ALREADY open ("the guards must have run"), so a run driven
 * from the browser never generated any findings for it to refuse -- an approver
 * could pay someone before their joining date, or the same person twice, and the
 * check that exists to stop exactly that never ran.
 *
 * One function, so a third caller cannot repeat the omission.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { runPayrollGuards } from './guards.ts'
import { approve, PayrollError } from './run.ts'

export async function approveWithGuards(
  tx: PoolClient,
  cfg: ResolvedConfig,
  runId: string,
  approverUserId: string,
): Promise<void> {
  // Run here, so the approver always decides against the CURRENT findings.
  const guard = await runPayrollGuards(tx, cfg, runId)
  if (guard.blocking > 0) {
    throw new PayrollError('ANOMALIES_OPEN',
      `${guard.blocking} blocking finding(s) open on this run; see GET /anomalies?runId=`)
  }
  await approve(tx, runId, approverUserId, {
    requireSeparateApprover: cfg.get<boolean>('payroll.require_separate_approver'),
  })
}
