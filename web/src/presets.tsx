/**
 * Organisation presets — "what kind of company is this?" — which decide which
 * modules are on, the shift patterns and the payroll defaults.
 *
 * This was once the second half of a public signup screen. There is no public
 * signup any more: PEPL is sold by salespeople and a company is created from
 * the back office (`npm run ops create`), so all that survives is an admin
 * re-applying a preset inside their OWN company, from Settings.
 */
import { useEffect, useState, type FormEvent } from 'react'
import { Check } from 'lucide-react'
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

/** Company → Settings: re-apply a preset, after saying what will change. */
export function PresetApply({ onApplied }: { onApplied: () => void }) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<Preset[]>([])
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [done, setDone] = useState<{ settings: number; shifts: number } | null>(null)
  useEffect(() => { if (open && !presets.length) domainApi<{ presets: Preset[] }>('/presets').then((r) => setPresets(r.presets)).catch((e: Error) => setError(e.message)) }, [open, presets.length])
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
