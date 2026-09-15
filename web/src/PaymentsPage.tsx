import { useEffect, useState } from 'react'
import { ArrowDownToLine, Landmark, ShieldCheck } from 'lucide-react'
import { dateLabel, money, pretty } from './api'
import { domainApi, downloadFile } from './domainApi'
import type { Workspace } from './types'
import { Badge, Button, Card, Empty, PageHeader } from './ui'

type Batch = { id: string; source_id: string; format: string; value_date: string; instruction_count: number; total_paise: string; file_checksum_sha256: string; status: string; created_at: string }

export function PaymentsPage({ data }: { data: Workspace }) {
  const locked = data.payroll.filter(run => run.status === 'locked')
  const [runId, setRunId] = useState(locked[0]?.id ?? '')
  const [formats, setFormats] = useState<string[]>([])
  const [format, setFormat] = useState('')
  const [valueDate, setValueDate] = useState(locked[0]?.pay_date ?? data.today)
  const [batches, setBatches] = useState<Batch[]>([])
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => {
    try {
      const [formatResult, batchResult] = await Promise.all([domainApi<{ formats: string[] }>('/payments/formats'), domainApi<{ batches: Batch[] }>('/payments/batches')])
      setFormats(formatResult.formats); setFormat(current => current || formatResult.formats[0] || ''); setBatches(batchResult.batches)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load bank files') }
  }
  useEffect(() => { void load() }, [])
  const generate = async () => {
    setBusy('generate'); setError(''); setNotice('')
    try {
      const result = await domainApi<{ batchId: string; checksum: string; lineCount: number; totalPaise: string; content: string; reused: boolean }>(`/payroll/runs/${runId}/bank-file`, { format, valueDate })
      const run = locked.find(item => item.id === runId)
      downloadFile(`${run?.label ?? 'payroll'}-${format}.csv`, 'text/csv', result.content)
      setNotice(result.reused ? `Already generated earlier. Downloaded the existing ${result.lineCount}-payment file with checksum ${result.checksum.slice(0, 12)}…` : `Generated ${result.lineCount} payments totalling ${money(result.totalPaise)}.`)
      await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to generate bank file') }
    finally { setBusy('') }
  }
  const download = async (batch: Batch) => {
    setBusy(batch.id); setError('')
    try {
      const result = await domainApi<Batch & { file_content: string }>(`/payments/batches/${batch.id}`)
      downloadFile(`payroll-${result.value_date}-${result.format}.csv`, 'text/csv', result.file_content)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to download bank file') }
    finally { setBusy('') }
  }
  return <><PageHeader title="Salary bank files" description="Generate a payment file from a locked payroll, then upload it to your bank." eyebrow="Salary disbursement"><span className="privacy-chip"><ShieldCheck size={15} />PEPL never moves the money</span></PageHeader>
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}
    <Card title="Generate bank file" subtitle="Only locked payroll runs are available"><div className="bank-file-controls"><label>Payroll run<select value={runId} onChange={event => { const id = event.target.value; setRunId(id); setValueDate(locked.find(run => run.id === id)?.pay_date ?? data.today) }}>{locked.map(run => <option key={run.id} value={run.id}>{run.label} · Revision {run.revision}</option>)}</select></label><label>Bank format<select value={format} onChange={event => setFormat(event.target.value)}>{formats.map(item => <option key={item} value={item}>{pretty(item)}</option>)}</select></label><label>Value date<input type="date" value={valueDate} onChange={event => setValueDate(event.target.value)} /></label>{data.permissions.includes('bank.export') && <Button disabled={!runId || !format || busy === 'generate'} onClick={() => void generate()}><Landmark size={17} />{busy === 'generate' ? 'Generating…' : 'Generate and download'}</Button>}</div>{!locked.length && <Empty title="No locked payroll run" text="Lock an approved payroll before generating a bank file." />}</Card>
    <Card title="Generated batches" subtitle="A repeated generation returns the same batch and checksum">{batches.length ? <div className="table-scroll"><table><thead><tr><th>Created</th><th>Format</th><th>Value date</th><th>Payments</th><th>Total</th><th>Status</th><th><span className="sr-only">Download</span></th></tr></thead><tbody>{batches.map(batch => <tr key={batch.id}><td>{dateLabel(batch.created_at)}</td><td>{pretty(batch.format)}</td><td>{dateLabel(batch.value_date)}</td><td>{batch.instruction_count}</td><td>{money(batch.total_paise)}</td><td><Badge>{batch.status}</Badge></td><td>{data.permissions.includes('bank.export') && <Button variant="ghost" disabled={busy === batch.id} onClick={() => void download(batch)}><ArrowDownToLine size={16} />Download</Button>}</td></tr>)}</tbody></table></div> : <Empty title="No bank files yet" text="Generated batches appear here without exposing account numbers on screen." />}</Card>
  </>
}
