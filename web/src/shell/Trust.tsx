/**
 * The public trust page: what the platform enforces (as facts the code
 * enforces, not marketing), 30 days of uptime from the scheduler's own
 * heartbeat, the incident log, and who else touches the data. No login.
 */
import { useEffect, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { domainApi } from '../domainApi'
import { Card, ErrorBox, Skeleton } from '../ui'

interface Trust {
  status: 'operational' | 'degraded' | 'outage' | 'maintenance'
  commitments: ReadonlyArray<{ key: string; title: string; detail: string }>
  subprocessors: Array<{ name: string; purpose: string; data: string }>
  uptime: { days: number; samples: number; readyPct: number | null; p95LatencyMs: number | null; daily: Array<{ day: string; readyPct: number | null; samples: number }> }
  incidents: Array<{ id: string; title: string; severity: string; started_at: string; resolved_at: string | null; updates: Array<{ at: string; note: string }> }>
}
const STATUS_TEXT: Record<Trust['status'], string> = { operational: 'All systems operational', degraded: 'Degraded performance', outage: 'Service disruption', maintenance: 'Planned maintenance' }

export function TrustPage() {
  const [t, setT] = useState<Trust | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { domainApi<Trust>('/trust').then(setT).catch((e: Error) => setError(e.message)) }, [])
  return (
    <div className="trust-page">
      <header className="trust-head">
        <span className="eyebrow">PEPL · Trust</span>
        <h1>What we promise, and how it is enforced</h1>
        <p>Every statement here is something the code does, not something we intend to do. Uptime is measured by the product itself, once a minute.</p>
      </header>
      {error && <ErrorBox message={error} />}
      {!t ? <Skeleton /> : (
        <>
          <Card className="trust-status">
            <span className={`status-dot ${t.status}`} aria-hidden="true" />
            <div>
              <h2>{STATUS_TEXT[t.status]}</h2>
              <p className="subtle">{t.uptime.readyPct === null ? 'Not enough samples yet' : `${t.uptime.readyPct}% ready over ${t.uptime.days} days`}{t.uptime.p95LatencyMs ? ` · p95 check ${t.uptime.p95LatencyMs} ms` : ''}</p>
            </div>
            <ol className="uptime-strip" aria-label={`Daily readiness over ${t.uptime.days} days`}>
              {t.uptime.daily.map((d) => (
                <li key={d.day} className={d.readyPct === null ? 'none' : d.readyPct >= 99.5 ? 'ok' : d.readyPct >= 95 ? 'warn' : 'bad'}
                  title={`${d.day}: ${d.readyPct ?? '—'}% of ${d.samples} checks`}>
                  <span className="sr-only">{d.day}: {d.readyPct ?? 'no'} per cent ready</span>
                </li>
              ))}
            </ol>
          </Card>
          <section aria-label="Commitments">
            <h2 className="trust-section">What the platform enforces</h2>
            <div className="template-grid">
              {t.commitments.map((c) => (
                <Card key={c.key}>
                  <strong><ShieldCheck size={16} aria-hidden="true" /> {c.title}</strong>
                  <p className="subtle">{c.detail}</p>
                </Card>
              ))}
            </div>
          </section>
          <section aria-label="Incidents">
            <h2 className="trust-section">Incidents</h2>
            {!t.incidents.length ? <Card><p className="subtle">No incidents recorded.</p></Card> : (
              <ol className="incident-list">
                {t.incidents.map((i) => (
                  <li key={i.id}>
                    <div className="approval-full-head">
                      <strong>{i.title}</strong>
                      <span className={`badge ${i.resolved_at ? 'green' : 'coral'}`}><span />{i.resolved_at ? 'resolved' : i.severity.replace('_', ' ')}</span>
                    </div>
                    <p className="subtle">{new Date(i.started_at).toLocaleString('en-IN')}{i.resolved_at ? ` → ${new Date(i.resolved_at).toLocaleString('en-IN')}` : ''}</p>
                    <ul className="plain-list">{i.updates.map((u, j) => <li key={j}><small>{new Date(u.at).toLocaleString('en-IN')}</small> {u.note}</li>)}</ul>
                  </li>
                ))}
              </ol>
            )}
          </section>
          <section aria-label="Subprocessors">
            <h2 className="trust-section">Who else touches the data</h2>
            <Card className="data-card">
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Service</th><th>Why</th><th>What it sees</th></tr></thead>
                  <tbody>{t.subprocessors.map((s) => <tr key={s.name}><td><strong>{s.name}</strong></td><td>{s.purpose}</td><td>{s.data}</td></tr>)}</tbody>
                </table>
              </div>
            </Card>
          </section>
          <p className="trust-foot"><a href="#/dashboard">Back to PEPL</a></p>
        </>
      )}
    </div>
  )
}
