/**
 * The dashboard, composed from tiles.
 *
 * This file is arrangement only: which tiles exist and in what order. Each tile
 * owns its own markup in web/src/dashboard/, and every number comes from
 * deriveMetrics — so a change to one tile cannot disturb another, and the
 * arithmetic can be checked without rendering.
 */
import { CalendarDays } from 'lucide-react'
import { WidgetBoard } from './WidgetBoard'
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

export function Dashboard({
  data,
  act,
}: {
  data: Workspace
  act: (path: string, body: unknown, message: string) => Promise<void>
}) {
  const metrics = deriveMetrics(data)
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
          <span className="status-dot" />
          <span>Today</span>
        </div>
      </div>

      <WidgetBoard key={data.user.id} account={data.user.id}>
        {welcomeTile({ data, can })}
        {statTiles({ data, metrics, can })}
        {chartTiles({ data, metrics, can })}
        {approvalsTile({ data, can })}
        {joinersTile({ metrics })}
        {tasksTile({ data, can, act })}
        {activityTile({ data, can })}
        {announcementsTile({ data, can })}
      </WidgetBoard>
    </>
  )
}
