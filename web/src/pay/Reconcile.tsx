/**
 * Bank return: the file the bank sends back after a payment batch, and what
 * it means for each person. A failed payment is a person who was not paid,
 * so it says the name, not just a count.
 */
import { useCallback, useEffect, useState } from 'react'
import { Upload } from 'lucide-react'
import { domainApi } from '../domainApi'
import { money } from '../api'
import { Button, Card, Empty, ErrorBox, Modal } from '../ui'
import { parseReturnDetailed, type ReconLine } from './parseReturn'

interface Status { settled: number; failed: number; pending: number; failures: Array<{ employeeId: string; name?: string; amountPaise: string; reason: string | null }> }
export { parseReturn } from './parseReturn'

export function PaymentStatusStrip({ runId, batchId, canReconcile }: { runId: string; batchId?: string; canReconcile: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [error, setError] = useState('')
  const [uploading, setUploading] = useState(false)
  const [preview, setPreview] = useState<ReconLine[] | null>(null)
  const [skipped, setSkipped] = useState<{ rows: number; noStatus: boolean }>({ rows: 0, noStatus: false })
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { setStatus(await domainApi<Status>(`/payroll/runs/${runId}/payment-status`)); setError('') } catch (e) { setError((e as Error).message) } }, [runId])
  useEffect(() => { void load() }, [load])
  async function apply() {
    if (!preview || !batchId) return
    setBusy(true)
    try { await domainApi(`/payments/batches/${batchId}/reconcile`, { lines: preview }); setPreview(null); setUploading(false); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (error) return <ErrorBox message={error} />
  if (!status) return null
  const total = status.settled + status.failed + status.pending
  return (
    <Card title="Money out" subtitle="What the bank did with the payments in this run.">
      <div className="pay-strip" role="img" aria-label={`${status.settled} settled, ${status.failed} failed, ${status.pending} pending`}>
        <i className="settled" style={{ width: `${total ? status.settled / total * 100 : 0}%` }} />
        <i className="failed" style={{ width: `${total ? status.failed / total * 100 : 0}%` }} />
        <i className="pending" style={{ width: `${total ? status.pending / total * 100 : 0}%` }} />
      </div>
      <ul className="pay-legend">
        <li><span className="dot settled" aria-hidden="true" />{status.settled} settled</li>
        <li><span className="dot failed" aria-hidden="true" />{status.failed} failed</li>
        <li><span className="dot pending" aria-hidden="true" />{status.pending} pending</li>
      </ul>
      {status.failures.length > 0 && (
        <div className="failure-list">
          <h4>Not paid — needs a re-pay</h4>
          <ul>{status.failures.map((f) => <li key={f.employeeId}><strong>{f.name ?? f.employeeId.slice(0, 8)}</strong> · {money(f.amountPaise)}{f.reason ? ` · ${f.reason}` : ''}</li>)}</ul>
        </div>
      )}
      {canReconcile && batchId && <Button variant="secondary" onClick={() => setUploading(true)}><Upload size={15} aria-hidden="true" />Upload bank return</Button>}
      {uploading && (
        <Modal title="Upload the bank return" wide onClose={() => { setUploading(false); setPreview(null) }}>
          <p className="subtle">The CSV your bank sends back. Columns are matched by name — reference, account, amount, status, UTR, reason — in any order.</p>
          <input type="file" accept=".csv,text/csv" aria-label="Bank return CSV" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { const p = parseReturnDetailed(await f.text()); setPreview(p.lines); setSkipped({ rows: p.unrecognised.length, noStatus: p.noStatusColumn }) } }} />
          {preview && (
            <>
              {skipped.noStatus && <p role="alert" className="form-error">This file has no status column, so nothing in it can be applied. Nobody is marked paid on the strength of silence.</p>}
              {skipped.rows > 0 && <p role="alert" className="form-error">{skipped.rows} row(s) have a blank or unrecognised status and were left out. They stay pending.</p>}
              <p><strong>{preview.filter((l) => l.status === 'settled').length}</strong> settled, <strong>{preview.filter((l) => l.status !== 'settled').length}</strong> failed or returned.</p>
              <div className="table-scroll" style={{ maxHeight: 260 }}>
                <table>
                  <thead><tr><th>Reference</th><th>Account</th><th className="num">Amount</th><th>Status</th><th>Reason</th></tr></thead>
                  <tbody>{preview.slice(0, 50).map((l, i) => <tr key={i}><td>{l.reference ?? '—'}</td><td>{l.accountNumber ?? '—'}</td><td className="num">{l.amountPaise ? money(l.amountPaise) : '—'}</td><td>{l.status}</td><td>{l.reason ?? ''}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="decision-actions"><Button disabled={busy} onClick={() => void apply()}>{busy ? 'Applying…' : `Apply ${preview.length} lines`}</Button><Button variant="ghost" onClick={() => setPreview(null)}>Choose another file</Button></div>
            </>
          )}
        </Modal>
      )}
      {!total && <Empty title="Nothing paid yet" text="Generate the bank file, pay, then upload what the bank returns." />}
    </Card>
  )
}
