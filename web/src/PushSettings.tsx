import { useCallback, useEffect, useState } from 'react'
import { BellRing, Laptop, Smartphone, Trash2 } from 'lucide-react'
import { dateLabel } from './api'
import { domainApi } from './domainApi'
import { pushAvailability, removePushDevice, subscribeCurrentDevice, type PushDevice } from './push'
import { Button, Card, Empty, PageHeader } from './ui'

function deviceName(userAgent: string | null): string {
  if (!userAgent) return 'Browser device'
  const browser = /Edg\//.test(userAgent) ? 'Edge' : /Firefox\//.test(userAgent) ? 'Firefox' : /Chrome\//.test(userAgent) ? 'Chrome' : /Safari\//.test(userAgent) ? 'Safari' : 'Browser'
  const platform = /Android/.test(userAgent) ? 'Android' : /iPhone|iPad/.test(userAgent) ? 'iPhone or iPad' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'Mac' : 'device'
  return `${browser} on ${platform}`
}

export function PushSettings() {
  const [support, setSupport] = useState<Awaited<ReturnType<typeof pushAvailability>>>(null)
  const [checked, setChecked] = useState(false)
  const [devices, setDevices] = useState<PushDevice[]>([])
  const [current, setCurrent] = useState<PushSubscription | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')

  const loadDevices = useCallback(async () => {
    const result = await domainApi<{ subscriptions: PushDevice[] }>('/push/subscriptions')
    setDevices(result.subscriptions)
  }, [])

  useEffect(() => {
    let active = true
    void Promise.all([pushAvailability(), loadDevices()]).then(async ([available]) => {
      if (!active) return
      setSupport(available)
      setChecked(true)
      if (available) setCurrent(await available.registration.pushManager.getSubscription())
    }).catch(caught => { if (active) { setChecked(true); setError(caught instanceof Error ? caught.message : 'Unable to load notification settings') } })
    return () => { active = false }
  }, [loadDevices])

  const enable = async () => {
    if (!support) return
    setBusy(true); setError(''); setNotice('')
    try {
      const subscription = await subscribeCurrentDevice(support.registration, support.publicKey)
      setCurrent(subscription); await loadDevices(); setNotice('Notifications are on for this device.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to turn on notifications') }
    finally { setBusy(false) }
  }

  const remove = async (endpoint: string) => {
    setBusy(true); setError(''); setNotice('')
    try {
      await removePushDevice(endpoint, current)
      if (current?.endpoint === endpoint) setCurrent(null)
      await loadDevices(); setNotice('Device removed from notifications.')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to remove this device') }
    finally { setBusy(false) }
  }

  return <>
    <PageHeader title="Notification settings" description="Choose which of your browsers can receive PEPL updates." eyebrow="Your devices" />
    {support && <Card><div className="push-opt-in"><span className="push-hero-icon"><BellRing size={25} /></span><div><h2>{current ? 'Notifications are on' : 'Stay in the loop'}</h2><p>{current ? 'This browser can notify you when PEPL is not in focus.' : 'Turn on alerts for approvals, announcements and conversations.'}</p></div>{current ? <Button variant="secondary" disabled={busy} onClick={() => void remove(current.endpoint)}>Turn off on this device</Button> : Notification.permission === 'denied' ? <p className="push-blocked">Blocked in browser settings</p> : <Button disabled={busy} onClick={() => void enable()}>{busy ? 'Turning on…' : 'Turn on notifications'}</Button>}</div></Card>}
    {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="success-note" role="status">{notice}</p>}
    <Card title="Your notification devices" subtitle="Only devices signed in to your account appear here">
      {!checked ? <p>Checking notification support…</p> : devices.length ? <div className="push-device-list">{devices.map(device => <article key={device.endpoint}><span className="icon-box">{/Android|iPhone|iPad/.test(device.user_agent ?? '') ? <Smartphone size={18} /> : <Laptop size={18} />}</span><div><strong>{deviceName(device.user_agent)}</strong><small>Added {dateLabel(device.created_at)}{device.last_used_at ? ` · Last used ${dateLabel(device.last_used_at)}` : ''}{device.endpoint === current?.endpoint ? ' · This device' : ''}</small></div><Button variant="ghost" disabled={busy} aria-label={`Remove ${deviceName(device.user_agent)}`} onClick={() => void remove(device.endpoint)}><Trash2 size={16} />Remove</Button></article>)}</div> : <Empty title="No devices registered" text="Turn on notifications from a supported browser to add it here." />}
    </Card>
  </>
}
