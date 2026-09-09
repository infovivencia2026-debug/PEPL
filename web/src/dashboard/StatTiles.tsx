import type { ReactElement } from 'react'
import { Users, CalendarDays, UserPlus, Wallet, CheckCheck } from 'lucide-react'
import { Widget } from '../WidgetBoard'
import { Stat } from '../ui'
import { money } from '../api'
import type { Workspace } from '../types'
import type { DashboardMetrics } from './metrics'

/**
 * The headline numbers. Each tile links to the screen that explains it, so a
 * number is never a dead end.
 *
 * Returns an ARRAY of Widget elements rather than a component wrapping them:
 * WidgetBoard filters its children for `Widget`, and React.Children.toArray
 * flattens arrays but treats a fragment or a component as one opaque child —
 * which would silently drop every tile inside it.
 */
export function statTiles({
  data,
  metrics,
  can,
}: {
  data: Workspace
  metrics: DashboardMetrics
  can: (permission: string) => boolean
}): ReactElement[] {
  const tiles: ReactElement[] = []

  if (can('employee.read')) {
    tiles.push(
      <Widget key="people" id="people" title="Total employees" width={2}>
        <Stat
          label="Total employees"
          value={metrics.employees.length}
          note={`${metrics.activeCount} active`}
          icon={<Users size={21} />}
          href="#/people"
        />
      </Widget>,
    )
  }

  if (data.modules.leave && can('leave.read')) {
    tiles.push(
      <Widget key="leave" id="leave" title="On leave today" width={2}>
        <Stat
          label="On leave today"
          value={metrics.onLeaveToday}
          note="Approved absence"
          icon={<CalendarDays size={21} />}
          variant="mint-card"
          href="#/leave"
        />
      </Widget>,
    )
  }

  if (can('employee.read')) {
    tiles.push(
      <Widget key="new-faces" id="new-faces" title="New joiners" width={2}>
        <Stat
          label="New joiners"
          value={metrics.joiners.length}
          note="This month"
          icon={<UserPlus size={21} />}
          variant="sand-card"
          href="#/people"
        />
      </Widget>,
    )
  }

  if (data.modules.payroll && can('payroll.read')) {
    tiles.push(
      <Widget key="payroll" id="payroll" title="Payroll this month" width={2}>
        <Stat
          label="Payroll this month"
          value={
            metrics.payrollThisMonth
              ? money(metrics.payrollThisMonth.net_paise)
              : '—'
          }
          note={
            metrics.payrollThisMonth
              ? `Status: ${metrics.payrollThisMonth.status.replace(/_/g, ' ')}`
              : 'No run yet'
          }
          icon={<Wallet size={21} />}
          variant="coral-card"
          href="#/payroll"
        />
      </Widget>,
    )
  }

  if (can('approval.act')) {
    tiles.push(
      <Widget key="pending" id="pending" title="Pending approvals" width={3}>
        <Stat
          label="Pending approvals"
          value={data.approvals.length}
          note="Waiting on you"
          icon={<CheckCheck size={21} />}
          href="#/approvals"
        />
      </Widget>,
    )
  }

  return tiles
}
