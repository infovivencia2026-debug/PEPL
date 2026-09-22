import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronRight, MapPin, Settings2, ShieldCheck, SlidersHorizontal, Users, X } from 'lucide-react'
import { domainApi } from '../domainApi'
import { PtStatePicker } from '../PtStatePicker'
import { GeofenceSites } from '../GeofenceSites'
import { PresetApply } from '../Signup'
import type { Workspace } from '../types'
import { Button, Card, Empty, PageHeader, SearchBox, Skeleton } from '../ui'

type ConfigSetting = {
  key: string; module: string; label: string; help: string; type: string; risk: string
  default: unknown; value: unknown; changedFromDefault: boolean; affectsPayroll: boolean
  requiresEffectiveDate: boolean; entitlement: string | null
}

const nextMonth = (today: string) => {
  const date = new Date(`${today.slice(0, 7)}-01T12:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1)
  return date.toISOString().slice(0, 10)
}

export function SettingsPage({ data }: { data: Workspace }) {
  const [settings, setSettings] = useState<ConfigSetting[]>([])
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('all')
  const [changedOnly, setChangedOnly] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [effectiveFrom, setEffectiveFrom] = useState(nextMonth(data.today))
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [ptReady, setPtReady] = useState(false)
  const load = async () => {
    setLoading(true); setError('')
    try { setSettings((await domainApi<{ settings: ConfigSetting[] }>('/config')).settings) }
    catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to load settings') }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const categories = useMemo(() => ['all', ...new Set(settings.map(setting => setting.module))], [settings])
  const filtered = settings.filter(setting =>
    (category === 'all' || setting.module === category) && (!changedOnly || setting.changedFromDefault) &&
    `${setting.label} ${setting.help} ${setting.key}`.toLowerCase().includes(search.toLowerCase()))
  const begin = (setting: ConfigSetting) => {
    setEditing(setting.key); setValue(String(setting.value)); setReason(''); setEffectiveFrom(nextMonth(data.today)); setError(''); setPtReady(false)
  }
  const save = async (setting: ConfigSetting) => {
    setBusy(true); setError('')
    const parsed = ['bool', 'flag'].includes(setting.type) ? value === 'true' : setting.type === 'int' ? Number(value) : value
    try {
      await domainApi(`/config/${encodeURIComponent(setting.key)}`, { value: parsed, reason, effectiveFrom: setting.requiresEffectiveDate ? effectiveFrom : undefined }, 'PATCH')
      setEditing(null); await load()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save setting') }
    finally { setBusy(false) }
  }
  if (location.hash.replace(/^#\/?/, '') === 'settings/sites') return <><PageHeader title="Attendance sites" description="The trusted places where mobile punches can be recorded." eyebrow="Settings"><a className="btn secondary" href="#/settings">All settings</a></PageHeader><GeofenceSites /></>
  return <><PageHeader title="A workspace that works for you" description="All company policies are generated from the live configuration registry." eyebrow="Settings"><PresetApply onApplied={() => void load()} /><a className="btn secondary" href="#/settings/sites"><MapPin size={15} />Attendance sites</a><label className="changed-filter"><input type="checkbox" checked={changedOnly} onChange={event => setChangedOnly(event.target.checked)} />Show only changed</label></PageHeader>
    <div className="settings-layout"><aside className="settings-sidebar"><div className="company-tile"><span className="icon-box"><Users size={23} /></span><h3>{data.company}</h3><small>{settings.length} live settings</small></div>{categories.map(item => <button className={item === category ? 'active' : ''} key={item} onClick={() => setCategory(item)}><Settings2 size={17} />{item === 'all' ? 'All settings' : item}<ChevronRight size={16} /></button>)}</aside>
      <Card><SearchBox value={search} onChange={setSearch} placeholder="Find a policy or setting..." />{error && <p className="form-error" role="alert">{error}</p>}{loading ? <Skeleton /> : <div className="settings-list">{filtered.length ? filtered.map(setting => <article key={setting.key} className={setting.changedFromDefault ? 'setting-changed' : ''}><div><span className="setting-category">{setting.module}{setting.changedFromDefault ? ' · changed' : ''}</span><h3>{setting.label}</h3><p>{setting.help}</p>{setting.affectsPayroll && <small className="policy-note"><ShieldCheck size={13} />Effective-dated · affects payroll</small>}</div>{editing === setting.key ? <form className="setting-editor" onSubmit={event => { event.preventDefault(); void save(setting) }}><label>Value{setting.key === 'payroll.pt_state_code' ? <PtStatePicker value={value} onChange={setValue} onReady={setPtReady} /> : ['bool', 'flag'].includes(setting.type) ? <select value={value} onChange={event => setValue(event.target.value)}><option value="true">Enabled</option><option value="false">Disabled</option></select> : <input type={setting.type === 'int' ? 'number' : 'text'} value={value} onChange={event => setValue(event.target.value)} />}</label>{setting.requiresEffectiveDate && <label>Effective from<input type="date" required value={effectiveFrom} onChange={event => setEffectiveFrom(event.target.value)} /></label>}<label>Reason<input required value={reason} onChange={event => setReason(event.target.value)} placeholder="Why is this changing?" /></label><div><Button type="button" variant="ghost" onClick={() => setEditing(null)}><X size={15} />Cancel</Button><Button disabled={busy || (setting.key === 'payroll.pt_state_code' && !ptReady)}><Check size={15} />Save</Button></div></form> : <div className="setting-control"><span className={typeof setting.value === 'boolean' ? `toggle-preview ${setting.value ? 'on' : ''}` : 'setting-value'}>{typeof setting.value === 'boolean' ? <i /> : String(setting.value)}</span><Button variant="ghost" onClick={() => begin(setting)}><SlidersHorizontal size={15} />Edit</Button></div>}</article>) : <Empty title="No matching settings" text="Try another search or category." />}</div>}</Card>
    </div></>
}
