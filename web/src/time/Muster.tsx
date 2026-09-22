/**
 * Muster roll: one row per person, one narrow column per day, the code that
 * payroll will freeze. Codes are letters with colour behind them, never colour
 * alone, and the legend sits under the grid. A cell opens the correction form
 * for that person and day.
 */
import { useEffect, useMemo, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import { domainApi, downloadFile, decodeBase64 } from '../domainApi'
import { Button, Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'
import type { FormSpec } from '../forms'

export interface MusterCell { date: string; code: string; payable: number; lop: number; late?: number; otMinutes?: number; firstIn?: string | null; lastOut?: string | null; workedMinutes?: number | null }
export interface MusterRow { employeeId: string; employeeNumber: string; name: string; department: string | null; designation: string | null; days: MusterCell[]; totals: Record<string, number> }
export interface MusterReport { month: string; from: string; to: string; days: string[]; legend: Record<string, string>; rows: MusterRow[] }

export const CODE_CLASS: Record<string, string> = { P: 'c-p', '½': 'c-half', A: 'c-a', L: 'c-l', LH: 'c-l', LWP: 'c-lwp', WO: 'c-wo', H: 'c-h', OD: 'c-od', WFH: 'c-od', NJ: 'c-nj', '–': 'c-none' }

export function monthLabel(m: string): string {
  return new Date(`${m}-01T00:00:00`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })
}
export function shiftMonth(m: string, n: number): string {
  const d = new Date(`${m}-01T00:00:00`); d.setMonth(d.getMonth() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

export function MusterPage({ data, open }: { data: Workspace; open: (s: FormSpec) => void }) {
  const [month, setMonth] = useState(data.today.slice(0, 7))
  const [department, setDepartment] = useState('')
  const [report, setReport] = useState<MusterReport | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const canCorrect = data.permissions.includes('attendance.correct')

  useEffect(() => {
    let live = true
    setLoading(true); setError('')
    domainApi<MusterReport>(`/reports/muster?month=${month}${department ? `&department=${encodeURIComponent(department)}` : ''}`)
      .then((r) => { if (live) setReport(r) })
      .catch((e: Error) => { if (live) setError(e.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [month, department])

  const departments = useMemo(() => [...new Set(data.employees.map((e) => e.department).filter((d): d is string => Boolean(d)))].sort(), [data.employees])
  const TOTAL_COLS: Array<[string, string]> = [['present', 'P'], ['half', '½'], ['absent', 'A'], ['leave', 'L'], ['weeklyOff', 'WO'], ['holiday', 'H'], ['payable', 'Pay'], ['lop', 'LOP'], ['late', 'Late'], ['otHours', 'OT h']]

  async function csv() {
    const r = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/reports/muster?month=${month}&format=csv${department ? `&department=${encodeURIComponent(department)}` : ''}`)
    downloadFile(r.fileName, r.contentType, decodeBase64(r.contentBase64))
  }
  function correct(row: MusterRow, cell: MusterCell) {
    if (!canCorrect) return
    open({
      title: `Correct ${row.name} · ${new Date(cell.date + 'T00:00:00').toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}`,
      description: `Currently ${report?.legend[cell.code] ?? cell.code}. A correction records what changed and why.`,
      path: '/attendance/corrections', domain: true,
      fields: [
        { name: 'employeeId', label: 'Employee', value: row.employeeId, options: [{ value: row.employeeId, label: row.name }] },
        { name: 'workDate', label: 'Date', type: 'date', value: cell.date },
        { name: 'action', label: 'Correction', options: ['mark_present', 'mark_absent', 'mark_half_day', 'mark_full_day', 'mark_remote', 'revoke_remote', 'mark_field_duty'].map((v) => ({ value: v, label: v.replace(/_/g, ' ') })) },
        { name: 'reason', label: 'Reason', required: true },
      ],
    })
  }

  return (
    <Card className="data-card muster-card">
      <div className="filter-bar">
        <div className="date-navigator">
          <button type="button" className="nav-btn" onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">‹</button>
          <label className="field compact">
            <span className="sr-only">Month</span>
            <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} />
          </label>
          <button type="button" className="nav-btn" onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">›</button>
        </div>
        <label className="field compact">
          <span className="sr-only">Department</span>
          <select value={department} onChange={(e) => setDepartment(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => <option key={d} value={d}>{d}</option>)}
          </select>
        </label>
        <div className="filter-actions">
          <Button variant="secondary" onClick={() => window.print()}><Printer size={16} aria-hidden="true" />Print</Button>
          <Button variant="secondary" disabled={!report?.rows.length} onClick={() => void csv()}><Download size={16} aria-hidden="true" />Form 25 CSV</Button>
        </div>
      </div>
      {error && <ErrorBox message={error} />}
      {loading ? <Skeleton /> : !report?.rows.length ? (
        <Empty title={`No one on the roll for ${monthLabel(month)}`} text="People appear here once they have joined and the month has attendance." />
      ) : (
        <>
          <div className="muster-scroll" role="region" aria-label={`Muster roll for ${monthLabel(month)}`} tabIndex={0}>
            <table className="muster">
              <thead>
                <tr>
                  <th scope="col" className="sticky-col">Employee</th>
                  {report.days.map((d) => {
                    const dt = new Date(d + 'T00:00:00')
                    return <th key={d} scope="col" className={dt.getDay() === 0 ? 'sun' : ''}><span>{dt.getDate()}</span><small>{dt.toLocaleDateString('en-IN', { weekday: 'narrow' })}</small></th>
                  })}
                  {TOTAL_COLS.map(([k, label]) => <th key={k} scope="col" className="total">{label}</th>)}
                </tr>
              </thead>
              <tbody>
                {report.rows.map((row) => (
                  <tr key={row.employeeId}>
                    <th scope="row" className="sticky-col">
                      <strong>{row.name}</strong>
                      <small>{row.employeeNumber}{row.department ? ` · ${row.department}` : ''}</small>
                    </th>
                    {row.days.map((c) => (
                      <td key={c.date} className={CODE_CLASS[c.code] ?? 'c-none'}>
                        <button type="button" className="cell" disabled={!canCorrect} onClick={() => correct(row, c)}
                          title={`${c.date}: ${report.legend[c.code] ?? c.code}${c.firstIn ? ` · in ${c.firstIn.slice(11, 16)}` : ''}${c.lastOut ? ` out ${c.lastOut.slice(11, 16)}` : ''}${c.late ? ` · late ${c.late} min` : ''}`}
                          aria-label={`${row.name}, ${c.date}: ${report.legend[c.code] ?? c.code}${canCorrect ? '. Correct' : ''}`}>
                          {c.code}
                          {c.late ? <i className="late-dot" aria-hidden="true" /> : null}
                        </button>
                      </td>
                    ))}
                    {TOTAL_COLS.map(([k]) => <td key={k} className="total">{row.totals[k] ?? 0}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="muster-legend" aria-label="Legend">
            {Object.entries(report.legend).map(([code, label]) => (
              <li key={code}><span className={`swatch ${CODE_CLASS[code] ?? 'c-none'}`}>{code}</span>{label}</li>
            ))}
            <li><span className="swatch c-p"><i className="late-dot" aria-hidden="true" /></span>dot = late arrival</li>
          </ul>
        </>
      )}
    </Card>
  )
}
