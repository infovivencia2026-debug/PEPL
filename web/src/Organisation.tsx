import { useEffect, useState, type FormEvent } from 'react'
import { domainApi } from './domainApi'
import { PtStatePicker } from './PtStatePicker'
import type { Workspace } from './types'
import { Button, Card, Empty, ErrorBox, Modal, PageHeader, Tabs } from './ui'

type Kind = 'department' | 'location' | 'designation' | 'grade'
interface Unit { id: string; code: string; name: string; parent_id: string | null; status: string; sort_order: number; attributes: Record<string, unknown>; inUseBy: number }
const kinds: Record<string, Kind> = { Departments: 'department', Locations: 'location', Designations: 'designation', Grades: 'grade' }

export function Organisation({ data }: { data: Workspace }) {
  const [tab, setTab] = useState('Departments'), [units, setUnits] = useState<Unit[]>([])
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<Unit | 'new' | null>(null), [retiring, setRetiring] = useState<Unit | null>(null)
  const [retired, setRetired] = useState(false), [message, setMessage] = useState('')
  const [stateCode, setStateCode] = useState(''), [ptReady, setPtReady] = useState(false)
  useEffect(() => { setStateCode(editing && editing !== 'new' ? String(editing.attributes.stateCode ?? '') : ''); setPtReady(false) }, [editing])
  const kind = kinds[tab]
  async function load() {
    setLoading(true); setError('')
    try { setUnits((await domainApi<{ units: Unit[] }>(`/org/${kind}?includeRetired=true&includeUsage=true`)).units) }
    catch (e) { setError((e as Error).message) } finally { setLoading(false) }
  }
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setUnits([])
    domainApi<{ units: Unit[] }>(`/org/${kind}?includeRetired=true&includeUsage=true`).then(result => { if (!cancelled) setUnits(result.units) }).catch(e => { if (!cancelled) setError((e as Error).message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [kind])
  const unit = editing && editing !== 'new' ? editing : null
  function depth(item: Unit): number {
    const seen = new Set([item.id]); let parent = item.parent_id; let level = 0
    while (parent && !seen.has(parent)) { seen.add(parent); level++; parent = units.find(value => value.id === parent)?.parent_id ?? null }
    return level
  }
  function descendants(id: string): Set<string> {
    const found = new Set([id]); let changed = true
    while (changed) { changed = false; units.forEach(value => { if (value.parent_id && found.has(value.parent_id) && !found.has(value.id)) { found.add(value.id); changed = true } }) }
    return found
  }
  const hierarchy: Unit[] = []
  const visited = new Set<string>()
  function append(value: Unit) { if (visited.has(value.id)) return; visited.add(value.id); hierarchy.push(value); units.filter(child => child.parent_id === value.id).forEach(append) }
  units.filter(value => !value.parent_id || !units.some(parent => parent.id === value.parent_id)).forEach(append)
  units.forEach(append)
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError('')
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>
    const attributes = { ...unit?.attributes } as Record<string, unknown>
    const names = kind === 'department' ? ['costCentre', 'headUserId'] : kind === 'location' ? ['stateCode'] : kind === 'grade' ? ['minCtcPaise', 'maxCtcPaise'] : []
    names.forEach(name => { const value = name === 'stateCode' ? stateCode : values[name]; if (value) attributes[name] = name.endsWith('Paise') ? Math.round(Number(value) * 100) : value; else delete attributes[name] })
    try {
      await domainApi(`/org/${kind}${unit ? `/${unit.id}` : ''}`, { ...(unit ? {} : { code: values.code }), name: values.name, sortOrder: Number(values.sortOrder), ...(kind === 'department' ? { parentId: values.parentId || null } : {}), attributes }, unit ? 'PATCH' : 'POST')
      setEditing(null); setMessage('Organisation unit saved. Active units are available in employee pickers.'); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function changeStatus(value: Unit, action: 'retire' | 'reinstate') {
    setBusy(true); setError('')
    try {
      const result = await domainApi<{ inUseBy?: number }>(`/org/${kind}/${value.id}/${action}`, {})
      setRetiring(null); setMessage(action === 'retire' ? `${value.name} retired. ${result.inUseBy ?? 0} assignments remain in history.` : `${value.name} reinstated.`); await load()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <>
    <PageHeader title="Organisation" description="A shared vocabulary for your people, locations and salary grades."><Button onClick={() => { setError(''); setEditing('new') }}>Add {kind}</Button></PageHeader>
    <Card><Tabs value={tab} items={Object.keys(kinds)} onChange={setTab} /><label className="checkbox-field"><input type="checkbox" checked={retired} onChange={e => setRetired(e.target.checked)} />Show retired units</label>
      {message && <p role="status">{message}</p>}{error && !editing && !retiring && <ErrorBox message={error} />}
      {loading ? <p role="status">Loading organisation…</p> : !units.filter(value => retired || value.status === 'active').length ? <Empty title={`No ${tab.toLowerCase()} yet`} text="Add your first master. Employee forms keep free text until active masters exist." /> : <div className="table-scroll"><table><thead><tr><th>Name / code</th><th>Details</th><th>Status</th><th>Actions</th></tr></thead><tbody>
        {hierarchy.filter(value => retired || value.status === 'active').map(value => <tr key={value.id}><td style={{ paddingLeft: `${20 + depth(value) * 20}px` }}><strong>{depth(value) > 0 && '↳ '}{value.name}</strong><small>{value.code}</small></td><td>{kind === 'department' ? <>{String(value.attributes.costCentre ?? 'No cost centre')}<small>Head: {data.employees.find(person => person.user_id === value.attributes.headUserId)?.first_name ?? (value.attributes.headUserId ? 'Assigned user' : 'Unassigned')}</small></> : kind === 'location' ? String(value.attributes.stateCode ?? 'No PT state') : kind === 'grade' ? `${value.attributes.minCtcPaise === undefined ? 'No minimum' : `₹${Number(value.attributes.minCtcPaise) / 100}`} – ${value.attributes.maxCtcPaise === undefined ? 'No maximum' : `₹${Number(value.attributes.maxCtcPaise) / 100}`}` : 'Employee designation'}</td><td>{value.status}</td><td>{value.status === 'active' ? <><Button variant="ghost" onClick={() => { setError(''); setEditing(value) }}>Edit</Button><Button variant="ghost" onClick={() => { setError(''); setRetiring(value) }}>Retire</Button></> : <Button variant="secondary" disabled={busy} onClick={() => void changeStatus(value, 'reinstate')}>Reinstate</Button>}</td></tr>)}
      </tbody></table></div>}
    </Card>
    {editing && <Modal title={`${unit ? 'Edit' : 'Add'} ${kind}`} onClose={() => { if (!busy) setEditing(null) }}><form className="lifecycle-form" onSubmit={save}>
      <label>Permanent code<input name="code" required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,23}" maxLength={24} defaultValue={unit?.code} readOnly={!!unit} /></label>
      <label>Name<input name="name" required maxLength={120} defaultValue={unit?.name} /></label>
      <label>Sort order<input name="sortOrder" type="number" step="1" defaultValue={unit?.sort_order ?? 0} required /></label>
      {kind === 'department' && <><label>Parent department<select name="parentId" defaultValue={unit?.parent_id ?? ''}><option value="">Top level</option>{units.filter(value => value.status === 'active' && (!unit || !descendants(unit.id).has(value.id))).map(value => <option key={value.id} value={value.id}>{value.name}</option>)}</select></label><label>Cost centre<input name="costCentre" defaultValue={String(unit?.attributes.costCentre ?? '')} /></label><label>Department head<select name="headUserId" defaultValue={String(unit?.attributes.headUserId ?? '')}><option value="">Unassigned</option>{!!unit?.attributes.headUserId && !data.employees.some(person => person.user_id === unit.attributes.headUserId) && <option value={String(unit.attributes.headUserId)}>Current assigned user</option>}{data.employees.filter(person => person.user_id && person.status !== 'exited').map(person => <option key={person.id} value={person.user_id!}>{person.first_name} {person.last_name} · {person.employee_number}</option>)}</select></label></>}
      {kind === 'location' && <label>Professional-tax state<PtStatePicker value={stateCode} onChange={setStateCode} onReady={setPtReady} required={false} /></label>}
      {kind === 'grade' && <>{['minCtcPaise', 'maxCtcPaise'].map((name, index) => <label key={name}>{index ? 'Maximum' : 'Minimum'} annual CTC (₹)<input name={name} type="number" min="0" step="0.01" defaultValue={unit?.attributes[name] === undefined ? '' : Number(unit.attributes[name]) / 100} /></label>)}</>}
      {error && <ErrorBox message={error} />}<footer className="modal-actions"><Button type="button" variant="secondary" disabled={busy} onClick={() => setEditing(null)}>Cancel</Button><Button type="submit" disabled={busy || (kind === 'location' && !ptReady)}>{busy ? 'Saving…' : 'Save unit'}</Button></footer>
    </form></Modal>}
    {retiring && <Modal title={`Retire ${retiring.name}?`} onClose={() => { if (!busy) setRetiring(null) }}><p>{retiring.inUseBy} existing assignments use this unit. It will disappear from pickers; existing employment history stays intact.</p>{kind === 'department' && <p>Active child departments must be retired or moved first.</p>}{error && <ErrorBox message={error} />}<footer className="modal-actions"><Button variant="secondary" disabled={busy} onClick={() => setRetiring(null)}>Cancel</Button><Button disabled={busy} onClick={() => void changeStatus(retiring, 'retire')}>{busy ? 'Retiring…' : 'Retire unit'}</Button></footer></Modal>}
  </>
}
