import { useEffect, useState, type FormEvent } from 'react'
import { domainApi } from './domainApi'
import { ApprovalSubmission, type HeldChange } from './ApprovalSubmission'
import { ArrowRight, Check } from 'lucide-react'
import { api } from './api'
import { Button, ErrorBox, Modal } from './ui'
import { toErrorView, type ErrorView } from './api'
export interface Field {
  name: string
  label: string
  type?: string
  value?: string
  required?: boolean
  options?: { value: string; label: string }[]
  help?: string
  min?: string
  max?: string
}
export interface FormSpec {
  title: string
  description?: string
  path: string
  fields: Field[]
  submit?: string
  transform?: (values: Record<string, string>) => unknown
  success?: string
  domain?: boolean
}
export function ActionForm({
  spec,
  onClose,
  onSuccess,
}: {
  spec: FormSpec
  onClose: () => void
  onSuccess: (message: string) => Promise<void>
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<ErrorView | null>(null)
  const hasMasters = spec.fields.some(field => field.name === 'department' || field.name === 'designation')
  const [fields, setFields] = useState(spec.fields)
  const [mastersLoading, setMastersLoading] = useState(hasMasters)
  const [mastersFailed, setMastersFailed] = useState(false)
  const [held, setHeld] = useState<HeldChange[]>([])
  useEffect(() => {
    let cancelled = false
    setFields(spec.fields); setMastersFailed(false); setMastersLoading(hasMasters)
    if (!hasMasters) return
    const kinds = ['department', 'designation'].filter(kind => spec.fields.some(field => field.name === kind))
    Promise.all(kinds.map(async kind => {
      const result = await domainApi<{ units: { code: string; name: string }[] }>(`/org/${kind}`)
      return { kind, units: result.units }
    })).then(results => {
      if (cancelled) return
      setFields(spec.fields.map(field => {
        const master = results.find(result => result.kind === field.name)
        if (!master?.units.length) return field
        const selected = master.units.find(unit => unit.code === field.value || unit.name === field.value)
        return { ...field, value: selected?.code ?? '', options: master.units.map(unit => ({ value: unit.code, label: `${unit.name} · ${unit.code}` })), help: 'Choose an active organisation unit.' }
      }))
    }).catch(e => { if (!cancelled) { setMastersFailed(true); setError(toErrorView(e)) } }).finally(() => { if (!cancelled) setMastersLoading(false) })
    return () => { cancelled = true }
  }, [spec, hasMasters])
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const values = Object.fromEntries(
        new FormData(e.currentTarget),
      ) as Record<string, string>
      const result = await (spec.domain ? domainApi : api)<{
        applied?: boolean
        deferredToPeriodId?: string
        results?: { deferredToPeriodId?: string }[]
        held?: true | HeldChange[]
        pendingId?: string
        approvalRequestId?: string
        chain?: string
      }>(spec.path, spec.transform ? spec.transform(values) : values)
      if (result.held) {
        setHeld(Array.isArray(result.held) ? result.held : [{ pendingId: result.pendingId!, approvalRequestId: result.approvalRequestId!, chain: result.chain! }])
        return
      }
      await onSuccess(
        result.deferredToPeriodId || result.results?.some(item => item.deferredToPeriodId)
          ? 'Correction recorded for the next open period.'
          : (spec.success ?? 'Changes saved.'),
      )
      onClose()
    } catch (e) {
      setError(toErrorView(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title={spec.title}
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      {held.length ? <><ApprovalSubmission changes={held} /><footer className="modal-actions"><Button onClick={onClose}>Close</Button></footer></> : <form onSubmit={submit}>
        {spec.description && <p className="form-intro">{spec.description}</p>}
        <div className="form-grid">
          {mastersLoading ? <p role="status">Loading organisation pickers…</p> : fields.map((f) => (
            <label
              key={f.name}
              className={`field ${f.type === 'textarea' ? 'full' : ''}`}
            >
              <span>
                {f.label}
                {f.required !== false && <i> *</i>}
              </span>
              {f.options ? (
                <select
                  name={f.name}
                  defaultValue={f.value ?? ''}
                  required={f.required !== false}
                >
                  <option value="" disabled>
                    Select {f.label.toLowerCase()}
                  </option>
                  {f.options.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              ) : f.type === 'textarea' ? (
                <textarea
                  name={f.name}
                  defaultValue={f.value}
                  required={f.required !== false}
                  maxLength={2000}
                  rows={3}
                />
              ) : (
                <input
                  name={f.name}
                  type={f.type ?? 'text'}
                  defaultValue={f.value}
                  required={f.required !== false}
                  min={f.min}
                  max={f.max}
                  maxLength={f.type === 'password' ? 1024 : 200}
                />
              )}{' '}
              {f.help && <small>{f.help}</small>}
            </label>
          ))}
        </div>
        {error && (
          <ErrorBox message={error.message} requestId={error.requestId} />
        )}
        <footer className="modal-actions">
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || mastersLoading || mastersFailed} type="submit">
            {busy ? 'Saving…' : (spec.submit ?? 'Save changes')}
            <Check size={17} />
          </Button>
        </footer>
      </form>}
    </Modal>
  )
}
export function Login({ onSuccess }: { onSuccess: () => Promise<void> }) {
  const [error, setError] = useState<ErrorView | null>(null),
    [busy, setBusy] = useState(false)
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const b = Object.fromEntries(new FormData(e.currentTarget))
    setBusy(true)
    setError(null)
    try {
      await api('/auth/login', b)
      await onSuccess()
    } catch (e) {
      setError(toErrorView(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="login-layout">
      <section className="login-art">
        <span className="eyebrow">A little more human.</span>
        <h1>
          Great work
          <br />
          starts with
          <br />
          <em>your people.</em>
        </h1>
        <div className="orbital-art" aria-hidden="true">
          <span />
          <span />
          <span />
          <div>p.</div>
        </div>
        <p>
          One thoughtful space for the everyday
          <br />
          and everything your team becomes.
        </p>
        <span className="login-footer">PEPL · People, at the heart.</span>
      </section>
      <section className="login-form">
        <div className="login-heading">
          <span className="eyebrow">Welcome to your workspace</span>
          <h2>Good to have you here.</h2>
          <p>Sign in to take care of what matters.</p>
        </div>
        <form onSubmit={submit}>
          <label className="field">
            <span>Work email</span>
            <input
              name="email"
              type="email"
              placeholder="you@company.com"
              autoComplete="username"
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              name="password"
              type="password"
              placeholder="Enter your password"
              autoComplete="current-password"
              required
            />
          </label>
          {error && (
          <ErrorBox message={error.message} requestId={error.requestId} />
        )}
          <Button type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Enter your workspace'}
            <ArrowRight size={19} />
          </Button>
          <p className="login-help">
            <a href="#/forgot-password">Forgot password?</a><br />
            Need access? Your company administrator can set up your account.
          </p>
        </form>
        <div className="login-note">
          <span className="status-dot" /> Your company. Your people. One secure
          space.
        </div>
      </section>
    </div>
  )
}
