/**
 * The dashboard, composed from tiles.
 *
 * This file is arrangement only: which tiles exist and in what order. Each tile
 * owns its own markup in web/src/dashboard/, and every number comes from
 * deriveMetrics — so a change to one tile cannot disturb another, and the
 * arithmetic can be checked without rendering.
 */
import { useState } from 'react'
import { CalendarDays, PartyPopper } from 'lucide-react'
import { Widget, WidgetBoard } from './WidgetBoard'
import { PayrollSummaryTile } from './dashboard/PayrollSummaryTile'
import { dateLabel } from './api'
import type { Workspace } from './types'
import { deriveMetrics, permits } from './dashboard/metrics'
import { welcomeTile } from './dashboard/WelcomeTile'
import { statTiles } from './dashboard/StatTiles'
import { chartTiles } from './dashboard/ChartTiles'
import {
  activityTile,
  announcementsTile,
  approvalsTile,
  joinersTile,
  tasksTile,
} from './dashboard/ListTiles'
import { PunchControl } from './PunchControl'
import { InterviewsWidget } from './Recruitment'

export function Dashboard({
  data,
  act,
}: {
  data: Workspace
  act: (path: string, body: unknown, message: string) => Promise<void>
}) {
  const [month, setMonth] = useState(data.today.slice(0, 7))
  const base = deriveMetrics(data)
  const metrics = { ...base, month, joiners: data.employees.filter(e => e.date_of_joining.startsWith(month)), payrollThisMonth: data.payroll.find(run => run.period_start.startsWith(month)) }
  const months = Array.from({ length: 6 }, (_, index) => {
    const date = new Date(`${data.today.slice(0, 7)}-01T12:00:00Z`)
    date.setUTCMonth(date.getUTCMonth() - index)
    return date.toISOString().slice(0, 7)
  })
  const can = permits(data)

  return (
    <>
      <div className="dashboard-heading">
        <div>
          <h1>
            At a glance<span>.</span>
          </h1>
        </div>
        <div className="date-chip">
          <CalendarDays size={17} />
          {dateLabel(data.today, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
          <select aria-label="Dashboard reporting month" value={month} onChange={event => setMonth(event.target.value)}>
            {months.map((value, index) => <option key={value} value={value}>{index === 0 ? 'This month' : dateLabel(`${value}-01`, { month: 'long', year: 'numeric' })}</option>)}
          </select>
        </div>
      </div>

      <WidgetBoard key={data.user.id} account={data.user.id}>
        {welcomeTile({ data, can })}
        {data.user.employeeId && data.modules.attendance && can('attendance.read') && <Widget id="punch" title="Punch in or out" width={2}><PunchControl data={data} compact /></Widget>}
        {data.modules.recruitment && can('recruit.read') && <Widget id="my-interviews" title="My upcoming interviews" width={2}><InterviewsWidget /></Widget>}
        {statTiles({ data, metrics, can })}
        {chartTiles({ data, metrics, can })}
        {approvalsTile({ data, can })}
        {can('payroll.read') && data.modules.payroll && <Widget id="payroll-summary" title="Payroll summary" width={3}><PayrollSummaryTile data={data} month={month} /></Widget>}
        {joinersTile({ metrics })}
        {tasksTile({ data, can, act })}
        <Widget id="inspiration" title="People and culture" width={2}><section className="culture-card"><PartyPopper size={31} /><p>Great people<br />make a brighter<br />tomorrow.</p><span className="culture-dash" /><svg aria-hidden="true" viewBox="0 0 230 60"><path d="M0 60 Q30 24 67 39 T123 34 T180 39 T240 20 M25 65 Q67 19 112 53 T210 48" fill="none" stroke="currentColor" /></svg><i /></section></Widget>
        {activityTile({ data, can })}
        {announcementsTile({ data, can })}
      </WidgetBoard>
    </>
  )
}
