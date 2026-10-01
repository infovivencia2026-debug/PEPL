/**
 * Work reports: a form rendered from the template's own fields, so a company
 * that wants "litres delivered" gets a number box without anyone shipping
 * code. The supervisor's view adds who punched in and has not filed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, MapPin, Plus, Send } from 'lucide-react'
import { domainApi } from '../domainApi'
import { dateLabel } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Field { key: string; label: string; type: 'text' | 'number' | 'date' | 'choice' | 'photo' | 'geo' | 'boolean'; required?: boolean; options?: string[] }
interface Template { id: string; code: string; name: string; frequency: string; fields: Field[]; status?: string }
interface Report { id: string; template_code: string; template_name?: string; employee_id: string; employee_name?: string; report_date: string; values: Record<string, unknown>; status: string; review_note: string | null }

export function WorkReportsPage({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Reports')
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [reports, setReports] = useState<Report[]>([])
  const [missing, setMissing] = useState<Array<{ employeeId: string; name: string }>>([])
  const [filing, setFiling] = useState<Template | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const canReview = data.permissions.includes('task.write')
  const load = useCallback(async () => {
    try {
      const t = await domainApi<{ templates: Template[] }>('/work-reports/templates')
      setTemplates(t.templates.filter((x) => x.status !== 'retired'))
      setReports((await domainApi<{ reports: Report[] }>('/work-reports')).reports)
      setError('')
      if (canReview && t.templates[0]) setMissing((await domainApi<{ missing: Array<{ employeeId: string; name: string }> }>(`/work-reports/missing?template=${t.templates[0].code}&date=${data.today}`)).missing)
    } catch (e) { setError((e as Error).message) }
  }, [canReview, data.today])
  useEffect(() => { void load() }, [load])
  async function review(r: Report, status: 'reviewed' | 'returned') {
    const note = status === 'returned' ? window.prompt('What needs fixing?') ?? '' : ''
    if (status === 'returned' && !note.trim()) return
    setBusy(r.id)
    try { await domainApi(`/work-reports/${r.id}/review`, { status, note: note || undefined }); await load() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={canReview ? ['Reports', 'Not filed today', 'Templates'] : ['Reports']} />
      {error && <ErrorBox message={error} />}
      {tab === 'Reports' && (
        <>
          <div className="row-actions">
            {(templates ?? []).map((t) => <Button key={t.id} variant="secondary" onClick={() => setFiling(t)}><Plus size={15} aria-hidden="true" />{t.name}</Button>)}
          </div>
          {!templates ? <Skeleton /> : !reports.length ? (
            <Card><Empty title="No reports filed yet" text={templates.length ? 'Pick a template above to file the first one.' : 'Create a template first: a daily visit report, a delivery sheet, a site checklist.'} /></Card>
          ) : (
            <div className="template-grid">
              {reports.map((r) => (
                <Card key={r.id}>
                  <div className="approval-full-head">
                    <div><strong>{r.template_name ?? r.template_code}</strong><small>{r.employee_name ?? ''} · {dateLabel(r.report_date)}</small></div>
                    <span className={`badge ${r.status === 'reviewed' ? 'green' : r.status === 'returned' ? 'coral' : 'amber'}`}><span />{r.status}</span>
                  </div>
                  <dl className="diff">
                    {Object.entries(r.values).slice(0, 6).map(([k, v]) => <div key={k}><dt>{k.replace(/_/g, ' ')}</dt><dd>{typeof v === 'boolean' ? (v ? 'yes' : 'no') : typeof v === 'object' ? JSON.stringify(v) : String(v)}</dd></div>)}
                  </dl>
                  {r.review_note && <blockquote>{r.review_note}</blockquote>}
                  {canReview && r.status === 'submitted' && (
                    <div className="decision-actions">
                      <Button disabled={busy === r.id} onClick={() => void review(r, 'reviewed')}>Reviewed</Button>
                      <Button variant="ghost" disabled={busy === r.id} onClick={() => void review(r, 'returned')}>Send back</Button>
                    </div>
                  )}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'Not filed today' && (
        !missing.length ? <Card><Empty title="Everyone has filed" text="Nobody who punched in today is missing a report." /></Card> : (
          <Card title={`${missing.length} punched in without a report`} subtitle="They are at work today but have not filed.">
            <ul className="plain-list">{missing.map((m) => <li key={m.employeeId}>{m.name}</li>)}</ul>
          </Card>
        )
      )}
      {tab === 'Templates' && <TemplateList templates={templates ?? []} onSaved={load} />}
      {filing && <FileReport template={filing} employeeId={data.user.employeeId} onClose={() => setFiling(null)} onSaved={async () => { setFiling(null); await load() }} />}
    </>
  )
}

function FileReport({ template, employeeId, onClose, onSaved }: { template: Template; employeeId?: string; onClose: () => void; onSaved: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, unknown>>({})
  const [geo, setGeo] = useState<{ lat: number; lng: number } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const missingRequired = template.fields.filter((f) => f.required && f.type !== 'geo' && (values[f.key] === undefined || values[f.key] === ''))
  /** Uploads the photo as a document and keeps its id. The field used to keep only the FILE NAME, so
   *  the report said a photo existed and nothing was stored. */
  async function attach(key: string, file: File | undefined) {
    if (!file) { setValues((cur) => ({ ...cur, [key]: '' })); return }
    if (!employeeId) { setError('Your login has no employee record, so a photo cannot be attached.'); return }
    setBusy(true); setError('')
    try {
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; bytes.forEach((b) => { binary += String.fromCharCode(b) })
      const doc = await domainApi<{ id: string }>('/documents', { ownerType: 'employee', ownerId: employeeId, fileName: file.name, contentType: file.type || 'image/jpeg', contentBase64: btoa(binary), category: 'photo' })
      setValues((cur) => ({ ...cur, [key]: doc.id }))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to upload the photo') } finally { setBusy(false) }
  }
  async function save() {
    setBusy(true); setError('')
    try { await domainApi('/work-reports', { template: template.code, values, ...(geo ? { geo } : {}) }); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title={template.name} onClose={onClose}>
      <div className="template-form">
        {template.fields.map((f) => {
          const v = values[f.key]
          if (f.type === 'boolean') return <label key={f.key} className="check"><input type="checkbox" checked={Boolean(v)} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} /> {f.label}</label>
          if (f.type === 'choice') return <label key={f.key} className="field"><span>{f.label}</span><select value={String(v ?? '')} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}><option value="">Choose</option>{(f.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select></label>
          if (f.type === 'geo') return (
            <div key={f.key} className="field">
              <span>{f.label}</span>
              <Button variant="secondary" type="button" onClick={() => navigator.geolocation?.getCurrentPosition((p) => setGeo({ lat: p.coords.latitude, lng: p.coords.longitude }))}><MapPin size={15} aria-hidden="true" />{geo ? `Captured ${geo.lat.toFixed(4)}, ${geo.lng.toFixed(4)}` : 'Capture location'}</Button>
            </div>
          )
          if (f.type === 'photo') return <label key={f.key} className="field"><span>{f.label}</span><input type="file" accept="image/*" capture="environment" onChange={(e) => void attach(f.key, e.target.files?.[0])} />{typeof v === 'string' && v && <small>Photo attached</small>}</label>
          return <label key={f.key} className="field"><span>{f.label}{f.required ? '' : ' (optional)'}</span><input type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={String(v ?? '')} onChange={(e) => setValues({ ...values, [f.key]: f.type === 'number' ? Number(e.target.value) : e.target.value })} /></label>
        })}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || missingRequired.length > 0} title={missingRequired.length ? `Still to fill: ${missingRequired.map((f) => f.label).join(', ')}` : undefined} onClick={() => void save()}><Send size={15} aria-hidden="true" />{busy ? 'Filing…' : 'File report'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function TemplateList({ templates, onSaved }: { templates: Template[]; onSaved: () => Promise<void> }) {
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ code: '', name: '', frequency: 'daily', fields: 'notes:Notes:text:required\nvisits:Visits made:number' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const parsed = useMemo(() => form.fields.split('\n').filter(Boolean).map((line) => {
    const [key, label, type, req] = line.split(':')
    return { key: (key ?? '').trim(), label: (label ?? key ?? '').trim(), type: ((type ?? 'text').trim() as Field['type']), required: (req ?? '').trim() === 'required' }
  }), [form.fields])
  async function save() {
    setBusy(true); setError('')
    try { await domainApi('/work-reports/templates', { code: form.code, name: form.name, frequency: form.frequency, fields: parsed }); setAdding(false); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <div className="row-actions"><Button onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />New template</Button></div>
      {!templates.length ? <Card><Empty title="No templates" text="A template is the form your people fill: name it, list its fields, choose how often." /></Card> : (
        <div className="template-grid">
          {templates.map((t) => (
            <Card key={t.id}>
              <div className="approval-full-head"><strong>{t.name}</strong><span className="badge green"><span />{t.frequency}</span></div>
              <p className="subtle">{t.code}</p>
              <ul className="plain-list">{t.fields.map((f) => <li key={f.key}><ClipboardList size={13} aria-hidden="true" /> {f.label} <small>({f.type}{f.required ? ', required' : ''})</small></li>)}</ul>
            </Card>
          ))}
        </div>
      )}
      {adding && (
        <Modal title="New report template" onClose={() => setAdding(false)}>
          <div className="template-form">
            <div className="two-up">
              <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="VISIT" /></label>
              <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Daily visit report" /></label>
            </div>
            <label className="field"><span>How often</span><select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>{['daily', 'per_visit', 'weekly', 'ad_hoc'].map((f) => <option key={f} value={f}>{f.replace('_', ' ')}</option>)}</select></label>
            <label className="field"><span>Fields — one per line: <code>key:Label:type[:required]</code></span><textarea rows={6} value={form.fields} onChange={(e) => setForm({ ...form, fields: e.target.value })} /></label>
            <p className="subtle">Types: text, number, date, choice, photo, geo, boolean. {parsed.length} field{parsed.length === 1 ? '' : 's'} will be created.</p>
            {error && <ErrorBox message={error} />}
            <div className="decision-actions"><Button disabled={busy || !form.code || !form.name || !parsed.length} onClick={() => void save()}>{busy ? 'Saving…' : 'Create template'}</Button><Button variant="ghost" onClick={() => setAdding(false)}>Cancel</Button></div>
          </div>
        </Modal>
      )}
    </>
  )
}
