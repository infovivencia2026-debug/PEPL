/**
 * Control room: who is in, late, missing, on leave, on break — right now.
 * Refreshes every 60 seconds and says when it last did, so a stale board is
 * never mistaken for a quiet day.
 */
import { useCallback, useEffect, useState } from 'react'
import { Coffee, House, MapPinned, RefreshCw, Timer, UserRoundX, Users } from 'lucide-react'
import { domainApi } from '../domainApi'
import { Card, Empty, ErrorBox, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Person { employeeId: string; employeeNumber: string; name: string; department: string | null; location: string | null; firstIn: string | null; lastOut: string | null; lateMinutes: number; lateReason: string | null; onBreak: boolean; mode: 'office' | 'wfh' | 'field'; autoClosed: boolean }
interface Board { date: string; counts: Record<string, number>; in: Person[]; late: Person[]; missing: Person[]; onLeave: Person[]; onBreak: Person[]; byLocation: Array<{ location: string; expected: number; in: number; missing: number }> }
const hm = (iso: string | null): string => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'
const LISTS = ['In', 'Late', 'Missing', 'On leave', 'On break'] as const
const KEY: Record<(typeof LISTS)[number], keyof Board> = { In: 'in', Late: 'late', Missing: 'missing', 'On leave': 'onLeave', 'On break': 'onBreak' }

export function ControlRoom({ data }: { data: Workspace }) {
  const [date, setDate] = useState(data.today)
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<string>('In')
  const [at, setAt] = useState<Date | null>(null)
  const load = useCallback(async () => {
    try {
      const b = await domainApi<Board>(`/attendance/control-room?date=${date}`)
      setBoard(b); setError(''); setAt(new Date())
      // land on the list that has people in it, missing first when nobody is in yet
      setTab((t) => (b[KEY[t as (typeof LISTS)[number]]] as Person[]).length ? t : (['Missing', 'In', 'Late', 'On leave', 'On break'] as const).find((l) => (b[KEY[l]] as Person[]).length) ?? t)
    } catch (e) { setError((e as Error).message) }
  }, [date])
  useEffect(() => { void load(); const t = window.setInterval(() => void load(), 60_000); return () => window.clearInterval(t) }, [load])

  const tiles: Array<{ key: string; label: string; icon: typeof Users; tone?: string }> = [
    { key: 'expected', label: 'Expected', icon: Users }, { key: 'in', label: 'In', icon: Users, tone: 'good' }, { key: 'late', label: 'Late', icon: Timer, tone: 'warn' },
    { key: 'missing', label: 'Missing', icon: UserRoundX, tone: 'bad' }, { key: 'onBreak', label: 'On break', icon: Coffee }, { key: 'onLeave', label: 'On leave', icon: House },
    { key: 'remote', label: 'Remote', icon: House }, { key: 'field', label: 'Field', icon: MapPinned },
  ]
  const rows = board ? (board[KEY[tab as (typeof LISTS)[number]]] as Person[]) : []
  return (
    <>
      <div className="filter-bar control-bar">
        <label className="field compact">
          <span className="sr-only">Date</span>
          <input type="date" value={date} max={data.today} onChange={(e) => setDate(e.target.value)} />
        </label>
        <button type="button" className="btn secondary" onClick={() => void load()}>
          <RefreshCw size={15} aria-hidden="true" />
          {at ? `Updated ${at.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })} · refreshes each minute` : 'Refresh'}
        </button>
      </div>
      {error && <ErrorBox message={error} />}
      {!board ? <Skeleton /> : (
        <>
          <div className="control-tiles">
            {tiles.map((t) => (
              <button type="button" key={t.key} className={`tile ${t.tone ?? ''} ${LISTS.find((l) => KEY[l] === t.key) === tab ? 'active' : ''}`}
                onClick={() => { const l = LISTS.find((x) => KEY[x] === t.key); if (l) setTab(l) }} disabled={!LISTS.some((l) => KEY[l] === t.key)}>
                <t.icon size={18} aria-hidden="true" />
                <strong>{board.counts[t.key] ?? 0}</strong>
                <span>{t.label}</span>
              </button>
            ))}
          </div>
          {board.byLocation.length > 1 && (
            <ul className="location-strip" aria-label="By location">
              {board.byLocation.map((l) => (
                <li key={l.location}>
                  <strong>{l.location || 'No location'}</strong>
                  <span>{l.in} in of {l.expected}{l.missing ? ` · ${l.missing} missing` : ''}</span>
                  <i style={{ width: `${l.expected ? Math.round(l.in / l.expected * 100) : 0}%` }} aria-hidden="true" />
                </li>
              ))}
            </ul>
          )}
          <Card className="data-card">
            <Tabs value={tab} onChange={setTab} items={LISTS.map((l) => `${l}`)} />
            {rows.length === 0 ? <Empty title={`Nobody ${tab.toLowerCase()}`} text={tab === 'Missing' ? 'Everyone expected has punched in.' : 'Nothing to show for this list right now.'} /> : (
              <div className="table-scroll">
                <table>
                  <thead><tr><th>Person</th><th>Department</th><th>Location</th><th>In</th><th>Out</th><th>Mode</th><th>Note</th></tr></thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.employeeId}>
                        <td><strong>{p.name}</strong><br /><small>{p.employeeNumber}</small></td>
                        <td>{p.department ?? '—'}</td>
                        <td>{p.location ?? '—'}</td>
                        <td>{hm(p.firstIn)}{p.lateMinutes ? <small className="inline-note warn"> late {p.lateMinutes} min</small> : null}</td>
                        <td>{hm(p.lastOut)}{p.autoClosed ? <small className="inline-note"> closed automatically at shift end</small> : null}</td>
                        <td>{p.mode === 'wfh' ? <span className="work-mode"><House size={14} aria-hidden="true" />Remote</span> : p.mode === 'field' ? <span className="work-mode"><MapPinned size={14} aria-hidden="true" />Field</span> : <span className="work-mode"><Users size={14} aria-hidden="true" />On site</span>}</td>
                        <td>{p.onBreak ? 'On break' : ''}{p.lateReason ? <em>“{p.lateReason}”</em> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </>
      )}
    </>
  )
}
