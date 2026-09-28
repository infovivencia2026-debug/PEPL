/**
 * Assets: the register of what the company lent whom. Status is a word and a
 * colour; a warranty about to lapse says so; an item held by someone who is
 * leaving is what blocks their clearance, so the holder is always visible.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BadgeCheck, Laptop, Plus, RotateCcw, Wrench } from 'lucide-react'
import { domainApi } from '../domainApi'
import { fullName, money, dateLabel, errorCode } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, SearchBox, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Category { id: string; code: string; name: string; clearance_area: string; returnable: boolean }
interface Asset { id: string; tag: string; name: string; serial_no: string | null; status: string; category_id: string; category_name?: string; location_code: string | null; warranty_until: string | null; cost_paise: string | null; holder_employee_id: string | null; holder_name: string | null; assignment_id?: string | null }
interface Assignment { id: string; asset_id: string; tag: string; name: string; employee_id: string; issued_on: string; acknowledged_at: string | null; returned_on: string | null; condition: string | null }
interface Summary { total: number; byStatus: Record<string, number>; byCategory: Array<{ name: string; count: number }>; warrantyExpiring: number }

const STATUS_CLASS: Record<string, string> = { in_stock: 'green', issued: 'amber', in_repair: 'amber', lost: 'coral', retired: 'coral' }

export function AssetsPage({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Register')
  const [assets, setAssets] = useState<Asset[] | null>(null)
  const [categories, setCategories] = useState<Category[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [mine, setMine] = useState<Assignment[]>([])
  const [search, setSearch] = useState('')
  const [error, setError] = useState('')
  // The API code behind `error`, so a plan-gated module reads as an offer.
  const [code, setCode] = useState<string | undefined>()
  const [adding, setAdding] = useState(false)
  const [issuing, setIssuing] = useState<Asset | null>(null)
  const [returning, setReturning] = useState<Asset | null>(null)
  const [busy, setBusy] = useState('')
  const canManage = data.permissions.includes('asset.manage')
  const load = useCallback(async () => {
    try {
      const [a, c, s] = await Promise.all([
        domainApi<{ assets: Asset[] }>('/assets'),
        domainApi<{ categories: Category[] }>('/assets/categories'),
        domainApi<Summary>('/assets/summary'),
      ])
      setAssets(a.assets); setCategories(c.categories); setSummary(s); setError('')
      if (data.user.employeeId) setMine((await domainApi<{ assignments: Assignment[] }>('/assets/assignments?employeeId=me&open=true')).assignments)
    } catch (e) { setError((e as Error).message); setCode(errorCode(e)) }
  }, [data.user.employeeId])
  useEffect(() => { void load() }, [load])
  const rows = useMemo(() => (assets ?? []).filter((a) => `${a.tag} ${a.name} ${a.serial_no ?? ''} ${a.holder_name ?? ''}`.toLowerCase().includes(search.toLowerCase())), [assets, search])
  async function act(path: string, body: unknown, id: string) {
    setBusy(id)
    try { await domainApi(path, body); await load(); setIssuing(null); setReturning(null) } catch (e) { setError((e as Error).message); setCode(errorCode(e)) } finally { setBusy('') }
  }
  const tabs = ['Register', ...(data.user.employeeId ? ['My assets'] : [])]
  return (
    <>
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {error && <ErrorBox message={error} code={code} />}
      {tab === 'My assets' ? (
        !mine.length ? <Card><Empty title="Nothing issued to you" text="Laptops, phones, SIMs and ID cards you hold appear here — acknowledge them so the register matches reality." /></Card> : (
          <div className="template-grid">
            {mine.map((m) => (
              <Card key={m.id}>
                <div className="approval-full-head"><strong>{m.name}</strong><span className="badge amber"><span />{m.acknowledged_at ? 'held' : 'awaiting your confirmation'}</span></div>
                <p className="subtle">{m.tag} · issued {dateLabel(m.issued_on)}</p>
                {!m.acknowledged_at && <Button disabled={busy === m.id} onClick={() => void act(`/assets/assignments/${m.id}/acknowledge`, {}, m.id)}><BadgeCheck size={16} aria-hidden="true" />I have this</Button>}
              </Card>
            ))}
          </div>
        )
      ) : (
        <>
          {summary && (
            <div className="stats-row">
              <div className="stat"><small>Assets</small><strong>{summary.total}</strong></div>
              <div className="stat"><small>Issued</small><strong>{summary.byStatus.issued ?? 0}</strong></div>
              <div className="stat"><small>In stock</small><strong>{summary.byStatus.in_stock ?? 0}</strong></div>
              <div className="stat"><small>Warranty ending</small><strong className={summary.warrantyExpiring ? 'bad' : ''}>{summary.warrantyExpiring}</strong><span className="subtle">next 60 days</span></div>
            </div>
          )}
          <div className="filter-bar">
            <SearchBox value={search} onChange={setSearch} placeholder="Tag, name, serial or holder…" />
            {canManage && <Button onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add asset</Button>}
          </div>
          {!assets ? <Skeleton /> : !rows.length ? <Card><Empty title={assets.length ? 'Nothing matches' : 'No assets yet'} text={assets.length ? 'Try a different tag or name.' : 'Add the laptops, phones and SIMs the company lends out; the exit clearance then refuses to sign while someone still holds one.'} /></Card> : (
            <Card className="data-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Tag</th><th>Asset</th><th>Status</th><th>Held by</th><th>Warranty</th><th></th></tr></thead>
                  <tbody>
                    {rows.map((a) => {
                      const soon = a.warranty_until && Date.parse(a.warranty_until) - Date.now() < 60 * 86_400_000
                      return (
                        <tr key={a.id}>
                          <td><code>{a.tag}</code></td>
                          <td><strong>{a.name}</strong>{a.serial_no ? <><br /><small>{a.serial_no}</small></> : null}</td>
                          <td><span className={`badge ${STATUS_CLASS[a.status] ?? 'amber'}`}><span />{a.status.replace('_', ' ')}</span></td>
                          <td>{a.holder_name ?? '—'}</td>
                          <td>{a.warranty_until ? <span className={soon ? 'warn-text' : ''}>{dateLabel(a.warranty_until)}{soon ? ' · ending' : ''}</span> : '—'}</td>
                          <td className="row-actions">
                            {canManage && a.status === 'in_stock' && <Button variant="secondary" disabled={busy === a.id} onClick={() => setIssuing(a)}><Laptop size={15} aria-hidden="true" />Issue</Button>}
                            {canManage && a.status === 'issued' && <Button variant="secondary" disabled={busy === a.id} onClick={() => setReturning(a)}><RotateCcw size={15} aria-hidden="true" />Return</Button>}
                            {canManage && a.status === 'in_stock' && <Button variant="ghost" disabled={busy === a.id} onClick={() => void act(`/assets/${a.id}/maintenance`, { note: 'Sent for repair' }, a.id)}><Wrench size={15} aria-hidden="true" />Repair</Button>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}
      {adding && <AssetModal categories={categories} onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await load() }} />}
      {issuing && (
        <Modal title={`Issue ${issuing.name}`} onClose={() => setIssuing(null)}>
          <IssueForm data={data} busy={busy === issuing.id} onIssue={(employeeId, condition) => void act(`/assets/${issuing.id}/issue`, { employeeId, condition }, issuing.id)} />
        </Modal>
      )}
      {returning && (
        <Modal title={`Return ${returning.name}`} onClose={() => setReturning(null)}>
          <ReturnForm busy={busy === returning.id} onReturn={(body) => void act(`/assets/assignments/${returning.assignment_id}/return`, body, returning.id)} disabled={!returning.assignment_id} />
        </Modal>
      )}
    </>
  )
}

function IssueForm({ data, busy, onIssue }: { data: Workspace; busy: boolean; onIssue: (employeeId: string, condition: string) => void }) {
  const [employeeId, setEmployeeId] = useState('')
  const [condition, setCondition] = useState('good')
  return (
    <div className="template-form">
      <label className="field"><span>Issue to</span><select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}><option value="">Choose a person</option>{data.employees.filter((e) => e.status !== 'exited').map((e) => <option key={e.id} value={e.id}>{fullName(e)} · {e.employee_number}</option>)}</select></label>
      <label className="field"><span>Condition at issue</span><select value={condition} onChange={(e) => setCondition(e.target.value)}><option value="good">Good</option><option value="fair">Fair</option></select></label>
      <div className="decision-actions"><Button disabled={busy || !employeeId} onClick={() => onIssue(employeeId, condition)}>{busy ? 'Issuing…' : 'Issue'}</Button></div>
      <p className="subtle">They will be asked to confirm receipt; the item counts against their exit clearance until it comes back.</p>
    </div>
  )
}

function ReturnForm({ busy, disabled, onReturn }: { busy: boolean; disabled: boolean; onReturn: (body: { condition: string; note?: string; recoveryPaise?: number }) => void }) {
  const [condition, setCondition] = useState('good')
  const [note, setNote] = useState('')
  const [recovery, setRecovery] = useState('')
  if (disabled) return <p className="subtle">This item has no open assignment to return.</p>
  return (
    <div className="template-form">
      <label className="field"><span>Condition</span><select value={condition} onChange={(e) => setCondition(e.target.value)}><option value="good">Good — back in stock</option><option value="damaged">Damaged</option><option value="lost">Lost</option></select></label>
      {condition !== 'good' && <label className="field"><span>Recovery from the employee (₹, optional)</span><input type="number" min={0} value={recovery} onChange={(e) => setRecovery(e.target.value)} /></label>}
      <label className="field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Scratched lid; charger missing" /></label>
      <div className="decision-actions"><Button disabled={busy} onClick={() => onReturn({ condition, note: note || undefined, recoveryPaise: recovery ? Math.round(Number(recovery) * 100) : undefined })}>{busy ? 'Recording…' : 'Record return'}</Button></div>
    </div>
  )
}

function AssetModal({ categories, onClose, onSaved }: { categories: Category[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ categoryId: categories[0]?.id ?? '', tag: '', name: '', serialNo: '', cost: '', warrantyUntil: '', locationCode: '' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true); setError('')
    try {
      await domainApi('/assets', { categoryId: form.categoryId, tag: form.tag, name: form.name, serialNo: form.serialNo || undefined, costPaise: form.cost ? Math.round(Number(form.cost) * 100) : undefined, warrantyUntil: form.warrantyUntil || undefined, locationCode: form.locationCode || undefined })
      await onSaved()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Add an asset" onClose={onClose}>
      <div className="template-form">
        <div className="two-up">
          <label className="field"><span>Category</span><select value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="field"><span>Tag</span><input value={form.tag} onChange={(e) => setForm({ ...form, tag: e.target.value.toUpperCase() })} placeholder="LAP-014" /></label>
        </div>
        <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="ThinkPad T14, 16GB" /></label>
        <div className="two-up">
          <label className="field"><span>Serial number</span><input value={form.serialNo} onChange={(e) => setForm({ ...form, serialNo: e.target.value })} /></label>
          <label className="field"><span>Cost (₹)</span><input type="number" min={0} value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></label>
        </div>
        <div className="two-up">
          <label className="field"><span>Warranty until</span><input type="date" value={form.warrantyUntil} onChange={(e) => setForm({ ...form, warrantyUntil: e.target.value })} /></label>
          <label className="field"><span>Location code</span><input value={form.locationCode} onChange={(e) => setForm({ ...form, locationCode: e.target.value })} /></label>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.tag || !form.name || !form.categoryId} onClick={() => void save()}>{busy ? 'Saving…' : 'Add asset'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
        <p className="subtle">Cost is for the register and the recovery calculation, not for payroll: {money(0)} is fine if unknown.</p>
      </div>
    </Modal>
  )
}
