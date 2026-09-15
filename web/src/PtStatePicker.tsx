import { useEffect, useState } from 'react'
import { domainApi } from './domainApi'
import { dateLabel } from './api'

interface State { code: string; name: string; verifiedOn?: string; note?: string | null; loaded?: boolean; exempt?: boolean }
export function PtStatePicker({ value, onChange, onReady, required = true }: {
  value: string; onChange: (value: string) => void; onReady: (ready: boolean) => void; required?: boolean
}) {
  const [states, setStates] = useState<State[]>([]), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  useEffect(() => {
    let active = true
    domainApi<{ states: State[]; exempt: State[] }>('/statutory/pt-states').then(result => {
      if (active) setStates([...result.states, ...result.exempt.map(state => ({ ...state, exempt: true }))].sort((a, b) => a.name.localeCompare(b.name)))
    }).catch(e => { if (active) setError((e as Error).message) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [])
  useEffect(() => { onReady(!loading && !error && (!value || states.some(state => state.code === value))) }, [loading, error, value, states, onReady])
  const selected = states.find(state => state.code === value)
  return <><select aria-label="Professional-tax state" required={required} disabled={loading || !!error} value={value} onChange={event => onChange(event.target.value)}><option value="">{loading ? 'Loading state coverage…' : 'Select a state'}</option>{value && !selected && <option value={value} disabled>Unknown state · {value}</option>}{states.map(state => <option key={state.code} value={state.code}>{state.name} · {state.code}{state.exempt ? ' — no professional tax' : state.loaded === false ? ' — no slabs loaded' : ''}</option>)}</select>{error && <small role="alert">{error}</small>}{selected && <small className="pt-coverage-note">{selected.exempt ? 'No professional tax.' : <>{selected.verifiedOn && `Verified ${dateLabel(selected.verifiedOn)}. `}{selected.note && `${selected.note} `}{selected.loaded === false ? 'No slabs loaded — ask your administrator to run the statutory seed.' : 'Reference figures — reconcile against current statutory requirements.'}</>}</small>}</>
}
