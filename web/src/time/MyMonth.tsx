/**
 * My month: the person's own attendance as a calendar. The cells are the
 * same classification payroll freezes, so what you see here is what your
 * payslip will count. Tap a day for in / out / worked time.
 */
import { useEffect, useState } from 'react'
import { domainApi } from '../domainApi'
import { Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'
import { CODE_CLASS, monthLabel, shiftMonth, type MusterCell } from './Muster'

interface Calendar { month: string; employeeId: string; days: MusterCell[]; totals: Record<string, number>; legend: Record<string, string> }
const hm = (iso: string | null | undefined): string => iso ? new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '—'
const hours = (m: number | null | undefined): string => m ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m` : '—'

export function MyMonth({ data }: { data: Workspace }) {
  const [month, setMonth] = useState(data.today.slice(0, 7))
  const [cal, setCal] = useState<Calendar | null>(null)
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<MusterCell | null>(null)
  useEffect(() => {
    let live = true
    setCal(null); setError(''); setPicked(null)
    domainApi<Calendar>(`/attendance/calendar?month=${month}`).then((c) => { if (live) setCal(c) }).catch((e: Error) => { if (live) setError(e.message) })
    return () => { live = false }
  }, [month])
  if (!data.user.employeeId) return <Card><Empty title="No employee record" text="Your login is not linked to an employee, so there is no month to show." /></Card>

  const first = new Date(`${month}-01T00:00:00`)
  const lead = (first.getDay() + 6) % 7   // Monday-first grid
  return (
    <Card className="my-month">
      <div className="filter-bar">
        <div className="date-navigator">
          <button type="button" className="nav-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
          <h2>{monthLabel(month)}</h2>
          <button type="button" className="nav-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
        </div>
        {cal && (
          <dl className="month-totals">
            <div><dt>Present</dt><dd>{cal.totals.present ?? 0}</dd></div>
            <div><dt>Leave</dt><dd>{cal.totals.leave ?? 0}</dd></div>
            <div><dt>Absent</dt><dd>{cal.totals.absent ?? 0}</dd></div>
            <div><dt>Payable</dt><dd>{cal.totals.payable ?? 0}</dd></div>
            <div><dt>LOP</dt><dd>{cal.totals.lop ?? 0}</dd></div>
          </dl>
        )}
      </div>
      {error && <ErrorBox message={error} />}
      {!cal && !error ? <Skeleton /> : cal && (
        <div className="month-layout">
          <div className="month-grid" role="grid" aria-label={`Attendance for ${monthLabel(month)}`}>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => <div key={d} className="dow" role="columnheader">{d}</div>)}
            {Array.from({ length: lead }).map((_, i) => <div key={`lead-${i}`} className="pad" aria-hidden="true" />)}
            {cal.days.map((c) => (
              <button key={c.date} type="button" role="gridcell" aria-selected={picked?.date === c.date}
                className={`day ${CODE_CLASS[c.code] ?? 'c-none'} ${c.date === data.today ? 'today' : ''} ${picked?.date === c.date ? 'picked' : ''}`}
                onClick={() => setPicked(c)} aria-label={`${c.date}: ${cal.legend[c.code] ?? c.code}`}>
                <span className="num">{Number(c.date.slice(8, 10))}</span>
                <span className="code">{c.code}</span>
              </button>
            ))}
          </div>
          <aside className="day-detail" aria-live="polite">
            {picked ? (
              <>
                <h3>{new Date(picked.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
                <p className={`code-pill ${CODE_CLASS[picked.code] ?? 'c-none'}`}>{picked.code} · {cal.legend[picked.code] ?? picked.code}</p>
                <dl>
                  <div><dt>In</dt><dd>{hm(picked.firstIn)}</dd></div>
                  <div><dt>Out</dt><dd>{hm(picked.lastOut)}</dd></div>
                  <div><dt>Worked</dt><dd>{hours(picked.workedMinutes)}</dd></div>
                  {picked.late ? <div><dt>Late by</dt><dd>{picked.late} min</dd></div> : null}
                  {picked.otMinutes ? <div><dt>Overtime</dt><dd>{hours(picked.otMinutes)}</dd></div> : null}
                  <div><dt>Counts as</dt><dd>{picked.payable} payable{picked.lop ? `, ${picked.lop} LOP` : ''}</dd></div>
                </dl>
              </>
            ) : <p className="subtle">Tap a day to see in, out and worked time.</p>}
            <ul className="muster-legend compact" aria-label="Legend">
              {Object.entries(cal.legend).map(([code, label]) => <li key={code}><span className={`swatch ${CODE_CLASS[code] ?? 'c-none'}`}>{code}</span>{label}</li>)}
            </ul>
          </aside>
        </div>
      )}
    </Card>
  )
}
