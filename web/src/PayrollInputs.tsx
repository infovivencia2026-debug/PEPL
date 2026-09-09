import { useEffect, useState, type FormEvent } from 'react'
import { Check, ShieldCheck } from 'lucide-react'
import { api, dateLabel, fullName, money } from './api'
import { Button, Empty, ErrorBox, Modal } from './ui'
interface Candidate {
  id: string
  first_name: string
  last_name: string
  date_of_joining: string
  annual_ctc_paise: string | null
  components: Record<string, number> | null
}
interface InputRow {
  employee: Candidate
  include: boolean
  payable: string
  lop: string
  state: string
  pf: boolean
  esi: boolean
}
export function PayrollInputs({
  id,
  onClose,
  onSaved,
}: {
  id: string
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [rows, setRows] = useState<InputRow[]>([]),
    [period, setPeriod] = useState<{
      period_start: string
      period_end: string
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    api<{
      period: { period_start: string; period_end: string }
      employees: Candidate[]
    }>(`/payroll/${id}/candidates`)
      .then((d) => {
        if (!cancelled) {
          setPeriod(d.period)
          setRows(
            d.employees.map((e) => ({
              employee: e,
              include: !!e.components,
              payable: '',
              lop: '',
              state: '',
              pf: true,
              esi: false,
            })),
          )
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [id])
  const calendar = period
    ? (Date.parse(period.period_end) - Date.parse(period.period_start)) /
        86400000 +
      1
    : 0
  function patch(i: number, v: Partial<InputRow>) {
    setRows(rows.map((r, j) => (i === j ? { ...r, ...v } : r)))
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    if (!rows.some((r) => r.include)) {
      setError('Select at least one employee with compensation configured.')
      return
    }
    setBusy(true)
    try {
      await api(`/payroll/${id}/actions`, {
        action: 'freeze',
        rows: rows
          .filter((r) => r.include)
          .map((r) => ({
            employeeId: r.employee.id,
            calendarDays: calendar,
            payableDays: Number(r.payable),
            lopDays: Number(r.lop),
            monthlyComponents: r.employee.components,
            annualCtcPaise: Number(r.employee.annual_ctc_paise),
            stateCode: r.state,
            pfApplicable: r.pf,
            esiApplicable: r.esi,
            joinedMidPeriod:
              !!period && r.employee.date_of_joining > period.period_start,
          })),
      })
      await onSaved()
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      title="Review & freeze payroll inputs"
      wide
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form onSubmit={submit}>
        <p className="form-intro">
          {period
            ? `${dateLabel(period.period_start)} – ${dateLabel(period.period_end)} · ${calendar} calendar days. `
            : ''}
          Confirm payable days, loss of pay, and statutory applicability for
          each selected employee. Compensation comes from their recorded salary
          structure.
        </p>
        {loading ? (
          <p>Loading employee inputs…</p>
        ) : rows.length ? (
          <div className="input-review-list">
            {rows.map((r, i) => (
              <article key={r.employee.id}>
                <div className="input-review-person">
                  <label>
                    <input
                      type="checkbox"
                      checked={r.include}
                      disabled={!r.employee.components}
                      onChange={(e) => patch(i, { include: e.target.checked })}
                    />
                    <strong>{fullName(r.employee)}</strong>
                  </label>
                  <small>
                    {r.employee.components
                      ? `Annual CTC ${money(r.employee.annual_ctc_paise)}`
                      : 'Compensation must be configured before inclusion'}
                  </small>
                </div>
                {r.include && (
                  <>
                    <div className="input-review-fields">
                      <label className="field">
                        <span>Payable days</span>
                        <input
                          aria-label={`Payable days for ${fullName(r.employee)}`}
                          required
                          type="number"
                          min="0"
                          max={calendar}
                          step="0.5"
                          value={r.payable}
                          onChange={(e) =>
                            patch(i, { payable: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Loss of pay days</span>
                        <input
                          aria-label={`Loss of pay days for ${fullName(r.employee)}`}
                          required
                          type="number"
                          min="0"
                          max={calendar}
                          step="0.5"
                          value={r.lop}
                          onChange={(e) => patch(i, { lop: e.target.value })}
                        />
                      </label>
                      <label className="field">
                        <span>State code</span>
                        <input
                          aria-label={`State code for ${fullName(r.employee)}`}
                          required
                          maxLength={3}
                          placeholder="e.g. TS"
                          value={r.state}
                          onChange={(e) =>
                            patch(i, { state: e.target.value.toUpperCase() })
                          }
                        />
                      </label>
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={r.pf}
                          onChange={(e) => patch(i, { pf: e.target.checked })}
                        />
                        PF applicable
                      </label>
                      <label className="checkbox-field">
                        <input
                          type="checkbox"
                          checked={r.esi}
                          onChange={(e) => patch(i, { esi: e.target.checked })}
                        />
                        ESI applicable
                      </label>
                    </div>
                    <div className="component-summary">
                      {Object.entries(r.employee.components ?? {}).map(
                        ([key, v]) => (
                          <span key={key}>
                            {key}: <b>{money(String(v))}</b>
                          </span>
                        ),
                      )}
                    </div>
                  </>
                )}
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="No employees to include"
            text="Add employees and configure their compensation before starting payroll."
          />
        )}
        {error && <ErrorBox message={error} />}
        <div className="notice">
          <ShieldCheck size={20} />
          <p>
            Freezing stores these inputs for this run. You can unfreeze them
            only before calculation.
          </p>
        </div>
        <footer className="modal-actions">
          <Button
            variant="secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy || loading || !rows.length}>
            {busy ? 'Freezing…' : 'Freeze reviewed inputs'}
            <Check size={17} />
          </Button>
        </footer>
      </form>
    </Modal>
  )
}
