import { useEffect, useMemo, useRef, useState } from 'react'
import { Clock3, Coffee, LocateFixed, LogIn, LogOut, Play, QrCode } from 'lucide-react'
import { ScanSheet } from './time/Scan'
import { ApiError } from './api'
import { domainApi } from './domainApi'
import type { Attendance, Workspace } from './types'
import type { RemoteRequest } from './RemoteWork'

type PunchResult = { recorded: boolean; duplicate?: boolean; mode?: 'wfh' | 'field' | null; lateMinutes?: number; reasonRequired?: boolean; geofence: { status: 'inside' | 'outside' | 'unfenced'; siteName?: string; siteCode?: string; distanceM?: number } }

const elapsedLabel = (start: string | null, minutes: number, now: number) => {
  const total = start ? Math.max(minutes, Math.floor((now - new Date(start).getTime()) / 60_000)) : minutes
  return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`
}

export function PunchControl({ data, compact = false }: { data: Workspace; compact?: boolean }) {
  const original = useMemo(() => data.attendance.find(row => row.employee_id === data.user.employeeId && row.work_date === data.today), [data])
  const [day, setDay] = useState<Attendance | undefined>(original)
  const [now, setNow] = useState(Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'wfh' | 'field' | null>(null)
  const pendingId = useRef<string | null>(null)
  const [onBreak, setOnBreak] = useState<{ since: string; kind: string } | null>(null)
  const [lateAsk, setLateAsk] = useState<number | null>(null)
  const [lateReason, setLateReason] = useState('')
  const [scanning, setScanning] = useState(false)
  const punchedIn = Boolean(day?.first_in && !day.last_out)
  useEffect(() => { if (!punchedIn) return; const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer) }, [punchedIn])
  useEffect(() => {
    if (!data.user.employeeId) return
    void domainApi<{ requests: RemoteRequest[] }>(`/attendance/remote-requests?employeeId=${data.user.employeeId}&status=approved&from=${data.today}&to=${data.today}`).then(result => setMode(result.requests[0]?.kind ?? null)).catch(() => undefined)
  }, [data.today, data.user.employeeId])

  const locate = () => new Promise<{ lat: number; lng: number } | undefined>(resolve => {
    if (!navigator.geolocation) { resolve(undefined); return }
    navigator.geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => resolve(undefined),
      { enableHighAccuracy: true, timeout: 10_000, maximumAge: 30_000 },
    )
  })
  useEffect(() => {
    if (!punchedIn) return
    void domainApi<{ breaks: Array<{ kind: string; started_at: string; ended_at: string | null }> }>(`/attendance/breaks?date=${data.today}`).then((r) => { const open = r.breaks.find((b) => !b.ended_at); setOnBreak(open ? { since: open.started_at, kind: open.kind } : null) }).catch(() => undefined)
  }, [punchedIn, data.today])
  const toggleBreak = async () => {
    setBusy(true); setError('')
    try {
      if (onBreak) { await domainApi('/attendance/break/end', {}); setOnBreak(null); setMessage('Back from break.') }
      else { await domainApi('/attendance/break/start', { localDate: data.today }); setOnBreak({ since: new Date().toISOString(), kind: 'break' }); setMessage('On break — the clock pauses if your company deducts breaks.') }
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to record the break.') } finally { setBusy(false) }
  }
  const sendLateReason = async () => {
    if (!lateReason.trim()) return
    setBusy(true)
    try { await domainApi('/attendance/late-reason', { localDate: data.today, reason: lateReason.trim() }); setLateAsk(null); setLateReason(''); setMessage('Thanks — your reason is on the day.') } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to save the reason.') } finally { setBusy(false) }
  }
  const punch = async (qr?: string) => {
    setBusy(true); setError(''); setMessage(qr ? 'Recording your scan…' : 'Finding your location…')
    pendingId.current ??= crypto.randomUUID()
    try {
      const direction = punchedIn ? 'out' : 'in'
      const geo = qr ? undefined : await locate()
      setMessage('Recording your punch…')
      const result = await domainApi<PunchResult>('/attendance/punch', { direction, localDate: data.today, clientPunchId: pendingId.current, ...(geo ? { geo } : {}), ...(qr ? { qr } : {}) })
      if (result.mode !== undefined) setMode(result.mode)
      const stamp = new Date().toISOString()
      setDay(current => ({
        ...(current ?? { employee_id: data.user.employeeId!, first_name: data.user.full_name, last_name: '', employee_number: '', work_date: data.today, first_in: null, last_out: null, worked_minutes: 0, status: 'present', is_remote: false, is_field_duty: false, is_regularized: false, day_fraction: '1' }),
        first_in: direction === 'in' ? stamp : current?.first_in ?? stamp,
        last_out: direction === 'out' ? stamp : null,
      }))
      pendingId.current = null
      const place = result.geofence.status === 'inside' ? ` at ${result.geofence.siteName || result.geofence.siteCode || 'your site'}` : result.geofence.status === 'outside' ? ' outside every site' : ''
      setMessage(`${direction === 'in' ? 'Punched in' : 'Punched out'}${qr ? ' at the kiosk' : place}${result.duplicate ? ' · already recorded' : ''}${result.lateMinutes ? ` · ${result.lateMinutes} min late` : ''}.`)
      if (result.reasonRequired) setLateAsk(result.lateMinutes ?? 0)
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'LOCATION_REQUIRED') setError('Location is required. Enable location access for this site in your browser, then try again.')
      else if (caught instanceof ApiError && caught.code === 'OUTSIDE_GEOFENCE') setError(`You are ${caught.details?.distanceM ?? 'outside'} m from ${caught.details?.siteName ?? caught.details?.siteCode ?? 'the nearest allowed site'}. Move inside the allowed radius and try again.`)
      else if (caught instanceof ApiError && (caught.code === 'QR_INVALID' || caught.code === 'QR_EXPIRED')) setError('That kiosk code has expired or is not ours — scan the screen again.')
      else setError(caught instanceof Error ? caught.message : 'Unable to record your punch.')
      setMessage('')
    } finally { setBusy(false) }
  }
  if (!data.user.employeeId || !data.permissions.includes('attendance.read') || !data.modules.attendance) return null
  return <section className={`punch-control ${compact ? 'compact' : ''}`}>
    {mode && <div className={`punch-mode ${mode}`}><LocateFixed size={15} /><span>{mode === 'wfh' ? 'Working from home today — no location check' : 'On field duty today'}</span></div>}
    <div className="punch-state"><span><Clock3 size={18} /></span><div><small>TODAY</small><strong>{punchedIn ? 'You’re working' : day?.last_out ? 'Day complete' : 'Ready to start'}</strong><p>{day?.first_in ? `${new Date(day.first_in).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${punchedIn ? ` · ${elapsedLabel(day.first_in, day.worked_minutes, now)}` : day.last_out ? ` – ${new Date(day.last_out).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}` : 'No punch recorded yet'}</p></div></div>
    <button className={punchedIn ? 'punch-button out' : 'punch-button'} disabled={busy} onClick={() => void punch()}>{punchedIn ? <LogOut size={22} /> : <LogIn size={22} />}<span>{busy ? 'Please wait…' : punchedIn ? 'Punch Out' : 'Punch In'}</span><LocateFixed size={15} /></button>
    <div className="punch-extras">
      {punchedIn && <button type="button" className={`btn ${onBreak ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => void toggleBreak()}>{onBreak ? <Play size={15} aria-hidden="true" /> : <Coffee size={15} aria-hidden="true" />}{onBreak ? `Resume · on break ${elapsedLabel(onBreak.since, 0, now)}` : 'Break'}</button>}
      <button type="button" className="btn ghost" disabled={busy} onClick={() => setScanning(true)}><QrCode size={15} aria-hidden="true" />Scan kiosk</button>
    </div>
    {lateAsk !== null && <form className="late-sheet" onSubmit={(e) => { e.preventDefault(); void sendLateReason() }}>
      <label className="field"><span>You’re {lateAsk} minutes late — why?</span><input autoFocus value={lateReason} maxLength={300} onChange={(e) => setLateReason(e.target.value)} placeholder="Traffic on the ring road, doctor’s visit…" required /></label>
      <div className="decision-actions"><button className="btn primary" disabled={busy || !lateReason.trim()}>Save reason</button><button type="button" className="btn ghost" onClick={() => setLateAsk(null)}>Later</button></div>
    </form>}
    {scanning && <ScanSheet onClose={() => setScanning(false)} onCode={(payload) => { setScanning(false); void punch(payload) }} />}
    {(message || error) && <p className={error ? 'punch-message error' : 'punch-message'} role={error ? 'alert' : 'status'} aria-live="polite">{error || message}</p>}
  </section>
}
