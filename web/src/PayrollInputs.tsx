import { useEffect, useState, type FormEvent } from 'react'
import { dateLabel } from './api'
import { domainApi } from './domainApi'
import { Button, Empty, ErrorBox, Modal } from './ui'

interface Summary {
  employeeId: string; employeeNumber: string; name: string; calendarDays: number
  payableDays: number; lopDays: number; paidLeaveDays: number; unmarkedDays: number
  lateMarks: number; lateHalfDays: number; otMinutes: number
  joinedMidPeriod: boolean; exitedMidPeriod: boolean; warnings: string[]
  row: { annualCtcPaise: string } | null
}
interface Review { summary: Summary; include: boolean; payable: string; lop: string; ot: string }

export function PayrollInputs({ id, onClose, onSaved }: {
  id: string; onClose: () => void; onSaved: () => Promise<void>
}) {
  const [rows, setRows] = useState<Review[]>([])
  const [period, setPeriod] = useState<{ period_start: string; period_end: string } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true); setError(''); setRows([])
    async function load() {
      const { run } = await domainApi<{ run: { period_id: string } }>(`/payroll/runs/${id}`)
      const result = await domainApi<{ period: { period_start: string; period_end: string }; employees: Summary[] }>(`/attendance/summary?periodId=${encodeURIComponent(run.period_id)}`)
      if (!cancelled) {
        setPeriod(result.period)
        setRows(result.employees.map(summary => ({ summary, include: !!summary.row, payable: String(summary.payableDays), lop: String(summary.lopDays), ot: String(summary.otMinutes) })))
      }
    }
    load().catch(e => { if (!cancelled) setError((e as Error).message) }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [id])
  function patch(employeeId: string, values: Partial<Review>) {
    setRows(previous => previous.map(row => row.summary.employeeId === employeeId ? { ...row, ...values } : row))
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('')
    const selected = rows.filter(row => row.include)
    if (!selected.length) { setError('Include at least one employee with compensation configured.'); return }
    if (selected.some(row => !row.payable || !row.lop || !row.ot || Number(row.payable) + Number(row.lop) > row.summary.calendarDays)) {
      setError('Payable days and loss of pay cannot exceed calendar days. Complete every included row.'); return
    }
    setBusy(true)
    try {
      await domainApi(`/payroll/runs/${id}/freeze-from-attendance`, {
        skipEmployeeIds: rows.filter(row => !row.include).map(row => row.summary.employeeId),
        overrides: selected.flatMap(row => {
          const override: { employeeId: string; payableDays?: number; lopDays?: number; otMinutes?: number } = { employeeId: row.summary.employeeId }
          if (Number(row.payable) !== row.summary.payableDays) override.payableDays = Number(row.payable)
          if (Number(row.lop) !== row.summary.lopDays) override.lopDays = Number(row.lop)
          if (Number(row.ot) !== row.summary.otMinutes) override.otMinutes = Number(row.ot)
          return Object.keys(override).length > 1 ? [override] : []
        }),
      })
      await onSaved(); onClose()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return <Modal title="Review attendance & freeze payroll" wide onClose={() => { if (!busy) onClose() }}>
    <form onSubmit={submit}>
      <p className="form-intro">{period && `${dateLabel(period.period_start)} – ${dateLabel(period.period_end)}. `}Payable days come from attendance, leave, holidays and rosters. Review warnings and edit only exceptions.</p>
      {loading ? <p role="status">Preparing attendance summary…</p> : rows.length ? <>
        <p aria-live="polite">{rows.filter(row => row.include).length} included · {rows.filter(row => !row.include).length} skipped · {rows.filter(row => row.summary.warnings.length).length} with warnings</p>
        <div className="table-scroll attendance-freeze"><table><thead><tr><th>Include / employee</th><th>Calendar</th><th>Payable</th><th>LOP</th><th>Paid leave</th><th>Unmarked</th><th>Late marks / half days</th><th>OT minutes</th><th>Review notes</th></tr></thead><tbody>
          {rows.map(({ summary: s, ...r }) => <tr key={s.employeeId}>
            <td><label><input type="checkbox" checked={r.include} disabled={!s.row || busy} onChange={e => patch(s.employeeId, { include: e.target.checked })} /> <strong>{s.name}</strong></label><small>{s.employeeNumber}</small>{!s.row && <a href={`#/people/${s.employeeId}`}>Configure compensation</a>}</td>
            <td>{s.calendarDays}</td>
            <td><input aria-label={`Payable days for ${s.name}`} type="number" min="0" max={s.calendarDays} step="0.5" required={r.include} disabled={!r.include || busy} value={r.payable} onChange={e => patch(s.employeeId, { payable: e.target.value })} /></td>
            <td><input aria-label={`Loss of pay days for ${s.name}`} type="number" min="0" max={s.calendarDays} step="0.5" required={r.include} disabled={!r.include || busy} value={r.lop} onChange={e => patch(s.employeeId, { lop: e.target.value })} /></td>
            <td>{s.paidLeaveDays}</td><td>{s.unmarkedDays}</td><td>{s.lateMarks} / {s.lateHalfDays}</td>
            <td><input aria-label={`Overtime minutes for ${s.name}`} type="number" min="0" step="1" required={r.include} disabled={!r.include || busy} value={r.ot} onChange={e => patch(s.employeeId, { ot: e.target.value })} /></td>
            <td>{s.joinedMidPeriod && <small>Joined during period</small>}{s.exitedMidPeriod && <small>Exited during period</small>}{s.warnings.map(warning => <small key={warning}>{warning}</small>)}{!s.warnings.length && 'Ready to freeze'}</td>
          </tr>)}
        </tbody></table></div>
      </> : !error && <Empty title="No employees in this period" text="Check the payroll period and employee effective dates." />}
      {error && <ErrorBox message={error} />}
      <p className="notice">Freezing stores the reviewed attendance inputs. Skipped employees are excluded from this run.</p>
      <footer className="modal-actions"><Button type="button" variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || loading || !rows.some(row => row.include)}>{busy ? 'Freezing…' : 'Freeze reviewed inputs'}</Button></footer>
    </form>
  </Modal>
}
