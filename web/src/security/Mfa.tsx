/**
 * Two-factor authentication, in three places:
 *   MfaGate      the full-screen code prompt after login (401 MFA_REQUIRED),
 *                and the enrolment flow when the company requires admins to
 *                enrol (403 MFA_ENROLMENT_REQUIRED)
 *   SecurityCard status, set up / disable, recovery codes left (Account)
 *   RecheckModal a code prompt for sensitive actions (403 MFA_RECHECK_REQUIRED)
 * Recovery codes are shown exactly once, with copy and download; the server
 * never returns them again.
 */
import { useEffect, useState, type FormEvent } from 'react'
import QRCode from 'qrcode'
import { Copy, Download, KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'
import { ApiError } from '../api'
import { domainApi, downloadFile } from '../domainApi'
import { Button, Card, ErrorBox, Modal } from '../ui'

export interface MfaStatus { enabled: boolean; pendingSetup: boolean; recoveryCodesLeft: number; enabledAt: string | null; sessionVerifiedAt: string | null }

function CodeInput({ onSubmit, busy, label = 'Six-digit code, or a recovery code' }: { onSubmit: (code: string) => void; busy: boolean; label?: string }) {
  const [code, setCode] = useState('')
  const submit = (e: FormEvent) => { e.preventDefault(); if (code.trim()) onSubmit(code.trim()) }
  return (
    <form className="mfa-form" onSubmit={submit}>
      <label className="field"><span>{label}</span><input autoFocus inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="123 456" maxLength={32} /></label>
      <Button disabled={busy || !code.trim()}>{busy ? 'Checking…' : 'Continue'}</Button>
    </form>
  )
}

/** Set up: QR + secret → code → recovery codes shown once. */
function Enrol({ onDone, note }: { onDone: () => Promise<void>; note?: string }) {
  const [setup, setSetup] = useState<{ secret: string; otpauth: string } | null>(null)
  const [svg, setSvg] = useState('')
  const [codes, setCodes] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    domainApi<{ secret: string; otpauth: string }>('/auth/mfa/setup', {}).then(async (s) => { setSetup(s); setSvg(await QRCode.toString(s.otpauth, { type: 'svg', margin: 1, width: 220, color: { dark: '#123d37', light: '#ffffff' } })) }).catch((e: Error) => setError(e.message))
  }, [])
  async function enable(code: string) {
    setBusy(true); setError('')
    try { setCodes((await domainApi<{ recoveryCodes: string[] }>('/auth/mfa/enable', { code })).recoveryCodes) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  if (codes) {
    const text = codes.join('\n')
    return (
      <div className="mfa-codes">
        <h3><ShieldCheck size={18} aria-hidden="true" /> Two-factor authentication is on</h3>
        <p>These recovery codes let you in if you lose your phone. <strong>They are shown once.</strong> Each works one time.</p>
        <ol>{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
        <div className="decision-actions">
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(text)}><Copy size={15} aria-hidden="true" />Copy</Button>
          <Button variant="secondary" onClick={() => downloadFile('pepl-recovery-codes.txt', 'text/plain', text)}><Download size={15} aria-hidden="true" />Download</Button>
          <Button onClick={() => void onDone()}>I have saved them</Button>
        </div>
      </div>
    )
  }
  return (
    <div className="mfa-enrol">
      {note && <p className="paper-note">{note}</p>}
      <ol className="steps">
        <li className="now"><span className="step-title">1 · Scan with Google Authenticator, Authy or 1Password</span>
          {svg ? <div className="mfa-qr" role="img" aria-label="Authenticator QR code" dangerouslySetInnerHTML={{ __html: svg }} /> : <p className="subtle">Preparing…</p>}
          {setup && <p className="subtle">Can’t scan? Enter this key: <code className="secret">{setup.secret}</code></p>}
        </li>
        <li className={setup ? 'now' : ''}><span className="step-title">2 · Enter the code it shows</span>
          <CodeInput onSubmit={(c) => void enable(c)} busy={busy} label="Six-digit code" />
        </li>
      </ol>
      {error && <ErrorBox message={error} />}
    </div>
  )
}

/** Full-screen: finish signing in with a code, or enrol when the company requires it. */
export function MfaGate({ mode, onVerified, onSignOut }: { mode: 'verify' | 'enrol'; onVerified: () => Promise<void>; onSignOut: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function verify(code: string) {
    setBusy(true); setError('')
    try { await domainApi('/auth/mfa/verify', { code }); await onVerified() } catch (e) { setError(e instanceof ApiError && e.code === 'MFA_CODE_INVALID' ? 'That code did not match. Codes change every 30 seconds — try the current one.' : (e as Error).message) } finally { setBusy(false) }
  }
  return (
    <div className="mfa-gate">
      <Card>
        <span className="eyebrow">PEPL · Sign in</span>
        {mode === 'verify' ? (
          <>
            <h1>One more step</h1>
            <p>Open your authenticator app and enter the code for PEPL.</p>
            <CodeInput onSubmit={(c) => void verify(c)} busy={busy} />
            {error && <ErrorBox message={error} />}
          </>
        ) : (
          <>
            <h1>Set up two-factor authentication</h1>
            <Enrol note="Your company requires administrators to use a second factor. It takes a minute." onDone={onVerified} />
          </>
        )}
        <button type="button" className="link-btn" onClick={onSignOut}>Sign out instead</button>
      </Card>
    </div>
  )
}

/** Account → Security. */
export function SecurityCard({ canReset, users }: { canReset: boolean; users: Array<{ id: string; name: string }> }) {
  const [status, setStatus] = useState<MfaStatus | null>(null)
  const [error, setError] = useState('')
  const [enrolling, setEnrolling] = useState(false)
  const [disabling, setDisabling] = useState(false)
  const [busy, setBusy] = useState(false)
  const [resetUser, setResetUser] = useState('')
  const [notice, setNotice] = useState('')
  const load = async () => { try { setStatus(await domainApi<MfaStatus>('/auth/mfa')) } catch (e) { setError((e as Error).message) } }
  useEffect(() => { void load() }, [])
  async function disable(code: string) {
    setBusy(true); setError('')
    try { await domainApi('/auth/mfa/disable', { code }); setDisabling(false); await load() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  async function reset() {
    setBusy(true); setError(''); setNotice('')
    try { await domainApi(`/auth/mfa/reset/${resetUser}`, {}); setNotice('Their second factor is cleared; they will be asked to set it up again at next sign-in.'); setResetUser('') } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <>
      <Card title="Two-factor authentication" subtitle="A code from your phone in addition to your password.">
        {!status ? <p className="subtle">Loading…</p> : enrolling ? <Enrol onDone={async () => { setEnrolling(false); await load() }} /> : (
          <div className="mfa-status">
            <div className={`mfa-pill ${status.enabled ? 'on' : 'off'}`}>{status.enabled ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldOff size={16} aria-hidden="true" />}{status.enabled ? 'On' : 'Off'}</div>
            <div>
              {status.enabled ? (
                <p>Enabled {status.enabledAt ? new Date(status.enabledAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : ''} · <strong>{status.recoveryCodesLeft}</strong> recovery code{status.recoveryCodesLeft === 1 ? '' : 's'} left{status.recoveryCodesLeft <= 2 ? ' — disable and set up again to get a fresh set' : ''}</p>
              ) : <p>Anyone with your password can sign in as you. A second factor stops that.</p>}
              <div className="decision-actions">
                {status.enabled ? <Button variant="secondary" onClick={() => setDisabling(true)}>Disable</Button> : <Button onClick={() => setEnrolling(true)}><KeyRound size={15} aria-hidden="true" />Set up</Button>}
              </div>
            </div>
          </div>
        )}
        {error && <ErrorBox message={error} />}
      </Card>
      {disabling && (
        <Modal title="Disable two-factor authentication" onClose={() => setDisabling(false)}>
          <p>Enter a current code to confirm it is you.</p>
          <CodeInput onSubmit={(c) => void disable(c)} busy={busy} />
          {error && <ErrorBox message={error} />}
        </Modal>
      )}
      {canReset && (
        <Card title="Reset a colleague’s second factor" subtitle="For a lost phone. Audited; they set it up again at next sign-in.">
          <div className="bank-file-controls">
            <label>Colleague<select value={resetUser} onChange={(e) => setResetUser(e.target.value)}><option value="">Choose colleague</option>{users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <Button variant="danger" disabled={busy || !resetUser} onClick={() => void reset()}>Reset their 2FA</Button>
          </div>
          {notice && <p role="status" className="success-note">{notice}</p>}
        </Card>
      )}
    </>
  )
}

/** A sensitive action asked for a fresh code. Verify, then the caller retries. */
export function RecheckModal({ onVerified, onClose }: { onVerified: () => void; onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function verify(code: string) {
    setBusy(true); setError('')
    try { await domainApi('/auth/mfa/verify', { code }); onVerified() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Confirm it’s you" onClose={onClose}>
      <p>This action moves money or locks a record. Enter the current code from your authenticator to continue.</p>
      <CodeInput onSubmit={(c) => void verify(c)} busy={busy} />
      {error && <ErrorBox message={error} />}
    </Modal>
  )
}
