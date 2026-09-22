/**
 * Signup: company and admin details, then "what kind of organisation?" — six
 * cards that decide the presets (modules on, shifts, payroll defaults). The
 * company is created on the trial and the admin is signed straight in.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { api, ApiError, toErrorView, type ErrorView } from './api'
import { domainApi } from './domainApi'
import { Button, Card, ErrorBox, Modal } from './ui'

export interface Preset { code: string; label: string; description: string; examples: string; modulesOn: string[]; shifts: string[] }

export function PresetCards({ presets, value, onChange }: { presets: Preset[]; value: string; onChange: (code: string) => void }) {
  return (
    <div className="preset-grid" role="radiogroup" aria-label="Kind of organisation">
      {presets.map((p) => (
        <button type="button" key={p.code} role="radio" aria-checked={value === p.code} className={`preset-card ${value === p.code ? 'picked' : ''}`} onClick={() => onChange(p.code)}>
          <span className="preset-check" aria-hidden="true">{value === p.code && <Check size={14} />}</span>
          <strong>{p.label}</strong>
          <p>{p.description}</p>
          <small>e.g. {p.examples}</small>
          <ul aria-label="Switches on">{p.modulesOn.map((m) => <li key={m}>{m}</li>)}</ul>
        </button>
      ))}
    </div>
  )
}

const STATES = ['AP', 'AR', 'AS', 'BR', 'CG', 'DL', 'GA', 'GJ', 'HR', 'HP', 'JH', 'KA', 'KL', 'MP', 'MH', 'MN', 'ML', 'MZ', 'NL', 'OR', 'PB', 'RJ', 'SK', 'TN', 'TS', 'TR', 'UP', 'UK', 'WB']

export function Signup({ onSignedIn }: { onSignedIn: () => Promise<void> }) {
  const [step, setStep] = useState<1 | 2>(1)
  const [presets, setPresets] = useState<Preset[]>([])
  const [form, setForm] = useState({ legalName: '', displayName: '', adminName: '', adminEmail: '', password: '', stateCode: 'KA' })
  const [type, setType] = useState('office')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ErrorView | null>(null)
  useEffect(() => { domainApi<{ presets: Preset[] }>('/signup/presets').then((r) => setPresets(r.presets)).catch(() => setPresets([])) }, [])
  const next = (e: FormEvent) => { e.preventDefault(); setStep(2) }
  async function create() {
    setBusy(true); setError(null)
    try {
      await domainApi('/signup', { ...form, displayName: form.displayName || undefined, organisationType: type })
      await api('/auth/login', { email: form.adminEmail, password: form.password })
      location.hash = '#/dashboard'
      await onSignedIn()
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'EMAIL_TAKEN' ? { ...toErrorView(e), message: 'That email already has an account — sign in instead.' } : toErrorView(e))
      setBusy(false)
    }
  }
  return (
    <div className="signup-page">
      <Card>
        <span className="eyebrow">PEPL · Start your company</span>
        <ol className="signup-steps" aria-label="Progress">
          <li className={step === 1 ? 'now' : 'done'}>Company &amp; you</li>
          <li className={step === 2 ? 'now' : ''}>Kind of organisation</li>
        </ol>
        {step === 1 ? (
          <form className="signup-form" onSubmit={next}>
            <h1>Tell us about the company</h1>
            <label className="field"><span>Legal name</span><input required value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} placeholder="Acme Technologies Pvt Ltd" autoFocus /></label>
            <div className="two-up">
              <label className="field"><span>Short name (optional)</span><input value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} placeholder="Acme" /></label>
              <label className="field"><span>State (for professional tax)</span><select value={form.stateCode} onChange={(e) => setForm({ ...form, stateCode: e.target.value })}>{STATES.map((s) => <option key={s}>{s}</option>)}</select></label>
            </div>
            <h2>Your admin login</h2>
            <div className="two-up">
              <label className="field"><span>Your name</span><input required value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} autoComplete="name" /></label>
              <label className="field"><span>Work email</span><input required type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} autoComplete="username" /></label>
            </div>
            <label className="field"><span>Password (10+ characters)</span><input required minLength={10} type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} autoComplete="new-password" /></label>
            <div className="decision-actions"><Button>Next <ArrowRight size={16} aria-hidden="true" /></Button><a className="link-btn" href="#/dashboard">I already have an account</a></div>
          </form>
        ) : (
          <>
            <h1>What kind of organisation?</h1>
            <p className="subtle">This sets sensible defaults — which modules are on, shift patterns, payroll conventions. Everything can be changed later.</p>
            {presets.length ? <PresetCards presets={presets} value={type} onChange={setType} /> : <p className="subtle">Loading presets…</p>}
            {error && <ErrorBox message={error.message} requestId={error.requestId} />}
            <div className="decision-actions">
              <Button disabled={busy} onClick={() => void create()}>{busy ? 'Creating your company…' : 'Create company'}</Button>
              <Button variant="ghost" type="button" disabled={busy} onClick={() => setStep(1)}>Back</Button>
            </div>
            <p className="subtle">14-day trial, no card. Your data lives in India.</p>
          </>
        )}
      </Card>
    </div>
  )
}

/** Company → Settings: re-apply a preset, after saying what will change. */
export function PresetApply({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<Preset[]>([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ settings: number; shifts: number } | null>(null)
  useEffect(() => { if (open && !presets.length) domainApi<{ presets: Preset[] }>('/signup/presets').then((r) => setPresets(r.presets)).catch((e: Error) => setError(e.message)) }, [open, presets.length])
  const picked = presets.find((p) => p.code === code)
  async function apply() {
    setBusy(true); setError('')
    try { setDone(await domainApi<{ settings: number; shifts: number }>(`/settings/presets/${code}/apply`, {})); onApplied() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>Start from a preset</Button>
      {open && (
        <Modal title="Start from a preset" wide onClose={() => { setOpen(false); setDone(null); setCode('') }}>
          {done ? (
            <div className="issued-ok" role="status"><Check size={18} aria-hidden="true" /><div><strong>Applied.</strong><p>{done.settings} settings changed and {done.shifts} shift pattern{done.shifts === 1 ? '' : 's'} added. Payroll-affecting keys take effect from the 1st of next month.</p></div></div>
          ) : (
            <>
              <p className="subtle">Pick the kind of organisation this company most resembles. Existing values are overwritten by the preset’s; payroll-affecting keys change from the 1st of next month, never mid-cycle.</p>
              <PresetCards presets={presets} value={code} onChange={setCode} />
              {picked && (
                <div className="paper-note">
                  <strong>This will</strong> switch on {picked.modulesOn.join(', ') || 'no extra modules'}{picked.shifts.length ? `, add shifts (${picked.shifts.join(', ')})` : ''}, and set that type’s attendance, leave and payroll defaults. Every change is in the audit log with your name.
                </div>
              )}
              {error && <ErrorBox message={error} />}
              <div className="decision-actions"><Button disabled={!code || busy} onClick={() => void apply()}>{busy ? 'Applying…' : 'Apply preset'}</Button><Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
            </>
          )}
        </Modal>
      )}
    </>
  )
}
