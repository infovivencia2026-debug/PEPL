import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from 'react'
import { ArrowDownToLine, Building2, FileSpreadsheet, FileText, Folder, LockKeyhole, ShieldCheck, Upload, UserRound } from 'lucide-react'
import { dateLabel } from './api'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import type { Workspace } from './types'
import { Button, Card, Empty, PageHeader } from './ui'

export type DocumentMeta = { id: string; file_name: string; content_type: string; size_bytes: number; category: string | null; is_confidential: boolean; created_at: string }
type DocumentCategory = { key: string; label: string; group: string; confidential?: boolean; selfUpload?: boolean }
type ImportError = { row: number; field: string; message: string }
type ImportReport = { totalRows: number; valid: unknown[]; duplicates: string[]; willCreate: number; errors: ImportError[] }

const fileBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

export function DocumentsPanel({ ownerType, ownerId, canWrite = false, selfScope = false, maxUploadMb = 10, category, selectedIds, onSelectionChange }: { ownerType: 'employee' | 'tenant'; ownerId?: string; canWrite?: boolean; selfScope?: boolean; maxUploadMb?: number; category?: string; selectedIds?: string[]; onSelectionChange?: (ids: string[]) => void }) {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [categories, setCategories] = useState<DocumentCategory[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const normalisedCategory = category?.replace(/\s+/g, '_')
  const [activeCategory, setActiveCategory] = useState(normalisedCategory ?? '')
  const [uploadCategory, setUploadCategory] = useState(normalisedCategory ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ ownerType, ...(ownerId ? { ownerId } : {}) })
      const [result, vocabulary] = await Promise.all([domainApi<{ documents: DocumentMeta[]; counts: Record<string, number> }>(`/documents?${query}`), domainApi<{ categories: Record<string, DocumentCategory[]> }>('/documents/categories')])
      const options = vocabulary.categories[ownerType] ?? []
      setDocuments(result.documents); setCounts(result.counts ?? {}); setCategories(options)
      setActiveCategory(current => current || options[0]?.key || ''); setUploadCategory(current => current || options.find(item => !selfScope || item.selfUpload)?.key || '')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load documents') }
  }, [ownerType, ownerId, selfScope])
  useEffect(() => { void load() }, [load])
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > maxUploadMb * 1024 * 1024) { setError(`Choose a file up to ${maxUploadMb} MB.`); return }
    setBusy(true); setError('')
    try {
      const chosen = categories.find(item => item.key === uploadCategory)
      if (!chosen) throw new Error('Choose a document category first.')
      const uploaded = await domainApi<DocumentMeta>('/documents', { ownerType, ownerId, fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64: await fileBase64(file), category: chosen.key, isConfidential: chosen.confidential === true })
      await load()
      if (onSelectionChange && selectedIds) onSelectionChange([...new Set([...selectedIds, uploaded.id])])
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Upload failed') }
    finally { setBusy(false); event.target.value = '' }
  }
  const download = async (document: DocumentMeta) => {
    setBusy(true); setError('')
    try {
      const result = await domainApi<DocumentMeta & { contentBase64: string }>(`/documents/${document.id}/content`)
      downloadFile(result.file_name, result.content_type, decodeBase64(result.contentBase64))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Download failed') }
    finally { setBusy(false) }
  }
  const visibleCategories = selfScope ? categories.filter(item => item.selfUpload) : categories
  const grouped = [...new Set(categories.map(item => item.group))]
  const visibleDocuments = useMemo(() => documents.filter(document => document.category === activeCategory), [documents, activeCategory])
  const chosen = categories.find(item => item.key === uploadCategory)
  return <Card className="documents-card" title="Documents" subtitle="Files are grouped by purpose and logged whenever downloaded">
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="documents-workspace"><aside className="document-folders">{grouped.map(group => <section key={group}><h3>{group}</h3>{categories.filter(item => item.group === group).map(item => <button key={item.key} className={activeCategory === item.key ? 'active' : ''} onClick={() => { setActiveCategory(item.key); if (!selfScope || item.selfUpload) setUploadCategory(item.key) }}><Folder size={14} />{item.label}{item.confidential && <LockKeyhole size={12} />}<b>{counts[item.key] ?? 0}</b></button>)}</section>)}</aside><div className="document-pane"><header><div><span className="eyebrow">{categories.find(item => item.key === activeCategory)?.group}</span><h3>{categories.find(item => item.key === activeCategory)?.label ?? 'Documents'}</h3></div>{categories.find(item => item.key === activeCategory)?.confidential && <span className="confidential-chip"><LockKeyhole size={13} />Confidential</span>}</header>
      {canWrite && (!selfScope || categories.find(item => item.key === activeCategory)?.selfUpload) && <div className="document-upload-row"><label>Category<select value={uploadCategory} onChange={event => setUploadCategory(event.target.value)}>{[...new Set(visibleCategories.map(item => item.group))].map(group => <optgroup label={group} key={group}>{visibleCategories.filter(item => item.group === group).map(item => <option key={item.key} value={item.key}>{item.label}</option>)}</optgroup>)}</select></label>{chosen?.confidential && <span><LockKeyhole size={13} />Always confidential</span>}<label className="upload-control"><Upload size={17} /><span>{busy ? 'Working…' : 'Choose file'}</span><input type="file" disabled={busy || !uploadCategory} onChange={event => void upload(event)} /><small>Maximum {maxUploadMb} MB</small></label></div>}
      {selfScope && !categories.find(item => item.key === activeCategory)?.selfUpload && <p className="policy-note"><LockKeyhole size={14} />This folder is issued by HR and is read-only.</p>}
      {visibleDocuments.length ? <div className="document-list">{visibleDocuments.map(document => <article key={document.id}>{onSelectionChange && <input type="checkbox" aria-label={`Use ${document.file_name} as proof`} checked={selectedIds?.includes(document.id) ?? false} onChange={() => onSelectionChange(selectedIds?.includes(document.id) ? (selectedIds ?? []).filter(id => id !== document.id) : [...(selectedIds ?? []), document.id])} />}<span className="icon-box"><FileText size={18} /></span><div><strong>{document.file_name}</strong><small>{(document.size_bytes / 1024).toFixed(1)} KB · {dateLabel(document.created_at)}{document.is_confidential ? ' · Confidential' : ''}</small></div><Button variant="ghost" disabled={busy} onClick={() => void download(document)}><ArrowDownToLine size={16} />Download</Button></article>)}</div> : <Empty title="This folder is empty" text="Documents in this category will appear here." />}</div></div>
  </Card>
}

export function DocumentsPage({ data }: { data: Workspace }) {
  const limit = Number(data.settings.find(setting => setting.key === 'documents.max_upload_mb')?.value ?? 10)
  const employeeMode = data.user.scope === 'self' && Boolean(data.user.employeeId)
  const [view, setView] = useState(employeeMode ? 'mine' : 'company')
  return <><PageHeader title="Documents" description="Personal records and company resources, organised into familiar folders." eyebrow="People records"><div className="document-view-switch"><button className={view === 'mine' ? 'active' : ''} disabled={!data.user.employeeId} onClick={() => setView('mine')}><UserRound size={15} />My documents</button><button className={view === 'company' ? 'active' : ''} onClick={() => setView('company')}><Building2 size={15} />Company</button></div></PageHeader>{view === 'mine' && data.user.employeeId ? <DocumentsPanel ownerType="employee" ownerId={data.user.employeeId} canWrite={data.permissions.includes('document.write')} selfScope={employeeMode} maxUploadMb={limit} /> : <DocumentsPanel ownerType="tenant" canWrite={!employeeMode && data.permissions.includes('document.write')} selfScope={employeeMode} maxUploadMb={limit} />}</>
}

export function ImportPage() {
  const [csv, setCsv] = useState('')
  const [fileName, setFileName] = useState('')
  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState('')
  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > 5 * 1024 * 1024) { setError('Choose a CSV file up to 5 MB.'); return }
    setFileName(file.name); setCsv(await file.text()); setReport(null); setDone(''); setError('')
  }
  const template = async () => {
    const result = await domainApi<{ fileName: string; contentType: string; content: string }>('/imports/employees/template')
    downloadFile(result.fileName, result.contentType, result.content)
  }
  const validate = async () => {
    setBusy(true); setError('')
    try { setReport(await domainApi('/imports/employees/validate', { csv })) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Validation failed') }
    finally { setBusy(false) }
  }
  const commit = async () => {
    setBusy(true); setError('')
    try {
      const result = await domainApi<{ created: number; skipped: string[] }>('/imports/employees', { csv })
      setDone(`${result.created} employees imported${result.skipped.length ? `; ${result.skipped.length} duplicates skipped` : ''}.`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Import failed') }
    finally { setBusy(false) }
  }
  return <><PageHeader title="Import employees" description="Upload, review every issue, then commit all valid rows together." eyebrow="Data tools"><Button variant="secondary" onClick={() => void template()}><ArrowDownToLine size={17} />Download template</Button></PageHeader>
    <div className="import-steps" aria-label="Import steps"><span className={csv ? 'complete' : 'current'}>1 <b>Upload</b></span><span className={report ? 'complete' : csv ? 'current' : ''}>2 <b>Review</b></span><span className={done ? 'complete' : report && !report.errors.length ? 'current' : ''}>3 <b>Commit</b></span></div>
    <Card><label className="import-drop"><FileSpreadsheet size={32} /><strong>{fileName || 'Choose an employee CSV'}</strong><small>Required: employee number, first name, joining date · maximum 5 MB</small><input type="file" accept=".csv,text/csv" onChange={event => void choose(event)} /></label>{csv && <Button disabled={busy} onClick={() => void validate()}><ShieldCheck size={17} />{busy ? 'Checking…' : 'Validate file'}</Button>}{error && <p className="form-error" role="alert">{error}</p>}{done && <p className="success-note" role="status">{done}</p>}</Card>
    {report && <Card title="Validation report" subtitle={`${report.totalRows} rows checked`}><div className="import-summary"><span><strong>{report.willCreate}</strong>Ready to import</span><span><strong>{report.duplicates.length}</strong>Duplicates</span><span><strong>{report.errors.length}</strong>Errors</span></div>{report.errors.length ? <div className="table-scroll"><table><thead><tr><th>Row</th><th>Field</th><th>What to fix</th></tr></thead><tbody>{report.errors.map((issue, index) => <tr key={`${issue.row}-${issue.field}-${index}`}><td>{issue.row}</td><td>{issue.field}</td><td>{issue.message}</td></tr>)}</tbody></table></div> : <div className="commit-ready"><ShieldCheck size={24} /><div><strong>Ready to commit</strong><p>This creates all {report.willCreate} employees in one transaction.</p></div><Button disabled={busy || !report.willCreate || Boolean(done)} onClick={() => void commit()}>{busy ? 'Importing…' : `Import ${report.willCreate} employees`}</Button></div>}</Card>}
  </>
}
