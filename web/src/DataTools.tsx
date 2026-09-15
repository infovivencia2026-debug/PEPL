import { useCallback, useEffect, useState, type ChangeEvent } from 'react'
import { ArrowDownToLine, FileSpreadsheet, FileText, ShieldCheck, Upload } from 'lucide-react'
import { dateLabel } from './api'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import type { Workspace } from './types'
import { Button, Card, Empty, PageHeader } from './ui'

export type DocumentMeta = { id: string; file_name: string; content_type: string; size_bytes: number; category: string | null; is_confidential: boolean; created_at: string }
type ImportError = { row: number; field: string; message: string }
type ImportReport = { totalRows: number; valid: unknown[]; duplicates: string[]; willCreate: number; errors: ImportError[] }

const fileBase64 = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
  reader.onerror = () => reject(reader.error)
  reader.readAsDataURL(file)
})

export function DocumentsPanel({ ownerType, ownerId, canWrite = false, maxUploadMb = 10, category, selectedIds, onSelectionChange }: { ownerType: 'employee' | 'tenant'; ownerId?: string; canWrite?: boolean; maxUploadMb?: number; category?: string; selectedIds?: string[]; onSelectionChange?: (ids: string[]) => void }) {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ ownerType, ...(ownerId ? { ownerId } : {}) })
      const result = await domainApi<{ documents: DocumentMeta[] }>(`/documents?${query}`)
      setDocuments(result.documents)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load documents') }
  }, [ownerType, ownerId])
  useEffect(() => { void load() }, [load])
  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    if (file.size > maxUploadMb * 1024 * 1024) { setError(`Choose a file up to ${maxUploadMb} MB.`); return }
    setBusy(true); setError('')
    try {
      const uploaded = await domainApi<DocumentMeta>('/documents', { ownerType, ownerId, fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64: await fileBase64(file), category: category ?? (ownerType === 'employee' ? 'employee record' : 'company document') })
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
  return <Card title="Documents" subtitle="Files are logged whenever they are downloaded">
    {canWrite && <label className="upload-control"><Upload size={17} /><span>{busy ? 'Working…' : 'Upload document'}</span><input type="file" disabled={busy} onChange={event => void upload(event)} /><small>PDF, image, or office file · maximum {maxUploadMb} MB</small></label>}
    {error && <p className="form-error" role="alert">{error}</p>}
    {documents.length ? <div className="document-list">{documents.map(document => <article key={document.id}>{onSelectionChange && <input type="checkbox" aria-label={`Use ${document.file_name} as proof`} checked={selectedIds?.includes(document.id) ?? false} onChange={() => onSelectionChange(selectedIds?.includes(document.id) ? (selectedIds ?? []).filter(id => id !== document.id) : [...(selectedIds ?? []), document.id])} />}<span className="icon-box"><FileText size={18} /></span><div><strong>{document.file_name}</strong><small>{(document.size_bytes / 1024).toFixed(1)} KB · {dateLabel(document.created_at)}{document.is_confidential ? ' · Confidential' : ''}</small></div><Button variant="ghost" disabled={busy} onClick={() => void download(document)}><ArrowDownToLine size={16} />Download</Button></article>)}</div> : <Empty title="No documents yet" text="Uploaded files will appear here." />}
  </Card>
}

export function DocumentsPage({ data }: { data: Workspace }) {
  const limit = Number(data.settings.find(setting => setting.key === 'documents.max_upload_mb')?.value ?? 10)
  return <><PageHeader title="Documents" description="Company files, securely kept and fully auditable." eyebrow="People records" /><DocumentsPanel ownerType="tenant" canWrite={data.permissions.includes('document.write')} maxUploadMb={limit} /></>
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
