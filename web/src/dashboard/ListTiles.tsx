import type { ReactElement } from 'react'
import { Check, Clock3, Send } from 'lucide-react'
import { Widget } from '../WidgetBoard'
import { Avatar, Button, Card, Empty } from '../ui'
import { dateLabel, fullName, pretty } from '../api'
import type { Workspace } from '../types'
import type { DashboardMetrics } from './metrics'

const shortDate = { day: 'numeric', month: 'short' } as const

/** Approvals waiting on this person. */
export function approvalsTile({
  data,
  can,
}: {
  data: Workspace
  can: (permission: string) => boolean
}): ReactElement {
  return (
    <Widget id="approvals" title="Leave requests" width={4}>
      <Card
        title="Leave requests"
        subtitle="Waiting on you"
        href={can('approval.act') ? '#/approvals' : undefined}
        className="approval-card"
      >
        {data.approvals.length ? (
          <div className="compact-list">
            {data.approvals.slice(0, 3).map((a) => {
              const leave = data.leaves.find((l) => l.id === a.entity_id)
              return (
                <div className="approval-item" key={a.request_id}>
                  <div className="person-line">
                    <Avatar name={leave ? fullName(leave) : a.title} />
                    <div>
                      <strong>{leave ? fullName(leave) : a.title}</strong>
                      <small>
                        {leave
                          ? `${leave.leave_name} · ${leave.total_days} day(s)`
                          : pretty(a.entity_type)}
                      </small>
                    </div>
                  </div>
                  <div className="approval-bottom">
                    <span>
                      {leave
                        ? `${dateLabel(leave.start_date, shortDate)} – ${dateLabel(leave.end_date, shortDate)}`
                        : dateLabel(a.created_at)}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <Empty
            title="Nothing to approve"
            text="Requests needing your decision appear here."
          />
        )}
      </Card>
    </Widget>
  )
}

/** People who joined this month. */
export function joinersTile({ metrics }: { metrics: DashboardMetrics }): ReactElement {
  return (
    <Widget id="joiners" title="New joiners" width={3}>
      <Card title="New joiners" subtitle={dateLabel(`${metrics.month}-01`, { month: 'long', year: 'numeric' })} href="#/people">
        {metrics.joiners.length ? (
          <div className="joiner-grid">
            {metrics.joiners.slice(0, 4).map((e) => (
              <a href={`#/people/${e.id}`} key={e.id}>
                <Avatar name={fullName(e)} size="large" />
                <strong>{fullName(e)}</strong>
                <small>{e.designation ?? 'Employee'}</small>
                <span>{dateLabel(e.date_of_joining, shortDate)}</span>
              </a>
            ))}
          </div>
        ) : (
          <Empty
            title="No joiners in this month"
            text="New team members appear here on their joining date."
          />
        )}
      </Card>
    </Widget>
  )
}

/** Open tasks assigned to this person, completable in place. */
export function tasksTile({
  data,
  can,
  act,
}: {
  data: Workspace
  can: (permission: string) => boolean
  act: (path: string, body: unknown, message: string) => Promise<void>
}): ReactElement {
  return (
    <Widget id="tasks" title="My tasks" width={4}>
      <Card
        title="My tasks"
        subtitle="Assigned to you"
        href={can('task.read') ? '#/tasks' : undefined}
      >
        {data.tasks.length ? (
          <div className="task-mini">
            {data.tasks.slice(0, 3).map((t) => (
              <div key={t.id}>
                <Button
                  variant="secondary"
                  aria-label={`Complete ${t.title}`}
                  onClick={() =>
                    void act(`/tasks/${t.id}/complete`, {}, 'Task completed.')
                  }
                >
                  <Check size={17} />
                </Button>
                <div>
                  <strong>{t.title}</strong>
                  <small className={t.overdue ? 'overdue' : ''}>
                    {t.due_date
                      ? `Due ${dateLabel(t.due_date, shortDate)}`
                      : 'No due date'}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <Empty title="No open tasks" text="Tasks assigned to you appear here." />
        )}
      </Card>
    </Widget>
  )
}

/** The company activity log, trimmed to the most recent entries. */
export function activityTile({
  data,
  can,
}: {
  data: Workspace
  can: (permission: string) => boolean
}): ReactElement {
  return (
    <Widget id="activity" title="Recent activity" width={6}>
      <Card
        title="Recent activity"
        subtitle="Across your company"
        href={can('audit.read') ? '#/activity' : undefined}
      >
        {data.activity.length ? (
          <div className="activity-list">
            {data.activity.slice(0, 4).map((a) => (
              <div key={a.id}>
                <span className="icon-box">
                  <Clock3 size={18} />
                </span>
                <div>
                  <strong>{pretty(a.action)}</strong>
                  <small>
                    {a.entity_label ?? a.actor_label ?? pretty(a.entity_type)}
                  </small>
                </div>
                <time>{dateLabel(a.created_at, shortDate)}</time>
              </div>
            ))}
          </div>
        ) : (
          <Empty
            title="No activity yet"
            text="Actions you are permitted to see appear here."
          />
        )}
      </Card>
    </Widget>
  )
}

/** Company announcements, flagged when an acknowledgement is outstanding. */
export function announcementsTile({
  data,
  can,
}: {
  data: Workspace
  can: (permission: string) => boolean
}): ReactElement {
  return (
    <Widget id="announcements" title="Announcements" width={6}>
      <Card
        title="Announcements"
        subtitle="Shared with you" className="reference-announcements"
        href={can('announcement.read') ? '#/announcements' : undefined}
      >
        <img className="announcement-photo" src="/images/people-together.png" alt="A notebook reading People Thrive Together beside green leaves" />
        {data.announcements.length ? (
          <div className="announcement-mini">
            {data.announcements.slice(0, 3).map((a) => (
              <a href="#/announcements" key={a.id}>
                <span className="icon-box">
                  <Send size={18} />
                </span>
                <div>
                  <strong>{a.title}</strong>
                  <small>
                    {dateLabel(a.publish_at)}
                    {a.requires_acknowledgement && !a.acknowledged_at
                      ? ' · Acknowledgement needed'
                      : ''}
                  </small>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <Empty
            title="No announcements"
            text="Company updates shared with you appear here."
          />
        )}
      </Card>
    </Widget>
  )
}

