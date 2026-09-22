/**
 * The checks step between Validate and Approve: the guards' findings on this
 * run, grouped by severity. Approval is refused while a blocking finding is
 * open, so the button says so rather than failing later.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Info, ShieldAlert, TriangleAlert } from 'lucide-react'
import { domainApi } from '../domainApi'
import { Button, Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'

export interface Finding { id: string; area: string; code: string; severity: 'blocking' | 'warning' | 'info'; run_id: string | null; employee_id: string | null; employee_name: string | null; message: string; status: string; dismiss_reason: string | null }
const ICON = { blocking: ShieldAlert, warning: TriangleAlert, info: Info } as const

export function ChecksTab({ runId, data, onChanged }: { runId: string; data: Workspace; onChanged?: () => void }) {
  const [findings, setFindings] = useState<Finding[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [reason, setReason] = useState<Record<string, string>>({})
  const canRun = data.permissions.includes('payroll.process')
  const load = useCallback(async () => {
    try { setFindings((await domainApi<{ findings: Finding[] }>(`/anomalies?area=payroll&runId=${runId}`)).findings); setError('') } catch (e) { setError((e as Error).message) }
  }, [runId])
  useEffect(() => { void load() }, [load])
  async function run() {
    setBusy('run')
    try { await domainApi(`/payroll/runs/${runId}/guards`, {}); await load(); onChanged?.() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  async function dismiss(f: Finding) {
    setBusy(f.id)
    try { await domainApi(`/anomalies/${f.id}/dismiss`, { reason: reason[f.id] }); await load(); onChanged?.() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  const open = (findings ?? []).filter((f) => f.status === 'open')
  const blocking = open.filter((f) => f.severity === 'blocking')
  return (
    <>
      <div className="journal-head">
        <span className={`balance-pill ${blocking.length ? 'bad' : open.length ? 'warn' : 'ok'}`}>
          {blocking.length ? <ShieldAlert size={15} aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}
          {blocking.length ? `${blocking.length} blocking · approval is held` : open.length ? `${open.length} to look at, none blocking` : 'Nothing found'}
        </span>
        {canRun && <Button variant="secondary" disabled={busy === 'run'} onClick={() => void run()}>{busy === 'run' ? 'Checking…' : 'Run checks'}</Button>}
      </div>
      {error && <ErrorBox message={error} />}
      {!findings ? <Skeleton /> : !findings.length ? (
        <Card><Empty title="No checks have run yet" text="Run the checks: duplicate bank accounts and PANs, leavers still paid, joiners paid in full, days beyond the calendar, and a total that moved too far from last month." /></Card>
      ) : (
        <div className="finding-list">
          {(['blocking', 'warning', 'info'] as const).map((sev) => {
            const rows = findings.filter((f) => f.severity === sev)
            if (!rows.length) return null
            const Icon = ICON[sev]
            return (
              <section key={sev} aria-label={`${sev} findings`}>
                <h3 className={`sev ${sev}`}><Icon size={16} aria-hidden="true" />{sev === 'blocking' ? 'Blocking — approval is held' : sev === 'warning' ? 'Worth a look' : 'For information'}</h3>
                {rows.map((f) => (
                  <Card key={f.id} className={`finding ${f.status !== 'open' ? 'settled' : ''}`}>
                    <div className="approval-full-head">
                      <div>
                        <strong>{f.message}</strong>
                        <small>{f.code}{f.employee_name ? ` · ${f.employee_name}` : ''}</small>
                      </div>
                      <span className={`badge ${f.status === 'open' ? (sev === 'blocking' ? 'coral' : 'amber') : 'green'}`}><span />{f.status}</span>
                    </div>
                    {f.status === 'open' && canRun && (
                      <div className="dismiss-row">
                        <label className="field"><span className="sr-only">Why is this not a problem?</span><input value={reason[f.id] ?? ''} onChange={(e) => setReason({ ...reason, [f.id]: e.target.value })} placeholder="Why is this not a problem? (kept with the run)" /></label>
                        <Button variant="secondary" disabled={busy === f.id || (reason[f.id] ?? '').trim().length < 5} onClick={() => void dismiss(f)}>Dismiss</Button>
                      </div>
                    )}
                    {f.dismiss_reason && <p className="subtle">Dismissed: “{f.dismiss_reason}”</p>}
                  </Card>
                ))}
              </section>
            )
          })}
        </div>
      )}
    </>
  )
}
