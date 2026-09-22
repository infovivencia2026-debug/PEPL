/**
 * Compliance: what the company owes the state this window, whether it was
 * filed on time, and the registers an inspector asks for. Overdue is said in
 * words as well as colour; anything whose date varies by state says so.
 */
import { useCallback, useEffect, useState } from 'react'
import { CalendarClock, CircleAlert, Download, FileCheck2 } from 'lucide-react'
import { domainApi, downloadFile, decodeBase64 } from '../domainApi'
import { dateLabel } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Obligation { id: string; code: string; title: string; authority: string; period: string; due_on: string; status: string; filed_on: string | null; reference_no: string | null; produced_by: string | null; check: boolean; overdue: boolean; help?: string }
interface Score { score: number | null; due: number; filedOnTime: number; filedLate: number; overdue: number; upcoming7: number; byCode: Array<{ code: string; title: string; due: number; onTime: number; late: number; overdue: number }> }
const PRODUCES: Record<string, string> = { ecr: '#/payroll', esi: '#/payroll', pt: '#/payroll', '24q': '#/payroll', form16: '#/payroll', muster: '#/attendance/muster' }

export function CompliancePage({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Calendar')
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={['Calendar', 'Registers']} />
      {tab === 'Calendar' ? <Calendar data={data} /> : <Registers data={data} />}
    </>
  )
}

function Calendar({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<Obligation[] | null>(null)
  const [score, setScore] = useState<Score | null>(null)
  const [error, setError] = useState('')
  const [filing, setFiling] = useState<Obligation | null>(null)
  const [form, setForm] = useState({ status: 'filed', filedOn: data.today, referenceNo: '', note: '' })
  const [busy, setBusy] = useState(false)
  const canFile = data.permissions.includes('compliance.manage')
  const load = useCallback(async () => {
    try {
      const [cal, sc] = await Promise.all([domainApi<{ obligations: Obligation[] }>('/compliance/calendar'), domainApi<Score>('/compliance/score')])
      setRows(cal.obligations); setScore(sc); setError('')
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])
  async function mark() {
    if (!filing) return
    setBusy(true)
    try {
      await domainApi(`/compliance/${filing.id}/mark`, { status: form.status, filedOn: form.status === 'filed' ? form.filedOn : undefined, referenceNo: form.referenceNo || undefined, note: form.note || undefined })
      setFiling(null); setForm({ status: 'filed', filedOn: data.today, referenceNo: '', note: '' }); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      {score && (
        <div className="stats-row compliance-score">
          <div className="stat"><small>On-time score</small><strong>{score.score === null ? '—' : `${score.score}%`}</strong><span className="subtle">{score.filedOnTime} of {score.due} due</span></div>
          <div className="stat"><small>Overdue</small><strong className={score.overdue ? 'bad' : ''}>{score.overdue}</strong><span className="subtle">{score.overdue ? 'file these first' : 'nothing overdue'}</span></div>
          <div className="stat"><small>Filed late</small><strong>{score.filedLate}</strong><span className="subtle">counted against the score</span></div>
          <div className="stat"><small>Due in 7 days</small><strong>{score.upcoming7}</strong><span className="subtle">coming up</span></div>
        </div>
      )}
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : !rows.length ? <Card><Empty title="Nothing due in this window" text="Obligations are generated from what applies to this company: PF and ESI once registered, PT for your state, TDS always." /></Card> : (
        <Card className="data-card">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Due</th><th>Obligation</th><th>Period</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((o) => (
                  <tr key={o.id} className={o.overdue ? 'row-overdue' : ''}>
                    <td>
                      <strong>{dateLabel(o.due_on)}</strong>
                      {o.overdue && <small className="inline-note warn"> · overdue</small>}
                    </td>
                    <td>
                      <strong>{o.title}</strong><br />
                      <small>{o.authority}{o.check ? ' · confirm the date with your consultant' : ''}</small>
                    </td>
                    <td>{o.period}</td>
                    <td>
                      <span className={`badge ${o.status === 'filed' ? 'green' : o.status === 'not_applicable' ? 'green' : o.overdue ? 'coral' : 'amber'}`}><span />{o.status === 'not_applicable' ? 'not applicable' : o.status}</span>
                      {o.reference_no && <><br /><small>{o.reference_no}</small></>}
                    </td>
                    <td className="row-actions">
                      {o.produced_by && <a className="btn ghost" href={PRODUCES[o.produced_by] ?? '#/payroll'}><FileCheck2 size={15} aria-hidden="true" />Produce</a>}
                      {canFile && o.status !== 'filed' && <Button variant="secondary" onClick={() => setFiling(o)}>Mark filed</Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {filing && (
        <Modal title={`${filing.title} · ${filing.period}`} onClose={() => setFiling(null)}>
          <p className="subtle"><CalendarClock size={14} aria-hidden="true" /> Due {dateLabel(filing.due_on)} with {filing.authority}.</p>
          {filing.help && <p className="paper-note">{filing.help}</p>}
          <div className="template-form">
            <label className="field"><span>What happened</span>
              <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                <option value="filed">Filed</option>
                <option value="not_applicable">Not applicable this period</option>
                <option value="pending">Back to pending</option>
              </select>
            </label>
            {form.status === 'filed' && (
              <div className="two-up">
                <label className="field"><span>Filed on</span><input type="date" value={form.filedOn} onChange={(e) => setForm({ ...form, filedOn: e.target.value })} /></label>
                <label className="field"><span>Reference (TRRN, CIN, acknowledgement)</span><input value={form.referenceNo} onChange={(e) => setForm({ ...form, referenceNo: e.target.value })} /></label>
              </div>
            )}
            <label className="field"><span>{form.status === 'not_applicable' ? 'Why it does not apply (required)' : 'Note'}</span><input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
            <div className="decision-actions"><Button disabled={busy || (form.status === 'not_applicable' && !form.note.trim())} onClick={() => void mark()}>{busy ? 'Saving…' : 'Save'}</Button><Button variant="ghost" onClick={() => setFiling(null)}>Cancel</Button></div>
          </div>
        </Modal>
      )}
    </>
  )
}

function Registers({ data }: { data: Workspace }) {
  const [kind, setKind] = useState<'wage' | 'overtime' | 'leave'>('wage')
  const [month, setMonth] = useState(data.today.slice(0, 7))
  const [reg, setReg] = useState<{ columns: string[]; rows: Array<Record<string, string | number | null>> } | null>(null)
  const [error, setError] = useState('')
  const qs = kind === 'leave' ? `year=${month.slice(0, 4)}` : `month=${month}`
  const load = useCallback(async () => {
    setReg(null)
    try { setReg(await domainApi(`/reports/registers/${kind}?${qs}`)); setError('') } catch (e) { setError((e as Error).message) }
  }, [kind, qs])
  useEffect(() => { void load() }, [load])
  async function csv() {
    const r = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/reports/registers/${kind}?${qs}&format=csv`)
    downloadFile(r.fileName, r.contentType, decodeBase64(r.contentBase64))
  }
  return (
    <>
      <div className="filter-bar">
        <Tabs value={kind === 'wage' ? 'Wage register' : kind === 'overtime' ? 'Overtime register' : 'Leave register'} items={['Wage register', 'Overtime register', 'Leave register']} onChange={(v) => setKind(v.startsWith('Wage') ? 'wage' : v.startsWith('Overtime') ? 'overtime' : 'leave')} />
        <label className="field compact"><span className="sr-only">{kind === 'leave' ? 'Year' : 'Month'}</span><input type={kind === 'leave' ? 'number' : 'month'} value={kind === 'leave' ? month.slice(0, 4) : month} onChange={(e) => setMonth(kind === 'leave' ? `${e.target.value}-01` : e.target.value)} /></label>
        <Button variant="secondary" disabled={!reg?.rows.length} onClick={() => void csv()}><Download size={15} aria-hidden="true" />CSV</Button>
      </div>
      {error && <ErrorBox message={error} />}
      {!reg ? <Skeleton /> : !reg.rows.length ? <Card><Empty title="Nothing to show for this period" text="Registers are rendered from locked payroll and the attendance book — they appear once there is something in them." /></Card> : (
        <Card className="data-card">
          <div className="table-scroll">
            <table>
              <thead><tr>{reg.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
              <tbody>{reg.rows.map((r, i) => <tr key={i}>{reg.columns.map((c) => <td key={c} className={typeof r[c] === 'number' ? 'num' : ''}>{r[c] ?? ''}</td>)}</tr>)}</tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="subtle"><CircleAlert size={14} aria-hidden="true" /> Registers print from the same rows payroll locked; they cannot disagree with a payslip.</p>
    </>
  )
}
