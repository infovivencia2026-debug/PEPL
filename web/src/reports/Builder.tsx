/**
 * The report builder: pick a read model, drag fields into columns or group
 * by, filter, and the preview re-runs as you go. What you can build is what
 * you are allowed to read — the catalogue itself is permission-filtered, and
 * a manager's result is already cut to their team.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BarChart3, Download, Play, Plus, Save, Trash2, X } from 'lucide-react'
import { domainApi, downloadFile, decodeBase64 } from '../domainApi'
import { dateLabel } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, PageHeader, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Field { key: string; label: string; type: 'text' | 'number' | 'money' | 'date' | 'boolean'; dimension?: boolean }
interface Model { key: string; label: string; help: string; defaultColumns: string[]; fields: Field[] }
interface Filter { field: string; op: string; value?: string }
interface Measure { field: string; fn: 'count' | 'sum' | 'avg' | 'min' | 'max' }
interface Spec { model: string; columns?: string[]; filters?: Filter[]; groupBy?: string[]; measures?: Measure[]; sort?: Array<{ field: string; dir?: 'asc' | 'desc' }>; limit?: number }
interface Result { columns: Array<{ key: string; label: string; type: string }>; rows: Array<Record<string, unknown>>; total: number; truncated: boolean }
interface Saved { id: string; name: string; description: string | null; spec: Spec; owner_name: string; shared: boolean; schedules: number }
interface Schedule { id: string; report_id: string; report_name: string; frequency: string; day_of_week: number | null; day_of_month: number | null; hour: number; recipients: string[]; status: string; next_run_on: string; last_error: string | null }

const OPS: Record<string, string[]> = {
  text: ['eq', 'neq', 'contains', 'in', 'is_null', 'not_null'],
  number: ['eq', 'gte', 'lte', 'gt', 'lt'], money: ['gte', 'lte', 'gt', 'lt'],
  date: ['gte', 'lte', 'eq'], boolean: ['eq'],
}
const OP_LABEL: Record<string, string> = { eq: 'is', neq: 'is not', contains: 'contains', in: 'is one of', gte: 'at least', lte: 'at most', gt: 'more than', lt: 'less than', is_null: 'is empty', not_null: 'is set' }

export function ReportBuilder({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Builder')
  const [models, setModels] = useState<Model[] | null>(null)
  const [spec, setSpec] = useState<Spec>({ model: '' })
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState<Saved[]>([])
  const [schedules, setSchedules] = useState<Schedule[]>([])
  const [saving, setSaving] = useState(false)
  const [scheduling, setScheduling] = useState<Saved | null>(null)
  const debounce = useRef<number>(0)
  const model = models?.find((m) => m.key === spec.model)
  const grouped = Boolean(spec.groupBy?.length || spec.measures?.length)

  const loadSaved = useCallback(async () => {
    try {
      setSaved((await domainApi<{ reports: Saved[] }>('/report-builder/saved')).reports)
      setSchedules((await domainApi<{ schedules: Schedule[] }>('/report-builder/schedules')).schedules)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => {
    domainApi<{ models: Model[] }>('/report-builder/catalogue').then((c) => { setModels(c.models); setSpec((s) => s.model ? s : { model: c.models[0]?.key ?? '' }) }).catch((e: Error) => setError(e.message))
    void loadSaved()
  }, [loadSaved])
  useEffect(() => {
    if (!spec.model) return
    window.clearTimeout(debounce.current)
    debounce.current = window.setTimeout(() => {
      domainApi<Result>('/report-builder/run', spec).then((r) => { setResult(r); setError('') }).catch((e: Error) => { setError(e.message); setResult(null) })
    }, 400)
    return () => window.clearTimeout(debounce.current)
  }, [spec])

  const toggle = (list: 'columns' | 'groupBy', key: string) => setSpec((s) => {
    const cur = new Set(s[list] ?? (list === 'columns' ? model?.defaultColumns ?? [] : []))
    if (cur.has(key)) cur.delete(key); else cur.add(key)
    return { ...s, [list]: [...cur] }
  })
  async function csv() {
    const r = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>('/report-builder/run?format=csv', spec)
    downloadFile(r.fileName, r.contentType, decodeBase64(r.contentBase64))
  }
  const chart = useMemo(() => {
    if (!grouped || !result?.rows.length) return null
    const dim = result.columns.find((c) => c.type === 'text')?.key
    const measure = result.columns.find((c) => c.type === 'number' || c.type === 'money')?.key
    if (!dim || !measure) return null
    const rows = result.rows.slice(0, 12).map((r) => ({ label: String(r[dim] ?? '—'), value: Number(r[measure] ?? 0) }))
    const max = Math.max(...rows.map((r) => r.value), 1)
    return { rows, max, measure: result.columns.find((c) => c.key === measure)?.label ?? '' }
  }, [grouped, result])

  return (
    <>
      <PageHeader title="Report builder" description="Ask your own question of your own data — and only of what you may see." eyebrow="Reports · Builder" />
      <Tabs value={tab} onChange={setTab} items={['Builder', `Saved (${saved.length})`, `Scheduled (${schedules.length})`]} />
      {error && <ErrorBox message={error} />}
      {tab === 'Builder' && (
        !models ? <Skeleton /> : !models.length ? <Card><Empty title="Nothing to build on" text="The models you may read appear here; ask an admin for the permission you need." /></Card> : (
          <div className="builder">
            <Card className="builder-models">
              <h3>What to report on</h3>
              {models.map((m) => (
                <button type="button" key={m.key} className={`model-card ${spec.model === m.key ? 'picked' : ''}`} onClick={() => { setSpec({ model: m.key }); setResult(null) }}>
                  <strong>{m.label}</strong>
                  <small>{m.help}</small>
                </button>
              ))}
            </Card>
            <Card className="builder-fields">
              <h3>Columns &amp; grouping</h3>
              {!model ? <p className="subtle">Pick a model.</p> : (
                <>
                  <ul className="field-list">
                    {model.fields.map((f) => {
                      const inCols = (spec.columns ?? model.defaultColumns).includes(f.key)
                      const inGroup = (spec.groupBy ?? []).includes(f.key)
                      return (
                        <li key={f.key}>
                          <span>{f.label}<small>{f.type}</small></span>
                          <span className="field-actions">
                            <button type="button" className={`chip ${inCols ? 'on' : ''}`} aria-pressed={inCols} onClick={() => toggle('columns', f.key)}>column</button>
                            {f.dimension && <button type="button" className={`chip ${inGroup ? 'on' : ''}`} aria-pressed={inGroup} onClick={() => toggle('groupBy', f.key)}>group</button>}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                  {grouped && (
                    <>
                      <h3>Measures</h3>
                      <ul className="field-list">
                        {(spec.measures ?? [{ field: '*', fn: 'count' as const }]).map((m, i) => (
                          <li key={i}>
                            <select value={m.fn} aria-label="Function" onChange={(e) => setSpec((s) => ({ ...s, measures: (s.measures ?? [{ field: '*', fn: 'count' }]).map((x, j) => j === i ? { ...x, fn: e.target.value as Measure['fn'] } : x) }))}>
                              {['count', 'sum', 'avg', 'min', 'max'].map((f) => <option key={f} value={f}>{f}</option>)}
                            </select>
                            <select value={m.field} aria-label="Field" onChange={(e) => setSpec((s) => ({ ...s, measures: (s.measures ?? [{ field: '*', fn: 'count' }]).map((x, j) => j === i ? { ...x, field: e.target.value } : x) }))}>
                              <option value="*">rows</option>
                              {model.fields.filter((f) => f.type === 'number' || f.type === 'money').map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                            </select>
                            <button type="button" className="chip" aria-label="Remove measure" onClick={() => setSpec((s) => ({ ...s, measures: (s.measures ?? []).filter((_, j) => j !== i) }))}><X size={13} /></button>
                          </li>
                        ))}
                      </ul>
                      <Button variant="ghost" onClick={() => setSpec((s) => ({ ...s, measures: [...(s.measures ?? [{ field: '*', fn: 'count' }]), { field: '*', fn: 'count' }] }))}><Plus size={14} aria-hidden="true" />Add measure</Button>
                    </>
                  )}
                </>
              )}
            </Card>
            <div className="builder-main">
              <Card>
                <div className="filter-row">
                  {(spec.filters ?? []).map((f, i) => {
                    const fld = model?.fields.find((x) => x.key === f.field)
                    return (
                      <span className="filter-chip" key={i}>
                        <select value={f.field} aria-label="Field" onChange={(e) => setSpec((s) => ({ ...s, filters: (s.filters ?? []).map((x, j) => j === i ? { ...x, field: e.target.value } : x) }))}>
                          {model?.fields.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                        </select>
                        <select value={f.op} aria-label="Operator" onChange={(e) => setSpec((s) => ({ ...s, filters: (s.filters ?? []).map((x, j) => j === i ? { ...x, op: e.target.value } : x) }))}>
                          {(OPS[fld?.type ?? 'text'] ?? OPS.text!).map((o) => <option key={o} value={o}>{OP_LABEL[o] ?? o}</option>)}
                        </select>
                        {f.op !== 'is_null' && f.op !== 'not_null' && (
                          <input value={f.value ?? ''} aria-label="Value" type={fld?.type === 'date' ? 'date' : fld?.type === 'number' || fld?.type === 'money' ? 'number' : 'text'}
                            onChange={(e) => setSpec((s) => ({ ...s, filters: (s.filters ?? []).map((x, j) => j === i ? { ...x, value: e.target.value } : x) }))} />
                        )}
                        <button type="button" aria-label="Remove filter" onClick={() => setSpec((s) => ({ ...s, filters: (s.filters ?? []).filter((_, j) => j !== i) }))}><X size={13} /></button>
                      </span>
                    )
                  })}
                  <Button variant="ghost" disabled={!model} onClick={() => setSpec((s) => ({ ...s, filters: [...(s.filters ?? []), { field: model!.fields[0]!.key, op: 'eq', value: '' }] }))}><Plus size={14} aria-hidden="true" />Filter</Button>
                  <span className="row-actions">
                    <Button variant="secondary" disabled={!result?.rows.length} onClick={() => void csv()}><Download size={15} aria-hidden="true" />CSV</Button>
                    <Button disabled={!result} onClick={() => setSaving(true)}><Save size={15} aria-hidden="true" />Save</Button>
                  </span>
                </div>
              </Card>
              {!result ? <Card><Empty title="The preview appears here" text="Pick a model and the rows appear; add a grouping to turn them into totals." /></Card> : (
                <>
                  {chart && (
                    <Card title={`${chart.measure} by ${result.columns[0]?.label ?? ''}`} subtitle="Top 12">
                      <ul className="bar-chart">
                        {chart.rows.map((r) => (
                          <li key={r.label}>
                            <span className="bar-label">{r.label}</span>
                            <span className="bar"><i style={{ width: `${Math.max(2, r.value / chart.max * 100)}%` }} /></span>
                            <span className="bar-value">{r.value.toLocaleString('en-IN')}</span>
                          </li>
                        ))}
                      </ul>
                    </Card>
                  )}
                  <Card className="data-card">
                    <div className="table-scroll">
                      <table>
                        <thead><tr>{result.columns.map((c) => <th key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num' : ''}>{c.label}</th>)}</tr></thead>
                        <tbody>
                          {result.rows.map((r, i) => (
                            <tr key={i}>{result.columns.map((c) => <td key={c.key} className={c.type === 'number' || c.type === 'money' ? 'num' : ''}>{formatCell(r[c.key], c.type)}</td>)}</tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <p className="subtle">{result.total} row{result.total === 1 ? '' : 's'}{result.truncated ? ' · truncated at 5000 — narrow it with a filter' : ''}</p>
                  </Card>
                </>
              )}
            </div>
          </div>
        )
      )}
      {tab.startsWith('Saved') && (
        !saved.length ? <Card><Empty title="Nothing saved" text="Build something in the Builder tab and press Save; share it and anyone with the same access sees it too." /></Card> : (
          <div className="template-grid">
            {saved.map((s) => (
              <Card key={s.id}>
                <div className="approval-full-head"><strong>{s.name}</strong>{s.shared && <span className="badge green"><span />shared</span>}</div>
                <p className="subtle">{s.description ?? `${s.spec.model} · by ${s.owner_name}`}{s.schedules ? ` · ${s.schedules} schedule${s.schedules === 1 ? '' : 's'}` : ''}</p>
                <div className="decision-actions">
                  <Button variant="secondary" onClick={() => { setSpec(s.spec); setTab('Builder') }}><Play size={15} aria-hidden="true" />Open</Button>
                  <Button variant="ghost" onClick={() => setScheduling(s)}>Schedule</Button>
                  <Button variant="ghost" onClick={async () => { await domainApi(`/report-builder/saved/${s.id}`, undefined, 'DELETE'); await loadSaved() }}><Trash2 size={15} aria-hidden="true" />Delete</Button>
                </div>
              </Card>
            ))}
          </div>
        )
      )}
      {tab.startsWith('Scheduled') && (
        !schedules.length ? <Card><Empty title="Nothing scheduled" text="A schedule mails a saved report on a cadence — it runs with your permissions, so it can never show more than you can see." /></Card> : (
          <Card className="data-card">
            <div className="table-scroll">
              <table>
                <thead><tr><th>Report</th><th>When</th><th>To</th><th>Next run</th><th>Status</th><th></th></tr></thead>
                <tbody>
                  {schedules.map((s) => (
                    <tr key={s.id}>
                      <td><strong>{s.report_name}</strong></td>
                      <td>{s.frequency}{s.frequency === 'weekly' ? ` · ${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][s.day_of_week ?? 1]}` : s.frequency === 'monthly' ? ` · day ${s.day_of_month}` : ''} at {String(s.hour).padStart(2, '0')}:00</td>
                      <td>{s.recipients.join(', ')}</td>
                      <td>{dateLabel(s.next_run_on)}</td>
                      <td><span className={`badge ${s.status === 'active' ? 'green' : 'amber'}`}><span />{s.status}</span>{s.last_error && <><br /><small className="warn-text">{s.last_error}</small></>}</td>
                      <td className="row-actions">
                        <Button variant="ghost" onClick={async () => { await domainApi(`/report-builder/schedules/${s.id}/${s.status === 'active' ? 'pause' : 'resume'}`, {}); await loadSaved() }}>{s.status === 'active' ? 'Pause' : 'Resume'}</Button>
                        <Button variant="ghost" onClick={async () => { await domainApi(`/report-builder/schedules/${s.id}/delete`, {}); await loadSaved() }}>Delete</Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )
      )}
      {saving && <SaveReport spec={spec} onClose={() => setSaving(false)} onSaved={async () => { setSaving(false); await loadSaved() }} />}
      {scheduling && <ScheduleReport report={scheduling} onClose={() => setScheduling(null)} onSaved={async () => { setScheduling(null); await loadSaved() }} />}
    </>
  )
}

function formatCell(v: unknown, type: string): string {
  if (v === null || v === undefined) return ''
  if (type === 'money') return `₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
  if (type === 'boolean') return v ? 'yes' : 'no'
  if (type === 'number') return Number(v).toLocaleString('en-IN')
  return String(v)
}

function SaveReport({ spec, onClose, onSaved }: { spec: Spec; onClose: () => void; onSaved: () => Promise<void> }) {
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [shared, setShared] = useState(false)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return (
    <Modal title="Save this report" onClose={onClose}>
      <div className="template-form">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Late arrivals by department" autoFocus /></label>
        <label className="field"><span>Description</span><input value={description} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="check"><input type="checkbox" checked={shared} onChange={(e) => setShared(e.target.checked)} /> Share with colleagues who have the same access</label>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { await domainApi('/report-builder/saved', { name, description: description || undefined, spec, shared }); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>{busy ? 'Saving…' : 'Save'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function ScheduleReport({ report, onClose, onSaved }: { report: Saved; onClose: () => void; onSaved: () => Promise<void> }) {
  const [frequency, setFrequency] = useState('weekly')
  const [dayOfWeek, setDayOfWeek] = useState('1')
  const [dayOfMonth, setDayOfMonth] = useState('1')
  const [hour, setHour] = useState('8')
  const [recipients, setRecipients] = useState<string[]>([])
  const [entry, setEntry] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return (
    <Modal title={`Mail “${report.name}”`} onClose={onClose}>
      <div className="template-form">
        <div className="two-up">
          <label className="field"><span>How often</span><select value={frequency} onChange={(e) => setFrequency(e.target.value)}>{['daily', 'weekly', 'monthly'].map((f) => <option key={f} value={f}>{f}</option>)}</select></label>
          {frequency === 'weekly' ? <label className="field"><span>Day</span><select value={dayOfWeek} onChange={(e) => setDayOfWeek(e.target.value)}>{['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
            : frequency === 'monthly' ? <label className="field"><span>Day of month</span><input type="number" min={1} max={28} value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} /></label>
            : <label className="field"><span>Hour</span><input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} /></label>}
        </div>
        <label className="field"><span>Send to</span>
          <span className="chip-input">
            {recipients.map((r) => <span className="chip on" key={r}>{r}<button type="button" aria-label={`Remove ${r}`} onClick={() => setRecipients(recipients.filter((x) => x !== r))}><X size={12} /></button></span>)}
            <input value={entry} placeholder="name@company.com" onChange={(e) => setEntry(e.target.value)}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ',') && entry.trim()) { e.preventDefault(); setRecipients([...new Set([...recipients, entry.trim()])]); setEntry('') } }} />
          </span>
        </label>
        <p className="subtle">It runs with <strong>your</strong> permissions and scope: recipients see exactly what you would see, and the schedule pauses itself if you lose the access.</p>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions">
          <Button disabled={busy || !recipients.length} onClick={async () => {
            setBusy(true)
            try {
              await domainApi('/report-builder/schedules', { reportId: report.id, frequency, dayOfWeek: frequency === 'weekly' ? Number(dayOfWeek) : undefined, dayOfMonth: frequency === 'monthly' ? Number(dayOfMonth) : undefined, hour: Number(hour), recipients })
              await onSaved()
            } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
          }}>{busy ? 'Scheduling…' : 'Schedule'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Modal>
  )
}
