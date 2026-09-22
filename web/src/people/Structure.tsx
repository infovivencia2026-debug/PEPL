/**
 * People structure: probation reviews, the org chart, positions and seats,
 * profile-change requests. Each is a thin, honest view over its API — the
 * decisions (confirm / extend / separate, approve a change) go straight to
 * the domain routes and the page reloads what changed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronDown, ChevronRight, Search, UserRoundCheck } from 'lucide-react'
import { domainApi } from '../domainApi'
import { fullName, dateLabel } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'

// ── probation ────────────────────────────────────────────────────────────────

interface Review { id: string; employee_id: string; probation_end: string; reviewer_employee_id: string | null; status: string; rating: number | null; remarks: string | null; extended_to: string | null; letter_id: string | null }

export function ProbationPage({ data }: { data: Workspace }) {
  const [reviews, setReviews] = useState<Review[] | null>(null)
  const [error, setError] = useState('')
  const [status, setStatus] = useState('pending')
  const [decide, setDecide] = useState<{ id: string; decision: 'confirm' | 'extend' | 'separate' } | null>(null)
  const [form, setForm] = useState({ rating: '4', remarks: '', extendedTo: '', issueLetter: true })
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => { try { setReviews((await domainApi<{ reviews: Review[] }>(`/probation/reviews?status=${status}`)).reviews) } catch (e) { setError((e as Error).message) } }, [status])
  useEffect(() => { void load() }, [load])
  const who = (id: string) => data.employees.find((e) => e.id === id)
  async function submit() {
    if (!decide) return
    setBusy(true); setError('')
    try {
      await domainApi(`/probation/reviews/${decide.id}/decide`, { decision: decide.decision, rating: Number(form.rating) || undefined, remarks: form.remarks || undefined, extendedTo: decide.decision === 'extend' ? form.extendedTo : undefined, issueLetter: form.issueLetter })
      setDecide(null); setForm({ rating: '4', remarks: '', extendedTo: '', issueLetter: true }); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="filter-bar">
        <label className="field compact"><span className="sr-only">Status</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)}>{['pending', 'confirmed', 'extended', 'separated'].map((s) => <option key={s} value={s}>{s[0]!.toUpperCase() + s.slice(1)}</option>)}</select>
        </label>
        {data.permissions.includes('employee.write') && <Button variant="secondary" onClick={async () => { await domainApi('/probation/reviews/open-due', { daysAhead: 30 }); await load() }}>Open reviews due in 30 days</Button>}
      </div>
      {error && <ErrorBox message={error} />}
      {!reviews ? <Skeleton /> : !reviews.length ? <Card><Empty title={`No ${status} reviews`} text={status === 'pending' ? 'A review opens automatically before each probation ends.' : 'Nothing here for this filter.'} /></Card> : (
        <div className="approval-grid">
          {reviews.map((r) => {
            const e = who(r.employee_id), rv = r.reviewer_employee_id ? who(r.reviewer_employee_id) : null
            const daysLeft = Math.round((Date.parse(r.probation_end) - Date.parse(data.today)) / 86_400_000)
            return (
              <Card key={r.id} className="approval-card">
                <div className="approval-full-head">
                  <span className="person-line"><span><strong>{e ? fullName(e) : 'Employee'}</strong><small>{e?.designation ?? ''}{e?.department ? ` · ${e.department}` : ''}</small></span></span>
                  <Badge>{r.status}</Badge>
                </div>
                <div className="request-details">
                  <span>Probation ends {dateLabel(r.probation_end)}{r.status === 'pending' ? ` · ${daysLeft < 0 ? `${-daysLeft} days ago` : `in ${daysLeft} days`}` : ''}</span>
                  {rv && <span>Reviewer {fullName(rv)}</span>}
                  {r.extended_to && <span>Extended to {dateLabel(r.extended_to)}</span>}
                </div>
                {r.remarks && <blockquote>{r.remarks}</blockquote>}
                {r.status === 'pending' && decide?.id !== r.id && (
                  <div className="decision-actions">
                    <Button onClick={() => setDecide({ id: r.id, decision: 'confirm' })}><UserRoundCheck size={16} aria-hidden="true" />Confirm</Button>
                    <Button variant="secondary" onClick={() => setDecide({ id: r.id, decision: 'extend' })}>Extend</Button>
                    <Button variant="danger" onClick={() => setDecide({ id: r.id, decision: 'separate' })}>Separate</Button>
                  </div>
                )}
                {decide?.id === r.id && (
                  <form className="decide-form" onSubmit={(ev) => { ev.preventDefault(); void submit() }}>
                    <p className="step-title">{decide.decision === 'confirm' ? 'Confirm employment' : decide.decision === 'extend' ? 'Extend probation' : 'Separate'}</p>
                    <div className="two-up">
                      <label className="field"><span>Rating (1–5)</span><input type="number" min={1} max={5} value={form.rating} onChange={(ev) => setForm({ ...form, rating: ev.target.value })} /></label>
                      {decide.decision === 'extend' && <label className="field"><span>Extend to</span><input type="date" required min={r.probation_end} value={form.extendedTo} onChange={(ev) => setForm({ ...form, extendedTo: ev.target.value })} /></label>}
                    </div>
                    <label className="field"><span>Remarks</span><textarea rows={2} value={form.remarks} onChange={(ev) => setForm({ ...form, remarks: ev.target.value })} placeholder={decide.decision === 'confirm' ? 'Met every objective; confirmed.' : 'What needs to improve, and by when'} /></label>
                    {decide.decision !== 'separate' && <label className="check"><input type="checkbox" checked={form.issueLetter} onChange={(ev) => setForm({ ...form, issueLetter: ev.target.checked })} /> Issue the {decide.decision === 'confirm' ? 'confirmation' : 'extension'} letter</label>}
                    <div className="decision-actions"><Button disabled={busy} variant={decide.decision === 'separate' ? 'danger' : 'primary'}>{busy ? 'Saving…' : 'Record decision'}</Button><Button type="button" variant="ghost" onClick={() => setDecide(null)}>Cancel</Button></div>
                  </form>
                )}
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}

// ── org chart ────────────────────────────────────────────────────────────────

interface ChartNode { employeeId: string; name: string; employeeNumber: string; designation: string | null; department: string | null; directReports: number; reports: ChartNode[] }

export function OrgChartPage() {
  const [chart, setChart] = useState<{ roots: ChartNode[]; total: number; unplaced: number } | null>(null)
  const [error, setError] = useState('')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Set<string>>(new Set())
  useEffect(() => { domainApi<typeof chart>('/org/chart').then((c) => { setChart(c); setOpen(new Set(c?.roots.map((r) => r.employeeId) ?? [])) }).catch((e: Error) => setError(e.message)) }, [])
  const matches = useMemo(() => {
    if (!q.trim() || !chart) return new Set<string>()
    const hit = new Set<string>(); const needle = q.toLowerCase()
    const walk = (n: ChartNode, path: string[]): void => { const here = [...path, n.employeeId]; if (`${n.name} ${n.designation ?? ''} ${n.department ?? ''}`.toLowerCase().includes(needle)) here.forEach((id) => hit.add(id)); n.reports.forEach((r) => walk(r, here)) }
    chart.roots.forEach((r) => walk(r, [])); return hit
  }, [q, chart])
  useEffect(() => { if (matches.size) setOpen((o) => new Set([...o, ...matches])) }, [matches])
  if (error) return <ErrorBox message={error} />
  if (!chart) return <Skeleton />
  const Node = ({ n, depth }: { n: ChartNode; depth: number }) => {
    const isOpen = open.has(n.employeeId), hit = q.trim() && matches.has(n.employeeId)
    return (
      <li className={hit ? 'hit' : ''}>
        <div className="org-node" style={{ ['--depth' as string]: depth }}>
          {n.reports.length ? (
            <button type="button" className="org-toggle" aria-expanded={isOpen} aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${n.name}`} onClick={() => setOpen((o) => { const s = new Set(o); if (s.has(n.employeeId)) s.delete(n.employeeId); else s.add(n.employeeId); return s })}>
              {isOpen ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
            </button>
          ) : <span className="org-toggle spacer" />}
          <a href={`#/people/${n.employeeId}`} className="org-card">
            <strong>{n.name}</strong>
            <small>{[n.designation, n.department].filter(Boolean).join(' · ') || n.employeeNumber}</small>
            {n.directReports > 0 && <em>{n.directReports} report{n.directReports === 1 ? '' : 's'}</em>}
          </a>
        </div>
        {isOpen && n.reports.length > 0 && <ul>{n.reports.map((r) => <Node key={r.employeeId} n={r} depth={depth + 1} />)}</ul>}
      </li>
    )
  }
  return (
    <>
      <div className="filter-bar">
        <label className="field compact search"><Search size={15} aria-hidden="true" /><span className="sr-only">Find a person</span><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person, title or team" /></label>
        <span className="subtle">{chart.total} people</span>
        <Button variant="ghost" onClick={() => setOpen(new Set())}>Collapse all</Button>
      </div>
      {chart.unplaced > 0 && <div className="bulk-result partial" role="status"><strong>{chart.unplaced} without a manager.</strong><span> They do not appear under anyone; set a reporting manager on their profile.</span></div>}
      <Card>
        {chart.roots.length ? <ul className="org-tree">{chart.roots.map((r) => <Node key={r.employeeId} n={r} depth={0} />)}</ul> : <Empty title="No reporting lines yet" text="Set managers on profiles and the chart draws itself." />}
      </Card>
    </>
  )
}

// ── positions ────────────────────────────────────────────────────────────────

interface Position { id: string; code: string; title: string; department: string; designation: string; location_code: string | null; seats: number; status: string; filled: number }

export function PositionsPage({ data }: { data: Workspace }) {
  const [positions, setPositions] = useState<Position[] | null>(null)
  const [head, setHead] = useState<{ seats: number; filled: number; vacant: number } | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ code: '', title: '', department: '', designation: '', locationCode: '', seats: '1' })
  const canManage = data.permissions.includes('employee.write')
  const load = useCallback(async () => { try { setPositions((await domainApi<{ positions: Position[] }>('/positions')).positions); setHead(await domainApi('/positions/headcount')) } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  async function save() { try { await domainApi('/positions', { ...form, seats: Number(form.seats) }); setAdding(false); setForm({ code: '', title: '', department: '', designation: '', locationCode: '', seats: '1' }); await load() } catch (e) { setError((e as Error).message) } }
  async function setStatus(id: string, status: string) { try { await domainApi(`/positions/${id}/status`, { status }); await load() } catch (e) { setError((e as Error).message) } }
  return (
    <>
      {head && (
        <div className="stats-row">
          <div className="stat"><small>Seats</small><strong>{head.seats}</strong></div>
          <div className="stat"><small>Filled</small><strong>{head.filled}</strong></div>
          <div className="stat"><small>Vacant</small><strong>{head.vacant}</strong></div>
        </div>
      )}
      <div className="row-actions">{canManage && <Button onClick={() => setAdding((a) => !a)}>{adding ? 'Close' : 'New position'}</Button>}</div>
      {adding && (
        <Card>
          <form className="template-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
            <div className="two-up">
              <label className="field"><span>Code</span><input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} placeholder="ENG-DEV" /></label>
              <label className="field"><span>Title</span><input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Developer" /></label>
            </div>
            <div className="two-up">
              <label className="field"><span>Department</span><input required value={form.department} onChange={(e) => setForm({ ...form, department: e.target.value })} /></label>
              <label className="field"><span>Designation</span><input required value={form.designation} onChange={(e) => setForm({ ...form, designation: e.target.value })} /></label>
            </div>
            <div className="two-up">
              <label className="field"><span>Location code</span><input value={form.locationCode} onChange={(e) => setForm({ ...form, locationCode: e.target.value })} /></label>
              <label className="field"><span>Seats</span><input type="number" min={1} max={999} required value={form.seats} onChange={(e) => setForm({ ...form, seats: e.target.value })} /></label>
            </div>
            <div className="decision-actions"><Button>Save position</Button></div>
          </form>
        </Card>
      )}
      {error && <ErrorBox message={error} />}
      {!positions ? <Skeleton /> : !positions.length ? <Card><Empty title="No positions yet" text="A position is a budgeted seat: code, title, department, how many. People are seated into it; the vacancy count drives hiring." /></Card> : (
        <Card className="data-card">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Position</th><th>Department</th><th>Seats</th><th>Status</th>{canManage && <th></th>}</tr></thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.title}</strong><br /><small>{p.code} · {p.designation}{p.location_code ? ` · ${p.location_code}` : ''}</small></td>
                    <td>{p.department}</td>
                    <td>
                      <div className="seat-bar" aria-label={`${p.filled} of ${p.seats} seats filled`}><i style={{ width: `${Math.min(100, p.seats ? p.filled / p.seats * 100 : 0)}%` }} /></div>
                      <small>{p.filled} / {p.seats}{p.seats - p.filled > 0 ? ` · ${p.seats - p.filled} vacant` : ''}</small>
                    </td>
                    <td><Badge>{p.status}</Badge></td>
                    {canManage && <td className="row-actions">
                      {p.status === 'active' && <Button variant="ghost" onClick={() => void setStatus(p.id, 'frozen')}>Freeze</Button>}
                      {p.status === 'frozen' && <Button variant="ghost" onClick={() => void setStatus(p.id, 'active')}>Reopen</Button>}
                      {p.status !== 'closed' && <Button variant="ghost" disabled={p.filled > 0} title={p.filled > 0 ? 'Move the people out first' : undefined} onClick={() => void setStatus(p.id, 'closed')}>Close</Button>}
                    </td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  )
}

// ── profile-change requests ──────────────────────────────────────────────────

interface ChangeRequest { id: string; employee_id: string; changes: Record<string, unknown>; evidence_document_id: string | null; note: string | null; status: string; decision_note: string | null; created_at: string }
const FIELD_LABEL: Record<string, string> = { lastName: 'Last name', dateOfBirth: 'Date of birth', gender: 'Gender', personalEmail: 'Personal email', phone: 'Phone', address: 'Address', emergencyContact: 'Emergency contact' }

export function RequestsPage({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<ChangeRequest[] | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState<Record<string, string>>({})
  const load = useCallback(async () => { try { setRows((await domainApi<{ requests: ChangeRequest[] }>('/profile-changes?status=pending')).requests) } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  async function decide(id: string, approve: boolean) {
    try { await domainApi(`/profile-changes/${id}/decide`, { approve, note: note[id] || undefined }); await load() } catch (e) { setError((e as Error).message) }
  }
  return (
    <>
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : !rows.length ? <Card><Empty title="No profile changes waiting" text="When someone asks to correct a locked field on their profile, it lands here with the evidence." /></Card> : (
        <div className="approval-grid">
          {rows.map((r) => {
            const e = data.employees.find((x) => x.id === r.employee_id)
            return (
              <Card key={r.id} className="approval-card">
                <div className="approval-full-head"><strong>{e ? fullName(e) : 'Employee'}</strong><span className="age">asked {dateLabel(r.created_at)}</span></div>
                <dl className="diff">
                  {Object.entries(r.changes).map(([k, v]) => <div key={k}><dt>{FIELD_LABEL[k] ?? k}</dt><dd>{typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}
                </dl>
                {r.note && <blockquote>{r.note}</blockquote>}
                {r.evidence_document_id && <Button variant="ghost" onClick={async () => { const d = await domainApi<{ file_name: string; content_type: string; contentBase64: string }>(`/documents/${r.evidence_document_id}/content`); const { downloadFile, decodeBase64 } = await import('../domainApi'); downloadFile(d.file_name, d.content_type, decodeBase64(d.contentBase64)) }}>Open evidence</Button>}
                <label className="field"><span className="sr-only">Note</span><input placeholder="Note to the employee (required to reject)" value={note[r.id] ?? ''} onChange={(ev) => setNote({ ...note, [r.id]: ev.target.value })} /></label>
                <div className="decision-actions">
                  <Button onClick={() => void decide(r.id, true)}>Approve into the record</Button>
                  <Button variant="danger" disabled={!(note[r.id] ?? '').trim()} onClick={() => void decide(r.id, false)}>Reject</Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </>
  )
}
