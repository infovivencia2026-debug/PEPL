import { useEffect, useState, type FormEvent } from 'react'
import { domainApi } from './domainApi'
import { dateLabel, money, pretty } from './api'
import type { Workspace } from './types'
import { Button, Card, Empty, ErrorBox, Modal } from './ui'

interface Loan { id: string; kind: string; principal_paise: string; annual_interest_pct: string; instalments: number; instalment_paise: string; starts_on: string; status: string; total_paise: number; repaid_paise: number; balance_paise: number; instalments_taken: number }
type Action = { type: 'grant' } | { type: 'repay' | 'close'; loan: Loan }
export function LoansPanel({ id, data }: { id: string; data: Workspace }) {
  const [loans, setLoans] = useState<Loan[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0), [closed, setClosed] = useState(false), [action, setAction] = useState<Action | null>(null), [message, setMessage] = useState('')
  const [kind, setKind] = useState('advance'), [principal, setPrincipal] = useState(''), [rate, setRate] = useState('0'), [term, setTerm] = useState('5')
  const [preview, setPreview] = useState<{ totalPaise: number; instalmentPaise: number } | null>(null), [previewError, setPreviewError] = useState('')
  const canWrite = data.permissions.includes('compensation.write'), canPreview = data.permissions.includes('compensation.read')
  useEffect(() => {
    let active = true; setLoading(true); setError('')
    domainApi<{ loans: Loan[] }>(`/employees/${id}/loans?includeClosed=${closed}`).then(result => { if (active) setLoans(result.loans) }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [id, closed, revision])
  useEffect(() => {
    let active = true; setPreview(null); setPreviewError('')
    if (action?.type !== 'grant' || !canPreview || !(Number(principal) > 0) || Number(term) < 1 || Number(term) > (kind === 'advance' ? 12 : 120)) return
    const timer = setTimeout(() => {
      domainApi<{ totalPaise: number; instalmentPaise: number }>(`/loans/schedule-preview?principalPaise=${Math.round(Number(principal) * 100)}&annualInterestPct=${Number(rate)}&instalments=${Number(term)}`).then(result => { if (active) setPreview(result) }).catch(e => { if (active) setPreviewError(e.message) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [action, principal, rate, term, kind, canPreview])
  function begin(next: Action) { setAction(next); setError(''); setPrincipal(''); setRate('0'); setTerm('5'); setKind('advance'); setPreview(null) }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!action) return; setBusy(true); setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>
    try {
      if (action.type === 'grant') await domainApi(`/employees/${id}/loans`, { kind, principalPaise: Math.round(Number(principal) * 100), annualInterestPct: Number(rate), instalments: Number(term), startsOn: values.startsOn, ...(values.disbursedOn ? { disbursedOn: values.disbursedOn } : {}), reason: values.reason })
      else if (action.type === 'repay') await domainApi(`/loans/${action.loan.id}/repay`, { amountPaise: Math.round(Number(values.amount) * 100), note: values.note })
      else await domainApi(`/loans/${action.loan.id}/close`, { status: values.status, reason: values.reason })
      setMessage(action.type === 'grant' ? 'Loan granted. Recovery begins automatically in the selected payroll period.' : action.type === 'repay' ? 'Outside-payroll repayment recorded.' : 'Loan closed.'); setAction(null); setRevision(value => value + 1)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <><Card title="Loans & advances">
    {canWrite && <div className="header-actions"><Button onClick={() => begin({ type: 'grant' })}>Grant loan / advance</Button></div>}
    <label className="checkbox-field"><input type="checkbox" checked={closed} onChange={e => setClosed(e.target.checked)} />Show closed loans</label>{message && <p role="status">{message}</p>}{error && !action && <ErrorBox message={error} />}
    <p>Payroll recovers one instalment per freeze. The final payroll run recovers the outstanding balance automatically.</p>
    {loading ? <p role="status">Loading balances…</p> : loans.length ? <div className="loan-grid">{loans.map(loan => <article key={loan.id} className="loan-balance"><header><strong>{pretty(loan.kind)}</strong><span>{pretty(loan.status)}</span></header><h3>{money(String(loan.balance_paise))}</h3><small>Outstanding balance</small><p>{loan.instalments_taken} of {loan.instalments} instalments taken</p><dl><div><dt>Principal</dt><dd>{money(loan.principal_paise)}</dd></div><div><dt>Instalment</dt><dd>{money(loan.instalment_paise)}</dd></div><div><dt>Repaid</dt><dd>{money(String(loan.repaid_paise))}</dd></div><div><dt>Recovery from</dt><dd>{dateLabel(loan.starts_on)}</dd></div></dl>{canWrite && loan.status === 'active' && <footer><Button variant="secondary" onClick={() => begin({ type: 'repay', loan })}>Record repayment</Button><Button variant="ghost" onClick={() => begin({ type: 'close', loan })}>Close loan</Button></footer>}</article>)}</div> : !error && <Empty title="No loans or advances" text="Live balances and instalment progress will appear here." />}
  </Card>{action && <Modal title={action.type === 'grant' ? 'Grant loan or advance' : action.type === 'repay' ? 'Record outside-payroll repayment' : 'Close loan'} onClose={() => { if (!busy) setAction(null) }}><form className="lifecycle-form" onSubmit={submit}>
    {action.type === 'grant' ? <><label>Kind<select value={kind} onChange={e => { setKind(e.target.value); if (e.target.value === 'advance' && Number(term) > 12) setTerm('12') }}><option value="advance">Salary advance</option><option value="loan">Loan</option></select></label><label>Principal (₹)<input required type="number" min="0.01" step="0.01" value={principal} onChange={e => setPrincipal(e.target.value)} /></label><label>Annual interest (%)<input required type="number" min="0" max="36" step="0.01" value={rate} onChange={e => setRate(e.target.value)} /></label><label>Instalments<input required type="number" min="1" max={kind === 'advance' ? 12 : 120} step="1" value={term} onChange={e => setTerm(e.target.value)} /></label><label>Recovery starts on<input name="startsOn" required type="date" defaultValue={data.today} /></label><label>Disbursed on<input name="disbursedOn" type="date" defaultValue={data.today} /></label><label>Reason<input name="reason" maxLength={2000} /></label><section className="salary-preview" aria-live="polite"><h3>Schedule preview</h3>{preview ? <p>{money(String(preview.instalmentPaise))} per instalment · {money(String(preview.totalPaise))} total repayment</p> : <p>{canPreview ? 'Enter principal and term to preview recovery.' : 'Schedule preview requires compensation.read.'}</p>}{previewError && <ErrorBox message={previewError} />}</section></> : action.type === 'repay' ? <><p>Outstanding {money(String(action.loan.balance_paise))}. Record money already received outside payroll.</p><label>Amount received (₹)<input name="amount" type="number" required min="0.01" max={action.loan.balance_paise / 100} step="0.01" /></label><label>Payment reference / note<input name="note" maxLength={2000} /></label></> : <><p>Outstanding balance: {money(String(action.loan.balance_paise))}. Closing stops future payroll recovery.</p><label>Close as<select name="status" required><option value="written_off">Written off</option><option value="cancelled">Cancelled</option></select></label><label>Reason<input name="reason" required maxLength={2000} /></label></>}
    {error && <ErrorBox message={error} />}<footer className="modal-actions"><Button variant="secondary" type="button" disabled={busy} onClick={() => setAction(null)}>Cancel</Button><Button disabled={busy || (action.type === 'grant' && canPreview && !preview)}>{busy ? 'Saving…' : action.type === 'grant' ? 'Grant and start automatic recovery' : action.type === 'repay' ? 'Record repayment' : 'Confirm closure'}</Button></footer>
  </form></Modal>}</>
}
