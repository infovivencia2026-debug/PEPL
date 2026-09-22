/**
 * Project profitability: hours against money. Margin is stated as a number
 * and a word ("losing money"), not only a colour, and the cost side says
 * plainly that it comes from frozen payroll, so nobody reads it as a quote.
 */
import { useCallback, useEffect, useState } from 'react'
import { Download, TrendingDown, TrendingUp } from 'lucide-react'
import { domainApi, downloadFile } from '../domainApi'
import { money } from '../api'
import { Button, Card, Empty, ErrorBox, Skeleton } from '../ui'
import type { Workspace } from '../types'

interface Row { project_code: string; project_name?: string; hours: string; billable_hours: string; revenue_paise: string; cost_paise: string; margin_paise: string; margin_pct: string }

export function ProfitabilityPage({ data }: { data: Workspace }) {
  const [from, setFrom] = useState(`${data.today.slice(0, 4)}-04-01`)
  const [to, setTo] = useState(data.today)
  const [rows, setRows] = useState<Row[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setRows(null)
    try { setRows(await domainApi<Row[]>(`/projects/profitability?from=${from}&to=${to}`)); setError('') } catch (e) { setError((e as Error).message) }
  }, [from, to])
  useEffect(() => { void load() }, [load])
  function csv() {
    if (!rows) return
    const lines = [['Project', 'Hours', 'Billable hours', 'Revenue', 'Cost', 'Margin', 'Margin %'].join(',')]
    for (const r of rows) lines.push([r.project_code, r.hours, r.billable_hours, (Number(r.revenue_paise) / 100).toFixed(2), (Number(r.cost_paise) / 100).toFixed(2), (Number(r.margin_paise) / 100).toFixed(2), r.margin_pct].join(','))
    downloadFile(`project-profitability-${from}-to-${to}.csv`, 'text/csv', lines.join('\n'))
  }
  return (
    <>
      <div className="filter-bar">
        <label className="field compact"><span className="sr-only">From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field compact"><span className="sr-only">To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <Button variant="secondary" disabled={!rows?.length} onClick={csv}><Download size={15} aria-hidden="true" />CSV</Button>
      </div>
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : !rows.length ? (
        <Card><Empty title="No project time in this window" text="Profitability needs approved timesheets with a project and a billable rate; cost comes from locked payroll." /></Card>
      ) : (
        <Card className="data-card">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Project</th><th className="num">Hours</th><th className="num">Billable</th><th className="num">Revenue</th><th className="num">Cost</th><th className="num">Margin</th><th>How it is going</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const pct = Number(r.margin_pct)
                  const state = pct < 0 ? 'losing money' : pct < 15 ? 'thin' : pct < 35 ? 'healthy' : 'strong'
                  return (
                    <tr key={r.project_code}>
                      <td><strong>{r.project_name ?? r.project_code}</strong><br /><small>{r.project_code}</small></td>
                      <td className="num">{Number(r.hours).toFixed(1)}</td>
                      <td className="num">{Number(r.billable_hours).toFixed(1)}<br /><small>{Number(r.hours) ? Math.round(Number(r.billable_hours) / Number(r.hours) * 100) : 0}% billable</small></td>
                      <td className="num">{money(r.revenue_paise)}</td>
                      <td className="num">{money(r.cost_paise)}</td>
                      <td className="num"><strong className={pct < 0 ? 'warn-text' : ''}>{money(r.margin_paise)}</strong></td>
                      <td>
                        <span className={`margin-chip ${pct < 0 ? 'bad' : pct < 15 ? 'thin' : 'good'}`}>
                          {pct < 0 ? <TrendingDown size={14} aria-hidden="true" /> : <TrendingUp size={14} aria-hidden="true" />}
                          {pct.toFixed(1)}% · {state}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <p className="subtle">Cost is the frozen payroll cost of the hours booked, not a standard rate — it moves only when payroll does.</p>
    </>
  )
}
