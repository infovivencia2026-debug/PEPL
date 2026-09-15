export interface HeldChange { pendingId: string; approvalRequestId: string; chain: string }
export function ApprovalSubmission({ changes }: { changes: HeldChange[] }) {
  const chainLabel = (chain: string) => ({ manager: 'manager', manager_then_hr: 'manager then HR', manager_hr_finance: 'manager then HR then finance', hr_only: 'HR', manager_dept_head: 'manager then department head', dept_head_hr: 'department head then HR' }[chain] ?? chain.replaceAll('_', ' '))
  return <section className="approval-submission" role="status"><h3>Sent for approval</h3><p>The change will apply when the final approval step completes. Rejection or withdrawal leaves the current record unchanged.</p>{changes.map(change => <p key={change.pendingId}>Sent for approval → {chainLabel(change.chain)}<small>Request {change.approvalRequestId}</small></p>)}</section>
}
