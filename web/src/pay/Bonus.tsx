/**
 * Statutory bonus calculator (Payment of Bonus Act). It writes nothing: it
 * answers who is eligible and for how much at a chosen rate, with the reason
 * for everyone who is not, so the exclusion list can be checked before any
 * money moves.
 */
import { useMemo, useState } from 'react'
import { Calculator, Download } from 'lucide-react'
import { domainApi, downloadFile } from '../domainApi'
import { fullName, money } from '../api'
import { Button, Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'

interface Row { employeeId: string; eligible: boolean; bonusPaise: number; basisPaise: number; reason?: string }

export function BonusPage({ data }: { data: Workspace }) {
  const [rate, setRate] = useState('8.33')
  const [minWage, setMinWage] = useState('')
  const [wages, setWages] = useState<Record<string, string>>({})
  const [result, setResult] = useState<{ ratePct: number; rows: Row[]; totalPaise: number; eligible: number } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const people = useMemo(() => data.employees.filter((e) => e.status !== 'exited'), [data.employees])
  async function compute() {
    setBusy(true); setError('')
    try {
      setResult(await domainApi('/payroll/bonus/compute', {
        ratePct: Number(rate),
        minimumWagePaise: minWage ? Math.round(Number(minWage) * 100) : undefined,
        people: people.map((p) => ({ employeeId: p.id, monthlyWagePaise: Math.round(Number(wages[p.id] ?? '0') * 100), monthsWorked: 12, daysWorked: 300 })),
      }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  function csv() {
    if (!result) return
    const lines = [['Employee', 'Employee no', 'Eligible', 'Basis', 'Bonus', 'Reason'].join(',')]
    for (const r of result.rows) {
      const p = people.find((x) => x.id === r.employeeId)
      lines.push([`"${p ? fullName(p) : r.employeeId}"`, p?.employee_number ?? '', r.eligible ? 'yes' : 'no', (r.basisPaise / 100).toFixed(2), (r.bonusPaise / 100).toFixed(2), `"${r.reason ?? ''}"`].join(','))
    }
    downloadFile(`statutory-bonus-${new Date().getFullYear()}.csv`, 'text/csv', lines.join('\n'))
  }
  return (
    <>
      <Card title="Statutory bonus" subtitle="Payment of Bonus Act: 8.33% to 20% on wages up to ₹21,000, computed on ₹7,000 or the scheduled minimum wage, whichever is higher.">
        <div className="two-up">
          <label className="field"><span>Rate (%)</span><input type="number" min={8.33} max={20} step={0.01} value={rate} onChange={(e) => setRate(e.target.value)} /></label>
          <label className="field"><span>Scheduled minimum wage (₹/month, optional)</span><input type="number" min={0} value={minWage} onChange={(e) => setMinWage(e.target.value)} placeholder="7000 if blank" /></label>
        </div>
        <p className="subtle">Enter each person’s monthly wage (basic + DA). Everyone is assumed to have worked the full year; adjust the wage to zero to leave someone out.</p>
        <div className="table-scroll" style={{ maxHeight: 320 }}>
          <table>
            <thead><tr><th>Employee</th><th className="num">Monthly wage (₹)</th></tr></thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td>{fullName(p)}<br /><small>{p.employee_number}</small></td>
                  <td className="num"><input type="number" min={0} value={wages[p.id] ?? ''} aria-label={`Monthly wage for ${fullName(p)}`} onChange={(e) => setWages({ ...wages, [p.id]: e.target.value })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy} onClick={() => void compute()}><Calculator size={16} aria-hidden="true" />{busy ? 'Computing…' : 'Compute bonus'}</Button>{result && <Button variant="secondary" onClick={csv}><Download size={15} aria-hidden="true" />CSV</Button>}</div>
      </Card>
      {busy && !result ? <Skeleton /> : result && (
        <Card title={`${result.eligible} eligible · ${money(result.totalPaise)} at ${result.ratePct}%`} subtitle="Nothing is written; this is the arithmetic to check before paying.">
          {!result.rows.length ? <Empty title="Nobody to compute" text="Add people first." /> : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Employee</th><th>Eligible</th><th className="num">Basis</th><th className="num">Bonus</th><th>Why not</th></tr></thead>
                <tbody>
                  {result.rows.map((r) => {
                    const p = people.find((x) => x.id === r.employeeId)
                    return (
                      <tr key={r.employeeId}>
                        <td>{p ? fullName(p) : r.employeeId.slice(0, 8)}</td>
                        <td><span className={`badge ${r.eligible ? 'green' : 'amber'}`}><span />{r.eligible ? 'yes' : 'no'}</span></td>
                        <td className="num">{r.basisPaise ? money(r.basisPaise) : '—'}</td>
                        <td className="num"><strong>{r.bonusPaise ? money(r.bonusPaise) : '—'}</strong></td>
                        <td>{r.reason ?? ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </>
  )
}
