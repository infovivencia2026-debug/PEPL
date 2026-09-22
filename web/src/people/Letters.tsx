/**
 * Letters: templates with merge fields, and the issue flow — pick a person,
 * pick a template, preview with the gaps turned into inputs, issue, open the
 * PDF. The preview is the server's own merge, so what you read is what is
 * signed; nothing is rendered client-side and then trusted.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FileText, Plus, Send } from 'lucide-react'
import { domainApi, downloadFile, decodeBase64 } from '../domainApi'
import { fullName } from '../api'
import { Badge, Button, Card, Empty, ErrorBox, Modal, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Template { id: string; code: string; name: string; title: string; body: string; category: string; confidential: boolean; status: string }
interface Issued { id: string; employee_id: string; code: string; reference_no: string; document_id: string; issued_at: string }

async function openDocument(id: string): Promise<void> {
  const r = await domainApi<{ file_name: string; content_type: string; contentBase64: string }>(`/documents/${id}/content`)
  downloadFile(r.file_name, r.content_type, decodeBase64(r.contentBase64))
}

export function LettersPage({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Issue a letter')
  const [templates, setTemplates] = useState<Template[] | null>(null)
  const [fields, setFields] = useState<string[]>([])
  const [issued, setIssued] = useState<Issued[]>([])
  const [error, setError] = useState('')
  const canManage = data.permissions.includes('letter.manage'), canIssue = data.permissions.includes('letter.issue')
  const load = useCallback(async () => {
    try {
      const t = await domainApi<{ templates: Template[]; fields: string[] }>('/letters/templates?includeRetired=true')
      setTemplates(t.templates); setFields(t.fields)
      setIssued((await domainApi<{ letters: Issued[] }>('/letters')).letters)
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])
  const tabs = [...(canIssue ? ['Issue a letter'] : []), 'Issued', ...(canManage ? ['Templates'] : [])]
  useEffect(() => { if (!tabs.includes(tab)) setTab(tabs[0] ?? 'Issued') }, [tabs, tab])
  if (error) return <ErrorBox message={error} />
  if (!templates) return <Skeleton />
  const active = templates.filter((t) => t.status === 'active')
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === 'Issue a letter' && <IssueFlow data={data} templates={active} onIssued={load} />}
      {tab === 'Issued' && <IssuedList data={data} letters={issued} templates={templates} />}
      {tab === 'Templates' && <TemplateEditor templates={templates} fields={fields} onSaved={load} />}
    </>
  )
}

function IssueFlow({ data, templates, onIssued }: { data: Workspace; templates: Template[]; onIssued: () => Promise<void> }) {
  const [employeeId, setEmployeeId] = useState('')
  const [code, setCode] = useState('')
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [signatory, setSignatory] = useState(data.user.full_name)
  const [notify, setNotify] = useState(true)
  const [preview, setPreview] = useState<{ title: string; text: string; missing: string[]; category: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ reference: string; documentId: string } | null>(null)
  const people = useMemo(() => [...data.employees].sort((a, b) => fullName(a).localeCompare(fullName(b))), [data.employees])
  useEffect(() => {
    if (!employeeId || !code) { setPreview(null); return }
    let live = true
    const t = window.setTimeout(() => {
      domainApi<typeof preview>('/letters/preview', { code, employeeId, custom }).then((p) => { if (live) { setPreview(p); setError('') } }).catch((e: Error) => { if (live) setError(e.message) })
    }, 300)
    return () => { live = false; window.clearTimeout(t) }
  }, [employeeId, code, custom])
  const missing = preview?.missing ?? []
  async function issue() {
    setBusy(true); setError('')
    try {
      const r = await domainApi<{ letter: { reference_no: string; document_id: string } }>('/letters/issue', { code, employeeId, custom, signatory: signatory.trim() || undefined, notifyEmployee: notify })
      setDone({ reference: r.letter.reference_no, documentId: r.letter.document_id })
      await onIssued()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (!templates.length) return <Card><Empty title="No letter templates yet" text="Add one under Templates — offer, appointment, confirmation, experience, relieving." /></Card>
  return (
    <div className="letter-flow">
      <Card>
        <ol className="steps">
          <li className={employeeId ? 'done' : 'now'}>
            <label className="field"><span>1 · Who is it for?</span>
              <select value={employeeId} onChange={(e) => { setEmployeeId(e.target.value); setDone(null) }}><option value="">Choose a person</option>{people.map((p) => <option key={p.id} value={p.id}>{fullName(p)} · {p.employee_number}</option>)}</select>
            </label>
          </li>
          <li className={code ? 'done' : employeeId ? 'now' : ''}>
            <label className="field"><span>2 · Which letter?</span>
              <select value={code} disabled={!employeeId} onChange={(e) => { setCode(e.target.value); setCustom({}); setDone(null) }}><option value="">Choose a template</option>{templates.map((t) => <option key={t.code} value={t.code}>{t.name}{t.confidential ? ' · confidential' : ''}</option>)}</select>
            </label>
          </li>
          {code && (
            <li className={missing.length ? 'now' : 'done'}>
              <span className="step-title">3 · Fill in</span>
              {[...new Set([...missing, ...Object.keys(custom)])].map((f) => (
                <label key={f} className="field"><span>{f.replace(/^custom\./, '').replace(/_/g, ' ')}</span><input value={custom[f.replace(/^custom\./, '')] ?? ''} onChange={(e) => setCustom({ ...custom, [f.replace(/^custom\./, '')]: e.target.value })} placeholder="Required" /></label>
              ))}
              {!missing.length && !Object.keys(custom).length && <p className="subtle">Nothing to fill — every field merges from the record.</p>}
              <label className="field"><span>Signatory</span><input value={signatory} onChange={(e) => setSignatory(e.target.value)} placeholder="Name, designation" /></label>
              <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Tell the employee and attach it to their documents</label>
            </li>
          )}
        </ol>
        {error && <ErrorBox message={error} />}
        {done ? (
          <div className="issued-ok" role="status">
            <FileText size={18} aria-hidden="true" />
            <div><strong>Issued · {done.reference}</strong><p>The PDF is in the employee’s documents.</p></div>
            <Button variant="secondary" onClick={() => void openDocument(done.documentId)}>Open PDF</Button>
          </div>
        ) : (
          <Button disabled={!preview || missing.length > 0 || busy} onClick={() => void issue()}><Send size={16} aria-hidden="true" />{busy ? 'Issuing…' : 'Issue letter'}</Button>
        )}
      </Card>
      <Card className="letter-paper" aria-live="polite">
        {preview ? (
          <>
            <p className="eyebrow">{preview.category} · preview</p>
            <h2>{preview.title}</h2>
            <pre>{preview.text}</pre>
            {missing.length > 0 && <p className="paper-note">{missing.length} field{missing.length === 1 ? '' : 's'} still to fill: {missing.map((m) => m.replace(/^custom\./, '')).join(', ')}</p>}
          </>
        ) : <Empty title="The letter appears here" text="Choose a person and a template; the preview is the exact text that will be signed." />}
      </Card>
    </div>
  )
}

function IssuedList({ data, letters, templates }: { data: Workspace; letters: Issued[]; templates: Template[] }) {
  if (!letters.length) return <Card><Empty title="No letters issued yet" text="Issued letters are listed here with their reference number; each is also in the person’s documents." /></Card>
  return (
    <Card className="data-card">
      <div className="table-scroll">
        <table>
          <thead><tr><th>Reference</th><th>Letter</th><th>Employee</th><th>Issued</th><th></th></tr></thead>
          <tbody>
            {letters.map((l) => {
              const e = data.employees.find((x) => x.id === l.employee_id)
              return (
                <tr key={l.id}>
                  <td><strong>{l.reference_no}</strong></td>
                  <td>{templates.find((t) => t.code === l.code)?.name ?? l.code}</td>
                  <td>{e ? fullName(e) : '—'}</td>
                  <td>{new Date(l.issued_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}</td>
                  <td><Button variant="ghost" onClick={() => void openDocument(l.document_id)}><FileText size={15} aria-hidden="true" />PDF</Button></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function TemplateEditor({ templates, fields, onSaved }: { templates: Template[]; fields: string[]; onSaved: () => Promise<void> }) {
  const [editing, setEditing] = useState<Partial<Template> | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const insert = (f: string) => setEditing((t) => ({ ...t, body: `${t?.body ?? ''}{{${f.replace('<anything>', 'field_name')}}}` }))
  async function save() {
    if (!editing) return
    setBusy(true); setError('')
    try { await domainApi('/letters/templates', { code: editing.code, name: editing.name, title: editing.title, body: editing.body, category: editing.category, confidential: editing.confidential ?? false }); setEditing(null); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function retire(code: string) { await domainApi(`/letters/templates/${code}/retire`, {}); await onSaved() }
  return (
    <>
      <div className="row-actions"><Button onClick={() => setEditing({ code: '', name: '', title: '', body: 'Dear {{employee.name}},\n\n', category: 'general', confidential: false })}><Plus size={16} aria-hidden="true" />New template</Button></div>
      {templates.length ? (
        <div className="template-grid">
          {templates.map((t) => (
            <Card key={t.id} className={t.status === 'retired' ? 'retired' : ''}>
              <div className="approval-full-head"><strong>{t.name}</strong><Badge>{t.status}</Badge></div>
              <p className="subtle">{t.code} · {t.category}{t.confidential ? ' · confidential' : ''}</p>
              <p className="template-excerpt">{t.body.slice(0, 160)}{t.body.length > 160 ? '…' : ''}</p>
              <div className="decision-actions">
                <Button variant="secondary" onClick={() => setEditing({ ...t })}>Edit</Button>
                {t.status === 'active' && <Button variant="ghost" onClick={() => void retire(t.code)}>Retire</Button>}
              </div>
            </Card>
          ))}
        </div>
      ) : <Card><Empty title="No templates" text="Create the first one." /></Card>}
      {editing && (
        <Modal title={editing.id ? `Edit ${editing.name}` : 'New letter template'} onClose={() => setEditing(null)}>
          <div className="template-form">
            <div className="two-up">
              <label className="field"><span>Code</span><input value={editing.code ?? ''} disabled={Boolean(editing.id)} onChange={(e) => setEditing({ ...editing, code: e.target.value })} placeholder="experience" /></label>
              <label className="field"><span>Name</span><input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="Experience letter" /></label>
            </div>
            <label className="field"><span>Letter title</span><input value={editing.title ?? ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="To whomsoever it may concern" /></label>
            <div className="two-up">
              <label className="field"><span>Category</span><input value={editing.category ?? ''} onChange={(e) => setEditing({ ...editing, category: e.target.value })} /></label>
              <label className="check"><input type="checkbox" checked={Boolean(editing.confidential)} onChange={(e) => setEditing({ ...editing, confidential: e.target.checked })} /> Confidential (only HR sees it in documents)</label>
            </div>
            <label className="field"><span>Body</span><textarea rows={12} value={editing.body ?? ''} onChange={(e) => setEditing({ ...editing, body: e.target.value })} /></label>
            <div className="merge-palette" aria-label="Merge fields — click to insert">
              {fields.map((f) => <button type="button" key={f} className="chip" onClick={() => insert(f)}>{`{{${f}}}`}</button>)}
            </div>
            {error && <ErrorBox message={error} />}
            <div className="decision-actions"><Button disabled={busy || !editing.code || !editing.name || !editing.title || !editing.body} onClick={() => void save()}>{busy ? 'Saving…' : 'Save template'}</Button><Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button></div>
          </div>
        </Modal>
      )}
    </>
  )
}
