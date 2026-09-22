/**
 * Kiosk: a wall tablet shows the site's QR; people scan it from the punch
 * card. The code changes every minute and is valid for two, so a photo of
 * the screen is useless by the time someone leaves the building.
 */
import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { RotateCcw } from 'lucide-react'
import { domainApi } from '../domainApi'
import { Button, Card, Empty, ErrorBox } from '../ui'
import type { Workspace } from '../types'

interface Site { id: string; code: string; name: string; status?: string }
interface Code { payload: string; siteId: string; siteName: string; expiresAt: string }

export function KioskPage({ data }: { data: Workspace }) {
  const [sites, setSites] = useState<Site[]>([])
  const [siteId, setSiteId] = useState('')
  const [code, setCode] = useState<Code | null>(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState('')
  const [now, setNow] = useState(Date.now())
  const canRotate = data.permissions.includes('attendance.correct')

  useEffect(() => { domainApi<{ sites: Site[] }>('/geofences').then((r) => { const live = r.sites.filter((s) => s.status !== 'retired'); setSites(live); if (live[0] && !siteId) setSiteId(live[0].id) }).catch((e: Error) => setError(e.message)) }, [siteId])
  const load = useCallback(async () => {
    if (!siteId) return
    try {
      const c = await domainApi<Code>(`/attendance/qr?siteId=${siteId}`)
      setCode(c); setError('')
      setSvg(await QRCode.toString(c.payload, { type: 'svg', margin: 1, width: 520, color: { dark: '#123d37', light: '#ffffff' } }))
    } catch (e) { setError((e as Error).message) }
  }, [siteId])
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(t) }, [load])
  useEffect(() => { const t = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(t) }, [])
  const left = code ? Math.max(0, Math.round((Date.parse(code.expiresAt) - now) / 1000)) : 0

  if (!sites.length && !error) return <Card><Empty title="No sites yet" text="Add an office or site under Attendance → Sites; the kiosk shows its code." /></Card>
  return (
    <div className="kiosk">
      <div className="kiosk-head">
        <label className="field compact">
          <span className="sr-only">Site</span>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)}>{sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        </label>
        <Button variant="secondary" onClick={() => document.documentElement.requestFullscreen?.()}>Full screen</Button>
        {canRotate && <Button variant="ghost" onClick={async () => { await domainApi('/attendance/qr/rotate', {}); await load() }}><RotateCcw size={15} aria-hidden="true" />Rotate all codes</Button>}
      </div>
      {error && (/switched off/i.test(error)
        ? <Card><Empty title="QR punch is switched off" text="Turn on “QR kiosk punch” under Company → Settings → Attendance; the kiosk then shows a code that changes every minute." /></Card>
        : <ErrorBox message={error} />)}
      {code && (
        <Card className="kiosk-card">
          <p className="eyebrow">{data.company} · {code.siteName}</p>
          <h1>Scan to punch</h1>
          <div className="kiosk-qr" role="img" aria-label={`QR code for ${code.siteName}, refreshes every minute`} dangerouslySetInnerHTML={{ __html: svg }} />
          <p className="kiosk-timer" aria-live="off">New code in <strong>{String(Math.floor(left / 60))}:{String(left % 60).padStart(2, '0')}</strong></p>
          <p className="subtle">Open PEPL on your phone → Punch → Scan. No location needed at the kiosk.</p>
        </Card>
      )}
    </div>
  )
}
