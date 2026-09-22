/**
 * Camera scanner for the kiosk QR. Decodes in the browser with jsQR; when
 * there is no camera (or permission is refused) the same sheet takes the
 * payload typed or pasted, so a broken camera never blocks a punch.
 */
import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { X } from 'lucide-react'

export function ScanSheet({ onCode, onClose }: { onCode: (payload: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  useEffect(() => {
    let stream: MediaStream | null = null
    let raf = 0
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    const tick = () => {
      const v = video.current
      if (v && ctx && v.readyState >= 2) {
        canvas.width = v.videoWidth; canvas.height = v.videoHeight
        ctx.drawImage(v, 0, 0)
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
        const hit = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
        if (hit?.data) { onCode(hit.data); return }
      }
      raf = requestAnimationFrame(tick)
    }
    navigator.mediaDevices?.getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => { stream = s; if (video.current) { video.current.srcObject = s; void video.current.play() } raf = requestAnimationFrame(tick) })
      .catch(() => setError('Camera not available — paste the code shown under the QR instead.'))
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', esc)
    return () => { cancelAnimationFrame(raf); stream?.getTracks().forEach((t) => t.stop()); window.removeEventListener('keydown', esc) }
  }, [onCode, onClose])
  return (
    <div className="scan-sheet" role="dialog" aria-modal="true" aria-label="Scan the kiosk code">
      <div className="scan-box">
        <button type="button" className="btn ghost scan-close" onClick={onClose} aria-label="Close scanner"><X size={18} aria-hidden="true" /></button>
        <h2>Point at the kiosk screen</h2>
        {!error && <video ref={video} muted playsInline aria-label="Camera preview" />}
        {error && <p className="punch-message error" role="alert">{error}</p>}
        <form className="scan-manual" onSubmit={(e) => { e.preventDefault(); if (manual.trim()) onCode(manual.trim()) }}>
          <label className="field"><span>Or enter the code</span><input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="Paste the kiosk code" /></label>
          <button className="btn primary" disabled={!manual.trim()}>Punch</button>
        </form>
      </div>
    </div>
  )
}
