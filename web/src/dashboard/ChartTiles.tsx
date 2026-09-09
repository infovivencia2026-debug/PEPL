import type { ReactElement } from 'react'
import { Widget } from '../WidgetBoard'
import { Card, Donut, Empty, ViewLink } from '../ui'
import type { Workspace } from '../types'
import type { DashboardMetrics } from './metrics'

/** Headcount by department, and today's attendance split. */
export function chartTiles({
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
      <Widget key="departments" id="departments" title="Employee overview" width={3}>
        <Card
          title="Employee overview"
          subtitle="Headcount by department"
          href="#/people"
        >
          {metrics.employees.length ? (
            <Donut
              segments={metrics.departmentSegments}
              value={metrics.employees.length}
              label="employees"
            />
          ) : (
            <Empty
              title="No employees yet"
              text="Add an employee to see the department breakdown."
              action={<ViewLink href="#/people">Go to people</ViewLink>}
            />
          )}
        </Card>
      </Widget>,
    )
  }

  if (data.modules.attendance && can('attendance.read')) {
    tiles.push(
      <Widget key="attendance" id="attendance" title="Attendance today" width={3}>
        <Card
          title="Attendance today"
          subtitle="Recorded so far"
          href="#/attendance"
        >
          {metrics.totalAttendance ? (
            <Donut
              segments={metrics.attendanceSegments}
              value={`${metrics.presentPercent}%`}
              label="present"
            />
          ) : (
            <Empty
              title="No records today"
              text="Attendance appears here as punches are recorded."
            />
          )}
          <div className="card-foot">
            <span className="status-dot" />
            {metrics.remoteCount} working remotely{' '}
            <span className="subtle">· {metrics.totalAttendance} recorded</span>
          </div>
        </Card>
      </Widget>,
    )
  }

  return tiles
}
