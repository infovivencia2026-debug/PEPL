import { useEffect, useState, type FormEvent } from 'react'
import { domainApi } from './domainApi'
import { money } from './api'
import { ApprovalSubmission, type HeldChange } from './ApprovalSubmission'
import type { Workspace } from './types'
import { Button, ErrorBox, Modal } from './ui'

export function CompensationForm({ id, data, onClose, onChanged }: { id: string; data: Workspace; onClose: () => void; onChanged: () => void }) {
  const [structures, setStructures] = useState<{ code: string; name: string }[]>([])
  const [components, setComponents] = useState<{ code: string; name: string }[]>([])
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [annual, setAnnual] = useState(''), [structure, setStructure] = useState(''), [effective, setEffective] = useState(data.today), [reason, setReason] = useState('')
  const [amounts, setAmounts] = useState<Record<string, string>>({}), [preview, setPreview] = useState<{ monthlyComponents: Record<string, number>; monthlyTotalPaise: number } | null>(null)
  const [held, setHeld] = useState<HeldChange[]>([])
  useEffect(() => {
    let active = true
    Promise.all([domainApi<{ structures: { code: string; name: string }[] }>('/salary/structures'), domainApi<{ components: { code: string; name: string }[] }>('/salary/components')]).then(([s, c]) => {
      if (active) { setStructures(s.structures); setComponents(c.components.length ? c.components : [{ code: 'basic', name: 'Basic' }, { code: 'hra', name: 'House rent allowance' }, { code: 'special', name: 'Special allowance' }]); setStructure(s.structures[0]?.code ?? '') }
    }).catch(e => { if (active) setError(e.message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => {
    let active = true; setPreview(null)
    if (!structure || !(Number(annual) > 0)) return
    const timer = setTimeout(() => {
      domainApi<{ monthlyComponents: Record<string, number>; monthlyTotalPaise: number }>(`/salary/structures/${encodeURIComponent(structure)}/preview?annualPaise=${Math.round(Number(annual) * 100)}`).then(result => { if (active) { setPreview(result); setError('') } }).catch(e => { if (active) setError(e.message) })
    }, 250)
    return () => { active = false; clearTimeout(timer) }
  }, [structure, annual])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    try {
      const result = await domainApi<{ held?: boolean; pendingId: string; approvalRequestId: string; chain: string }>(`/employees/${id}/compensation`, {
        annualCtcPaise: Math.round(Number(annual) * 100), effectiveFrom: effective, reason,
        ...(structure ? { structureCode: structure } : { components: Object.fromEntries(Object.entries(amounts).filter(([, value]) => Number(value) > 0).map(([code, value]) => [code, Math.round(Number(value) * 100)])) }),
      })
      if (result.held) setHeld([result])
      else { onChanged(); onClose() }
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const periodStart = data.periods.find(period => period.period_start <= data.today && period.period_end >= data.today)?.period_start ?? `${data.today.slice(0, 7)}-01`
  return <Modal title="Record salary revision" onClose={() => { if (!busy) onClose() }}>{held.length ? <><ApprovalSubmission changes={held} /><footer className="modal-actions"><Button onClick={onClose}>Close</Button></footer></> : loading ? <p role="status">Loading salary structures…</p> : <form className="lifecycle-form" onSubmit={submit}>
    <label>Annual CTC (₹)<input required type="number" min="0.01" step="0.01" value={annual} onChange={e => setAnnual(e.target.value)} /></label>
    {structures.length > 0 && <label>Salary structure<select required value={structure} onChange={e => setStructure(e.target.value)}>{structures.map(s => <option key={s.code} value={s.code}>{s.name} · {s.code}</option>)}</select></label>}
    <label>Effective from<input required type="date" value={effective} onChange={e => setEffective(e.target.value)} /></label><label>Reason for revision<input required maxLength={2000} value={reason} onChange={e => setReason(e.target.value)} /></label>
    {effective < periodStart && <p className="form-intro">The difference for past months will be paid as arrears in the next payroll.</p>}
    {structures.length ? <section className="salary-preview" aria-live="polite"><h3>Monthly breakdown</h3>{preview ? <><dl>{Object.entries(preview.monthlyComponents).map(([code, value]) => <div key={code}><dt>{code}</dt><dd>{money(String(value))}</dd></div>)}</dl><strong>Total {money(String(preview.monthlyTotalPaise))}</strong></> : <p>Enter annual CTC to preview this structure.</p>}</section> : <section className="salary-preview"><h3>Monthly components (₹)</h3><p>No structures exist yet. Enter the recorded monthly breakdown.</p>{components.map(component => <label key={component.code}>{component.name}<input type="number" min="0" step="0.01" value={amounts[component.code] ?? ''} onChange={e => setAmounts(previous => ({ ...previous, [component.code]: e.target.value }))} /></label>)}</section>}
    {error && <ErrorBox message={error} />}<footer className="modal-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || (structures.length > 0 ? !preview : !Object.values(amounts).some(value => Number(value) > 0))}> {busy ? 'Submitting…' : 'Submit revision'}</Button></footer>
  </form>}</Modal>
}
