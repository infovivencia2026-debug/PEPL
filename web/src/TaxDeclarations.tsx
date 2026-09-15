import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDownToLine, Check, CircleDollarSign, FileCheck2, Send, X } from 'lucide-react'
import { fullName } from './api'
import { DocumentsPanel, type DocumentMeta } from './DataTools'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import type { Workspace } from './types'
import { Button, Card, Empty, PageHeader } from './ui'

type Status = 'draft' | 'submitted' | 'verified' | 'rejected'
type Regime = 'old' | 'new'
type Declared = Record<AmountKey, number> & { metro: boolean; parentsSenior: boolean }
type Declaration = {
  id: string; employee_id: string; fiscal_year: string; regime: Regime; declared: Partial<Declared>
  status: Status; proof_document_ids: string[]; rejection_reason: string | null; updated_at: string
}
type AmountKey = 'section80cPaise' | 'section80ccd1bPaise' | 'section80dSelfPaise' | 'section80dParentsPaise' | 'section80ePaise' | 'section24bPaise' | 'section80gPaise' | 'rentPaidAnnualPaise'
type Amounts = Record<AmountKey, string>

const fields: { key: AmountKey; section: string; label: string; hint: string }[] = [
  { key: 'section80cPaise', section: '80C', label: '80C investments', hint: 'PF, PPF, ELSS, LIC, tuition and home-loan principal' },
  { key: 'section80ccd1bPaise', section: '80CCD(1B)', label: 'Additional NPS', hint: 'Your contribution beyond the 80C limit' },
  { key: 'section80dSelfPaise', section: '80D', label: 'Health insurance — self & family', hint: 'Annual eligible premium' },
  { key: 'section80dParentsPaise', section: '80D parents', label: 'Health insurance — parents', hint: 'The cap changes when either parent is 60+' },
  { key: 'section80ePaise', section: '80E', label: 'Education-loan interest', hint: 'Interest paid during the year' },
  { key: 'section24bPaise', section: '24(b)', label: 'Home-loan interest', hint: 'Self-occupied property' },
  { key: 'section80gPaise', section: '80G', label: 'Donations', hint: 'Recorded here; claimed in your personal return' },
  { key: 'rentPaidAnnualPaise', section: 'HRA', label: 'Annual rent paid', hint: 'Payroll calculates the final HRA exemption at freeze' },
]
const emptyAmounts = Object.fromEntries(fields.map(field => [field.key, ''])) as Amounts
const rupees = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100)
const fiscalYear = (date = new Date()) => {
  const start = date.getMonth() >= 3 ? date.getFullYear() : date.getFullYear() - 1
  return `${start}-${String(start + 1).slice(-2)}`
}
const toPaise = (value: string) => Math.max(0, Math.round((Number(value.replace(/,/g, '')) || 0) * 100))

function StatusStepper({ status }: { status: Status }) {
  const stages: Status[] = ['draft', 'submitted', 'verified']
  const active = status === 'rejected' ? 1 : stages.indexOf(status)
  return <ol className="declaration-stepper" aria-label={`Declaration status: ${status}`}>
    {stages.map((stage, index) => <li key={stage} className={index < active ? 'complete' : index === active ? 'current' : ''} aria-current={index === active ? 'step' : undefined}><span>{index < active ? <Check size={13} /> : index + 1}</span>{stage}</li>)}
    {status === 'rejected' && <li className="rejected"><span><X size={13} /></span>Rejected — edit and resubmit</li>}
  </ol>
}

function previewFor(amounts: Amounts, regime: Regime, parentsSenior: boolean) {
  const values = Object.fromEntries(fields.map(field => [field.key, toPaise(amounts[field.key])])) as Record<AmountKey, number>
  const caps: Partial<Record<AmountKey, number>> = {
    section80cPaise: 150_000_00, section80ccd1bPaise: 50_000_00, section80dSelfPaise: 25_000_00,
    section80dParentsPaise: parentsSenior ? 50_000_00 : 25_000_00, section24bPaise: 200_000_00,
  }
  return fields.map(field => {
    const declaredPaise = values[field.key]
    let allowedPaise = regime === 'new' || field.key === 'section80gPaise' || field.key === 'rentPaidAnnualPaise' ? 0 : Math.min(declaredPaise, caps[field.key] ?? declaredPaise)
    let note = ''
    if (regime === 'new') note = 'Not available under the new regime'
    else if (field.key === 'section80gPaise') note = 'Claim in your personal return'
    else if (field.key === 'rentPaidAnnualPaise') note = 'Final exemption uses salary facts at payroll freeze'
    else if (allowedPaise < declaredPaise) note = `Capped at ${rupees(allowedPaise)}`
    return { ...field, declaredPaise, allowedPaise, note }
  })
}

export function MyTaxDeclaration({ data }: { data: Workspace }) {
  const fy = fiscalYear()
  const [declaration, setDeclaration] = useState<Declaration | null>(null)
  const [regime, setRegime] = useState<Regime>('new')
  const [amounts, setAmounts] = useState<Amounts>(emptyAmounts)
  const [metro, setMetro] = useState(false)
  const [parentsSenior, setParentsSenior] = useState(false)
  const [proofs, setProofs] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    const result = await domainApi<{ declaration: Declaration | null }>(`/tax-declarations/me?fy=${fy}`)
    setDeclaration(result.declaration)
    if (result.declaration) {
      setRegime(result.declaration.regime)
      setAmounts(Object.fromEntries(fields.map(field => [field.key, result.declaration?.declared[field.key] ? String(Number(result.declaration.declared[field.key]) / 100) : ''])) as Amounts)
      setMetro(Boolean(result.declaration.declared.metro)); setParentsSenior(Boolean(result.declaration.declared.parentsSenior))
      setProofs(result.declaration.proof_document_ids)
    }
  }, [fy])
  useEffect(() => { void load().catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load your declaration')) }, [load])
  const preview = useMemo(() => previewFor(amounts, regime, parentsSenior), [amounts, regime, parentsSenior])
  const total = preview.reduce((sum, line) => sum + line.allowedPaise, 0)

  const save = async () => {
    setBusy(true); setError(''); setNotice('')
    try {
      await domainApi('/tax-declarations/me', { fiscalYear: fy, regime, declared: { ...Object.fromEntries(fields.map(field => [field.key, toPaise(amounts[field.key])])), metro, parentsSenior }, proofDocumentIds: proofs }, 'PATCH')
      await load(); setNotice('Draft saved. Payroll will not use it until you submit and they verify it.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save your declaration') }
    finally { setBusy(false) }
  }
  const submit = async () => {
    setBusy(true); setError(''); setNotice('')
    try { await domainApi('/tax-declarations/me/submit', { fiscalYear: fy }); await load(); setNotice('Declaration submitted to payroll for verification.') }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to submit your declaration') }
    finally { setBusy(false) }
  }

  return <>
    <PageHeader title="My tax declaration" description={`Plan your Chapter VI-A deductions for FY ${fy}.`} eyebrow="Tax planning"><span className={`status-pill status-${declaration?.status ?? 'draft'}`}>{declaration?.status ?? 'Not started'}</span></PageHeader>
    <StatusStepper status={declaration?.status ?? 'draft'} />
    {declaration?.rejection_reason && <div className="declaration-alert" role="alert"><strong>Payroll needs a change</strong><p>{declaration.rejection_reason}</p></div>}
    {declaration?.status === 'verified' && <div className="declaration-alert warning"><strong>Editing restarts verification</strong><p>Saving a verified declaration returns it to draft. Submit it again when your changes are complete.</p></div>}
    <div className="declaration-layout">
      <Card title="Your annual declaration" subtitle="Enter rupee amounts; PEPL stores exact paise values">
        <fieldset className="regime-choice"><legend>Tax regime</legend><label className={regime === 'new' ? 'active' : ''}><input type="radio" name="regime" checked={regime === 'new'} onChange={() => setRegime('new')} /><strong>New regime</strong><small>Lower slabs; these deductions do not apply</small></label><label className={regime === 'old' ? 'active' : ''}><input type="radio" name="regime" checked={regime === 'old'} onChange={() => setRegime('old')} /><strong>Old regime</strong><small>Eligible deductions reduce taxable income</small></label></fieldset>
        <div className="declaration-fields">{fields.map(field => <label key={field.key}><span><b>{field.section}</b>{field.label}<small>{field.hint}</small></span><span className="money-input"><i>₹</i><input inputMode="decimal" value={amounts[field.key]} onChange={event => setAmounts(current => ({ ...current, [field.key]: event.target.value.replace(/[^\d.,]/g, '') }))} aria-label={`${field.label} in rupees`} /></span></label>)}</div>
        <div className="declaration-checks"><label><input type="checkbox" checked={parentsSenior} onChange={event => setParentsSenior(event.target.checked)} />Parent covered is 60 or older</label><label><input type="checkbox" checked={metro} onChange={event => setMetro(event.target.checked)} />Rent is in Delhi, Mumbai, Kolkata or Chennai</label></div>
      </Card>
      <Card title="Live allowance preview" subtitle={regime === 'new' ? 'The new regime records your declaration but does not apply these deductions' : 'Declared and currently allowable amounts'}>
        <div className="preview-total"><span>Currently allowable</span><strong>{rupees(total)}</strong><small>HRA is finalised from salary facts when payroll freezes.</small></div>
        <div className="preview-lines"><div className="preview-head"><span>Section</span><span>Declared</span><span>Allowed</span></div>{preview.map(line => <div key={line.key}><strong>{line.section}</strong><span>{rupees(line.declaredPaise)}</span><span>{rupees(line.allowedPaise)}</span>{line.note && <small>{line.note}</small>}</div>)}</div>
      </Card>
    </div>
    {data.user.employeeId && <DocumentsPanel ownerType="employee" ownerId={data.user.employeeId} canWrite={data.permissions.includes('document.write')} category="tax proof" selectedIds={proofs} onSelectionChange={setProofs} />}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}
    <div className="declaration-actions"><Button variant="secondary" disabled={busy} onClick={() => void save()}><FileCheck2 size={16} />{busy ? 'Saving…' : 'Save draft'}</Button><Button disabled={busy || !declaration || !['draft', 'rejected'].includes(declaration.status)} onClick={() => void submit()}><Send size={16} />Submit for verification</Button></div>
  </>
}

export function TaxDeclarationsQueue({ data }: { data: Workspace }) {
  const fy = fiscalYear()
  const [status, setStatus] = useState<Status | 'all'>('submitted')
  const [declarations, setDeclarations] = useState<Declaration[]>([])
  const [rejecting, setRejecting] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    const query = new URLSearchParams({ fy, ...(status === 'all' ? {} : { status }) })
    const result = await domainApi<{ declarations: Declaration[] }>(`/tax-declarations?${query}`)
    setDeclarations(result.declarations)
  }, [fy, status])
  useEffect(() => { void load().catch(caught => setError(caught instanceof Error ? caught.message : 'Unable to load declarations')) }, [load])
  const employeeName = (id: string) => {
    const employee = data.employees.find(item => item.id === id)
    return employee ? fullName(employee) : `Employee ${id.slice(0, 8)}`
  }
  const decide = async (id: string, action: 'verify' | 'reject') => {
    setBusy(id); setError(''); setNotice('')
    try {
      await domainApi(`/tax-declarations/${id}/${action}`, action === 'reject' ? { reason } : {})
      setRejecting(''); setReason(''); await load(); setNotice(action === 'verify' ? 'Declaration verified for the next payroll freeze.' : 'Declaration returned to the employee.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : `Unable to ${action} declaration`) }
    finally { setBusy('') }
  }
  const proof = async (id: string) => {
    try { const result = await domainApi<DocumentMeta & { contentBase64: string }>(`/documents/${id}/content`); downloadFile(result.file_name, result.content_type, decodeBase64(result.contentBase64)) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to open proof') }
  }
  return <>
    <PageHeader title="Declarations queue" description={`Review submitted tax declarations for FY ${fy}.`} eyebrow="Payroll controls"><label className="queue-filter"><span>Status</span><select value={status} onChange={event => setStatus(event.target.value as Status | 'all')}><option value="submitted">Submitted</option><option value="verified">Verified</option><option value="rejected">Rejected</option><option value="draft">Draft</option><option value="all">All statuses</option></select></label></PageHeader>
    <div className="freeze-note"><CircleDollarSign size={19} /><p><strong>Verification applies to the next payroll freeze.</strong> It never changes a run that is already frozen or locked.</p></div>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}
    <Card>{declarations.length ? <div className="table-scroll"><table className="declaration-queue"><thead><tr><th>Employee</th><th>Regime</th><th>Status</th><th>Proofs</th><th>Updated</th><th>Decision</th></tr></thead><tbody>{declarations.map(item => <tr key={item.id}><td><strong>{employeeName(item.employee_id)}</strong><small>{Object.values(item.declared).filter(value => typeof value === 'number' && value > 0).length} declared sections</small></td><td>{item.regime === 'old' ? 'Old regime' : 'New regime'}</td><td><span className={`status-pill status-${item.status}`}>{item.status}</span>{item.rejection_reason && <small>{item.rejection_reason}</small>}</td><td>{item.proof_document_ids.length ? <div className="proof-links">{item.proof_document_ids.map((id, index) => <Button key={id} variant="ghost" onClick={() => void proof(id)}><ArrowDownToLine size={14} />Proof {index + 1}</Button>)}</div> : 'No proofs'}</td><td>{new Date(item.updated_at).toLocaleDateString('en-IN')}</td><td>{item.status === 'submitted' ? rejecting === item.id ? <div className="reject-box"><input autoFocus value={reason} onChange={event => setReason(event.target.value)} placeholder="Reason required" aria-label="Rejection reason" /><Button variant="secondary" onClick={() => { setRejecting(''); setReason('') }}>Cancel</Button><Button disabled={!reason.trim() || busy === item.id} onClick={() => void decide(item.id, 'reject')}>Reject</Button></div> : <div className="queue-actions"><Button disabled={Boolean(busy)} onClick={() => void decide(item.id, 'verify')}><Check size={15} />Verify</Button><Button variant="secondary" disabled={Boolean(busy)} onClick={() => setRejecting(item.id)}><X size={15} />Reject</Button></div> : '—'}</td></tr>)}</tbody></table></div> : <Empty title="Queue is clear" text={`No ${status === 'all' ? '' : status} declarations for FY ${fy}.`} />}</Card>
  </>
}
