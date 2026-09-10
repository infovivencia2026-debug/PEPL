import type { Workspace } from '../types'
import { Card } from '../ui'
import { dateLabel, money } from '../api'

export function PayrollSummaryTile({ data, month }: { data: Workspace; month: string }) {
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(`${month}-01T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() - 5 + index)
    const key = date.toISOString().slice(0, 7)
    // Workspace runs are newest revision first. Show one current result per period.
    const run = data.payroll.find(item => item.period_start.startsWith(key))
    return { key, value: run?.net_paise == null ? null : Number(run.net_paise) }
  })
  const maximum = Math.max(1, ...months.map(item => item.value ?? 0))
  const current = months[5].value
  return <Card title="Payroll summary" href="#/payroll" className="payroll-summary-tile">
    <strong className="payroll-summary-total">{current === null ? '—' : money(String(current))}</strong>
    <p className="payroll-summary-caption">{current === null ? 'No calculated run for this month' : 'Net payroll for selected month'}</p>
    <div className="payroll-history" aria-label="Net payroll over six months">{months.map(item => <div key={item.key} title={`${dateLabel(`${item.key}-01`, { month: 'long' })}: ${item.value === null ? 'No calculated run' : money(String(item.value))}`}><div className={`history-bar ${item.value === null ? 'no-value' : ''}`} style={{ height: item.value === null ? 3 : `${Math.max(3, item.value / maximum * 68)}px` }} /><small>{dateLabel(`${item.key}-01`, { month: 'short' })}</small></div>)}</div>
  </Card>
}
