/**
 * The accounting journal for a locked run: one balanced set of debits and
 * credits, downloadable as CSV or Tally XML. A component with no mapping is
 * named, with a link to fix it — an unmapped line is how a journal quietly
 * stops balancing.
 */
import { useCallback, useEffect, useState } from 'react'
import { Check, Download, TriangleAlert } from 'lucide-react'
import { domainApi, downloadFile, decodeBase64 } from '../domainApi'
import { money, pretty } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, Skeleton } from '../ui'
import type { Workspace } from '../types'

interface JournalLine { account: string; costCentre: string | null; debitPaise: string; creditPaise: string }
interface Journal { runId: string; period: string; date: string; lines: JournalLine[]; totalDebitPaise: string; totalCreditPaise: string; balanced: boolean; unmapped: string[] }
interface Mapping { id?: string; component_code: string; component_type: string; debit_account: string; credit_account: string; cost_centre_by: string }

export function JournalTab({ runId, locked, data }: { runId: string; locked: boolean; data: Workspace }) {
  const [journal, setJournal] = useState<Journal | null>(null)
  const [error, setError] = useState('')
  const [mapping, setMapping] = useState(false)
  const canMap = data.permissions.includes('payroll.process')
  const load = useCallback(async () => {
    if (!locked) { setJournal(null); return }
    try { setJournal(await domainApi<Journal>(`/payroll/runs/${runId}/journal`)); setError('') } catch (e) { setError((e as Error).message) }
  }, [runId, locked])
  useEffect(() => { void load() }, [load])
  async function download(format: 'csv' | 'tally') {
    const r = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/payroll/runs/${runId}/journal?format=${format}`)
    downloadFile(r.fileName, r.contentType, decodeBase64(r.contentBase64))
  }
  if (!locked) return <Card><Empty title="The journal appears once the run is locked" text="A journal of a run that can still change would be a journal you have to post twice." /></Card>
  if (error) return <ErrorBox message={error} />
  if (!journal) return <Skeleton />
  return (
    <>
      <div className="journal-head">
        <span className={`balance-pill ${journal.balanced ? 'ok' : 'bad'}`}>
          {journal.balanced ? <Check size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}
          {journal.balanced ? 'Balanced' : 'Not balanced'} · debits {money(journal.totalDebitPaise)} · credits {money(journal.totalCreditPaise)}
        </span>
        <div className="row-actions">
          <Button variant="secondary" onClick={() => void download('csv')}><Download size={15} aria-hidden="true" />CSV</Button>
          <Button variant="secondary" onClick={() => void download('tally')}><Download size={15} aria-hidden="true" />Tally XML</Button>
          {canMap && <Button variant="ghost" onClick={() => setMapping(true)}>Ledger mappings</Button>}
        </div>
      </div>
      {journal.unmapped.length > 0 && (
        <div className="bulk-result partial" role="status">
          <strong>{journal.unmapped.length} component{journal.unmapped.length === 1 ? '' : 's'} without a ledger account:</strong>
          <span> {journal.unmapped.map(pretty).join(', ')} — they are left out of the journal until you map them.</span>
          {canMap && <Button variant="ghost" onClick={() => setMapping(true)}>Map them</Button>}
        </div>
      )}
      <Card className="data-card">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Account</th><th>Cost centre</th><th className="num">Debit</th><th className="num">Credit</th></tr></thead>
            <tbody>
              {journal.lines.map((l, i) => (
                <tr key={`${l.account}-${l.costCentre ?? ''}-${i}`}>
                  <td>{l.account}</td>
                  <td>{l.costCentre ?? '—'}</td>
                  <td className="num">{Number(l.debitPaise) ? money(l.debitPaise) : ''}</td>
                  <td className="num">{Number(l.creditPaise) ? money(l.creditPaise) : ''}</td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr><th colSpan={2}>Total</th><th className="num">{money(journal.totalDebitPaise)}</th><th className="num">{money(journal.totalCreditPaise)}</th></tr></tfoot>
          </table>
        </div>
      </Card>
      {mapping && <MappingsModal onClose={() => { setMapping(false); void load() }} />}
    </>
  )
}

function MappingsModal({ onClose }: { onClose: () => void }) {
  const [rows, setRows] = useState<Mapping[] | null>(null)
  const [draft, setDraft] = useState<Mapping>({ component_code: '', component_type: 'deduction', debit_account: '', credit_account: '', cost_centre_by: 'none' })
  const [error, setError] = useState('')
  const load = useCallback(async () => { try { setRows((await domainApi<{ mappings: Mapping[] }>('/payroll/ledger-mappings')).mappings) } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  async function save(m: Mapping) {
    try { await domainApi('/payroll/ledger-mappings', { componentCode: m.component_code, componentType: m.component_type, debitAccount: m.debit_account, creditAccount: m.credit_account, costCentreBy: m.cost_centre_by }); await load() } catch (e) { setError((e as Error).message) }
  }
  return (
    <Modal title="Ledger mappings" wide onClose={onClose}>
      <p className="subtle">Which accounts each payroll component posts to. <code>*</code> is the fallback for a type, so a new component still posts somewhere.</p>
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : (
        <div className="table-scroll">
          <table>
            <thead><tr><th>Component</th><th>Type</th><th>Debit</th><th>Credit</th><th>Cost centre</th></tr></thead>
            <tbody>
              {rows.map((m) => (
                <tr key={`${m.component_code}-${m.component_type}`}>
                  <td><code>{m.component_code}</code></td>
                  <td>{pretty(m.component_type)}</td>
                  <td><input defaultValue={m.debit_account} onBlur={(e) => e.target.value !== m.debit_account && void save({ ...m, debit_account: e.target.value })} aria-label={`Debit account for ${m.component_code}`} /></td>
                  <td><input defaultValue={m.credit_account} onBlur={(e) => e.target.value !== m.credit_account && void save({ ...m, credit_account: e.target.value })} aria-label={`Credit account for ${m.component_code}`} /></td>
                  <td>
                    <select defaultValue={m.cost_centre_by} onChange={(e) => void save({ ...m, cost_centre_by: e.target.value })} aria-label={`Cost centre for ${m.component_code}`}>
                      {['none', 'department', 'location', 'cost_centre'].map((v) => <option key={v} value={v}>{pretty(v)}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
              <tr className="draft-row">
                <td><input value={draft.component_code} onChange={(e) => setDraft({ ...draft, component_code: e.target.value.toUpperCase() })} placeholder="NEW_CODE" aria-label="New component code" /></td>
                <td><select value={draft.component_type} onChange={(e) => setDraft({ ...draft, component_type: e.target.value })} aria-label="New component type">{['earning', 'deduction', 'employer_contribution'].map((v) => <option key={v} value={v}>{pretty(v)}</option>)}</select></td>
                <td><input value={draft.debit_account} onChange={(e) => setDraft({ ...draft, debit_account: e.target.value })} placeholder="Debit account" aria-label="New debit account" /></td>
                <td><input value={draft.credit_account} onChange={(e) => setDraft({ ...draft, credit_account: e.target.value })} placeholder="Credit account" aria-label="New credit account" /></td>
                <td><Button disabled={!draft.component_code || !draft.debit_account || !draft.credit_account} onClick={() => { void save(draft); setDraft({ ...draft, component_code: '', debit_account: '', credit_account: '' }) }}>Add</Button></td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  )
}
