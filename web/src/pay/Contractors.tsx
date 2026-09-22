/**
 * Contractors: people paid on invoice, never through the payroll run. Terms
 * carry PAN, the TDS section and a rate; an invoice prices itself and shows
 * the TDS before anyone approves it. The 26Q register names missing PANs,
 * because a missing PAN is a 20% deduction, not a blank field.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, IndianRupee, Plus, TriangleAlert } from 'lucide-react'
import { domainApi } from '../domainApi'
import { fullName, money, dateLabel } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Terms { employee_id: string; employee_name: string; employee_number: string; pan: string | null; gstin: string | null; entity_type: string; tds_section: string; tds_rate_pct: string | null; rate_type: string; rate_paise: string; invoice_required: boolean; contract_start: string | null; contract_end: string | null }
interface Invoice { id: string; employee_id: string; employee_name: string; invoice_no: string; invoice_date: string; period_start: string; period_end: string; amount_paise: string; gst_paise: string; tds_section: string; tds_rate_pct: string; tds_paise: string; net_paise: string; status: string; rejection_reason: string | null }

export function ContractorsPage({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Invoices')
  const [contractors, setContractors] = useState<Terms[] | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<Terms> | null>(null)
  const [filing, setFiling] = useState(false)
  const [busy, setBusy] = useState('')
  const canManage = data.permissions.includes('contractor.manage'), canPay = data.permissions.includes('contractor.pay')
  const load = useCallback(async () => {
    try {
      setContractors((await domainApi<{ contractors: Terms[] }>('/contractors')).contractors)
      setInvoices((await domainApi<{ invoices: Invoice[] }>('/contractor-invoices')).invoices)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])
  async function decide(inv: Invoice, status: 'approved' | 'rejected') {
    const reason = status === 'rejected' ? window.prompt('Why is this invoice rejected?') ?? '' : undefined
    if (status === 'rejected' && !(reason ?? '').trim()) return
    setBusy(inv.id)
    try { await domainApi(`/contractor-invoices/${inv.id}/decide`, { status, reason }); await load() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  async function pay(inv: Invoice) {
    const ref = window.prompt('Payment reference (UTR / cheque no.)') ?? ''
    if (!ref.trim()) return
    setBusy(inv.id)
    try { await domainApi(`/contractor-invoices/${inv.id}/paid`, { paymentRef: ref }); await load() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={['Invoices', 'Contractors', '26Q register']} />
      {error && <ErrorBox message={error} />}
      {tab === 'Invoices' && (
        <>
          <div className="row-actions">{(canManage || data.user.employeeId) && <Button onClick={() => setFiling(true)}><Plus size={16} aria-hidden="true" />Record an invoice</Button>}</div>
          {!invoices.length ? <Card><Empty title="No invoices yet" text="A contractor’s fee arrives as an invoice: it prices itself from their terms, deducts TDS and waits for approval." /></Card> : (
            <Card className="data-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Invoice</th><th>Contractor</th><th>Period</th><th className="num">Fees</th><th className="num">GST</th><th className="num">TDS</th><th className="num">Net</th><th>Status</th><th></th></tr></thead>
                  <tbody>
                    {invoices.map((i) => (
                      <tr key={i.id}>
                        <td><strong>{i.invoice_no}</strong><br /><small>{dateLabel(i.invoice_date)}</small></td>
                        <td>{i.employee_name}</td>
                        <td><small>{dateLabel(i.period_start)} – {dateLabel(i.period_end)}</small></td>
                        <td className="num">{money(i.amount_paise)}</td>
                        <td className="num">{Number(i.gst_paise) ? money(i.gst_paise) : '—'}</td>
                        <td className="num">{Number(i.tds_paise) ? <>{money(i.tds_paise)}<br /><small>{i.tds_section} · {Number(i.tds_rate_pct)}%</small></> : <small>below threshold</small>}</td>
                        <td className="num"><strong>{money(i.net_paise)}</strong></td>
                        <td><span className={`badge ${i.status === 'paid' ? 'green' : i.status === 'rejected' ? 'coral' : 'amber'}`}><span />{i.status}</span>{i.rejection_reason && <><br /><small>{i.rejection_reason}</small></>}</td>
                        <td className="row-actions">
                          {canManage && i.status === 'submitted' && <><Button variant="secondary" disabled={busy === i.id} onClick={() => void decide(i, 'approved')}>Approve</Button><Button variant="ghost" disabled={busy === i.id} onClick={() => void decide(i, 'rejected')}>Reject</Button></>}
                          {canPay && i.status === 'approved' && <Button disabled={busy === i.id} onClick={() => void pay(i)}><IndianRupee size={15} aria-hidden="true" />Mark paid</Button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
      {tab === 'Contractors' && (
        !contractors ? <Skeleton /> : (
          <>
            <div className="row-actions">{canManage && <Button onClick={() => setEditing({ tds_section: '194J', rate_type: 'monthly', entity_type: 'individual', invoice_required: true })}><Plus size={16} aria-hidden="true" />Add contractor terms</Button>}</div>
            {!contractors.length ? <Card><Empty title="Nobody is on contract" text="Give an existing person contractor terms — PAN, TDS section, rate — and they leave the payroll run for good." /></Card> : (
              <div className="template-grid">
                {contractors.map((c) => (
                  <Card key={c.employee_id}>
                    <div className="approval-full-head"><strong>{c.employee_name}</strong><span className="badge green"><span />{c.tds_section}</span></div>
                    <p className="subtle">{c.employee_number} · {c.entity_type}</p>
                    <dl className="diff">
                      <div><dt>PAN</dt><dd>{c.pan ?? <span className="warn-text">missing — 20% TDS</span>}</dd></div>
                      <div><dt>GSTIN</dt><dd>{c.gstin ?? '—'}</dd></div>
                      <div><dt>Rate</dt><dd>{money(c.rate_paise)} {c.rate_type}</dd></div>
                      <div><dt>Contract</dt><dd>{c.contract_end ? `to ${dateLabel(c.contract_end)}` : 'open'}</dd></div>
                    </dl>
                    {canManage && <Button variant="secondary" onClick={() => setEditing(c)}>Edit terms</Button>}
                  </Card>
                ))}
              </div>
            )}
          </>
        )
      )}
      {tab === '26Q register' && <Register26Q data={data} />}
      {editing && <TermsModal data={data} terms={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await load() }} />}
      {filing && <InvoiceModal data={data} contractors={contractors ?? []} onClose={() => setFiling(false)} onSaved={async () => { setFiling(false); await load() }} />}
    </>
  )
}

function TermsModal({ data, terms, onClose, onSaved }: { data: Workspace; terms: Partial<Terms>; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ employeeId: terms.employee_id ?? '', pan: terms.pan ?? '', gstin: terms.gstin ?? '', tdsSection: terms.tds_section ?? '194J', rateType: terms.rate_type ?? 'monthly', rate: terms.rate_paise ? String(Number(terms.rate_paise) / 100) : '', contractEnd: terms.contract_end ?? '' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const people = useMemo(() => data.employees.filter((e) => e.status !== 'exited'), [data.employees])
  async function save() {
    setBusy(true); setError('')
    try {
      await domainApi(`/contractors/${form.employeeId}`, { pan: form.pan || null, gstin: form.gstin || null, tdsSection: form.tdsSection, rateType: form.rateType, ratePaise: Math.round(Number(form.rate || 0) * 100), contractEnd: form.contractEnd || null }, 'PATCH')
      await onSaved()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title={terms.employee_id ? `Terms · ${terms.employee_name}` : 'Contractor terms'} onClose={onClose}>
      <div className="template-form">
        {!terms.employee_id && (
          <label className="field"><span>Person</span><select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}><option value="">Choose</option>{people.map((p) => <option key={p.id} value={p.id}>{fullName(p)} · {p.employee_number}</option>)}</select></label>
        )}
        <div className="two-up">
          <label className="field"><span>PAN</span><input value={form.pan} onChange={(e) => setForm({ ...form, pan: e.target.value.toUpperCase() })} placeholder="ABCPE1234F" /></label>
          <label className="field"><span>GSTIN (if registered)</span><input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} /></label>
        </div>
        <div className="two-up">
          <label className="field"><span>TDS section</span><select value={form.tdsSection} onChange={(e) => setForm({ ...form, tdsSection: e.target.value })}><option value="194J">194J · professional (10%)</option><option value="194C">194C · works contract (1/2%)</option><option value="194H">194H · commission (2%)</option><option value="none">None</option></select></label>
          <label className="field"><span>Rate type</span><select value={form.rateType} onChange={(e) => setForm({ ...form, rateType: e.target.value })}>{['monthly', 'daily', 'hourly', 'per_unit', 'fixed'].map((v) => <option key={v} value={v}>{v.replace('_', ' ')}</option>)}</select></label>
        </div>
        <div className="two-up">
          <label className="field"><span>Rate (₹)</span><input type="number" min={0} value={form.rate} onChange={(e) => setForm({ ...form, rate: e.target.value })} /></label>
          <label className="field"><span>Contract ends (optional)</span><input type="date" value={form.contractEnd} onChange={(e) => setForm({ ...form, contractEnd: e.target.value })} /></label>
        </div>
        {!form.pan && <p className="paper-note"><TriangleAlert size={14} aria-hidden="true" /> Without a PAN the law requires 20% TDS on every payment.</p>}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.employeeId} onClick={() => void save()}>{busy ? 'Saving…' : 'Save terms'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function InvoiceModal({ data, contractors, onClose, onSaved }: { data: Workspace; contractors: Terms[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ employeeId: contractors[0]?.employee_id ?? '', invoiceNo: '', invoiceDate: data.today, periodStart: data.today.slice(0, 8) + '01', periodEnd: data.today, amount: '', gst: '', description: '' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const terms = contractors.find((c) => c.employee_id === form.employeeId)
  async function save() {
    setBusy(true); setError('')
    try {
      await domainApi('/contractor-invoices', { employeeId: form.employeeId, invoiceNo: form.invoiceNo, invoiceDate: form.invoiceDate, periodStart: form.periodStart, periodEnd: form.periodEnd, description: form.description || undefined, amountPaise: form.amount ? Math.round(Number(form.amount) * 100) : undefined, gstPaise: form.gst ? Math.round(Number(form.gst) * 100) : undefined })
      await onSaved()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Record an invoice" onClose={onClose}>
      <div className="template-form">
        <label className="field"><span>Contractor</span><select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}><option value="">Choose</option>{contractors.map((c) => <option key={c.employee_id} value={c.employee_id}>{c.employee_name}</option>)}</select></label>
        <div className="two-up">
          <label className="field"><span>Invoice number</span><input value={form.invoiceNo} onChange={(e) => setForm({ ...form, invoiceNo: e.target.value })} /></label>
          <label className="field"><span>Invoice date</span><input type="date" value={form.invoiceDate} onChange={(e) => setForm({ ...form, invoiceDate: e.target.value })} /></label>
        </div>
        <div className="two-up">
          <label className="field"><span>Period from</span><input type="date" value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} /></label>
          <label className="field"><span>Period to</span><input type="date" value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} /></label>
        </div>
        <div className="two-up">
          <label className="field"><span>Fees (₹){terms?.rate_type === 'monthly' ? ' — blank uses the monthly rate' : ''}</span><input type="number" min={0} value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder={terms ? String(Number(terms.rate_paise) / 100) : ''} /></label>
          <label className="field"><span>GST (₹)</span><input type="number" min={0} value={form.gst} disabled={!terms?.gstin} title={terms?.gstin ? undefined : 'This contractor has no GSTIN on file'} onChange={(e) => setForm({ ...form, gst: e.target.value })} /></label>
        </div>
        <label className="field"><span>What it is for</span><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        {terms && <p className="subtle">TDS will be deducted under {terms.tds_section} once this financial year crosses the section’s threshold — the invoice shows the exact figure once recorded.</p>}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.employeeId || !form.invoiceNo} onClick={() => void save()}>{busy ? 'Recording…' : 'Record invoice'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function Register26Q({ data }: { data: Workspace }) {
  const [from, setFrom] = useState(`${data.today.slice(0, 4)}-04-01`)
  const [to, setTo] = useState(data.today)
  const [reg, setReg] = useState<{ rows: Array<{ employee_name: string; pan: string | null; section: string; invoices: number; amount_paise: number; tds_paise: number }>; totals: { amount_paise: number; tds_paise: number }; missingPan: string[] } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { domainApi<NonNullable<typeof reg>>(`/reports/tds-26q?from=${from}&to=${to}`).then(setReg).catch((e: Error) => setError(e.message)) }, [from, to])
  return (
    <>
      <div className="filter-bar">
        <label className="field compact"><span className="sr-only">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field compact"><span className="sr-only">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {error && <ErrorBox message={error} />}
      {!reg ? <Skeleton /> : (
        <>
          {reg.missingPan.length > 0 && <div className="bulk-result partial" role="status"><strong>PAN missing for {reg.missingPan.length}:</strong><span> {reg.missingPan.join(', ')} — 20% was deducted and the return will flag them.</span></div>}
          {!reg.rows.length ? <Card><Empty title="No TDS deducted in this window" text="Contractor payments appear here once a section’s threshold is crossed." /></Card> : (
            <Card className="data-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Deductee</th><th>PAN</th><th>Section</th><th className="num">Invoices</th><th className="num">Fees</th><th className="num">TDS</th></tr></thead>
                  <tbody>{reg.rows.map((r, i) => <tr key={i}><td>{r.employee_name}</td><td>{r.pan ?? <span className="warn-text">missing</span>}</td><td>{r.section}</td><td className="num">{r.invoices}</td><td className="num">{money(r.amount_paise)}</td><td className="num">{money(r.tds_paise)}</td></tr>)}</tbody>
                  <tfoot><tr><th colSpan={4}>Total</th><th className="num">{money(reg.totals.amount_paise)}</th><th className="num">{money(reg.totals.tds_paise)}</th></tr></tfoot>
                </table>
              </div>
            </Card>
          )}
          <p className="subtle"><FileText size={14} aria-hidden="true" /> These are the figures for Form 26Q — contractor TDS, separate from salary TDS on 24Q.</p>
        </>
      )}
    </>
  )
}
