import { Widget, WidgetBoard } from './WidgetBoard'
import { AmbientSculpture } from './AmbientSculpture'
import {
  Users,
  CalendarDays,
  UserPlus,
  Wallet,
  ArrowUpRight,
  ArrowRight,
  CheckCheck,
  Sun,
  Clock3,
  Sparkles,
  Check,
  Send,
} from 'lucide-react'
import type { Workspace } from './types'
import { fullName, dateLabel, money, pretty } from './api'
import { Avatar, Button, Card, Donut, Empty, Stat, ViewLink } from './ui'
export function Dashboard({
  data,
  act,
}: {
  data: Workspace
  act: (path: string, body: unknown, message: string) => Promise<void>
}) {
  const employees = data.employees,
    active = employees.filter((e) => e.status === 'active'),
    month = data.today.slice(0, 7)
  const joiners = employees
    .filter((e) => e.date_of_joining.startsWith(month))
    .sort((a, b) => b.date_of_joining.localeCompare(a.date_of_joining))
  const onLeave = data.leaves.filter(
    (l) =>
      l.status === 'approved' &&
      l.start_date <= data.today &&
      l.end_date >= data.today,
  )
  const present = data.attendance.filter(
    (a) => a.status === 'present' || a.status === 'on_duty',
  ).length
  const departments = Object.entries(
    employees.reduce<Record<string, number>>((o, e) => {
      const d = e.department ?? 'Unassigned'
      o[d] = (o[d] ?? 0) + 1
      return o
    }, {}),
  ).sort((a, b) => b[1] - a[1])
  const totalAttendance = data.attendance.length
  const distribution = departments
    .slice(0, 5)
    .map(([label, value]) => ({ label, value }))
  if (departments.length > 5)
    distribution.push({
      label: 'Other teams',
      value: departments.slice(5).reduce((s, x) => s + x[1], 0),
    })
  const payroll = data.payroll.find((p) => p.label.startsWith(month))
  const hour = new Date().getHours(),
    greeting =
      hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'
  const has = (p: string) => data.permissions.includes(p)
  return (
    <>
      <div className="dashboard-heading">
        <div>
          <span className="eyebrow">Your everyday, a little easier</span>
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
<Widget id="welcome" title="Welcome" width={4} hero><section className="welcome-card">
          <div>
            <span className="welcome-tag">
              <Sun size={16} /> A good day to grow
            </span>
            <h2>
              {greeting},<br />
              {data.user.full_name.split(' ')[0]}
              <span>!</span>
            </h2>
            <p>
              Here’s what’s happening
              <br />
              with your people today.
            </p>
            <a href={has('approval.act') ? '#/approvals' : '#/people'}>
              {data.approvals.length
                ? `${data.approvals.length} decisions need your attention`
                : 'Make room for meaningful work'}
              <ArrowRight size={18} />
            </a>
          </div>
          <AmbientSculpture />
        </section></Widget>
        
          {has('employee.read') && (
            <Widget id="people" title="People" width={2}><Stat
              label={
                data.user.scope === 'all'
                  ? 'People in your company'
                  : 'People in your scope'
              }
              value={employees.length}
              note={`${active.length} active employees`}
              icon={<Users size={21} />}
              href="#/people"
            /></Widget>
          )}
          {data.modules.leave && has('leave.read') && (
            <Widget id="leave" title="On leave" width={2}><Stat
              label="On leave today"
              value={onLeave.length}
              note="Approved time away"
              icon={<CalendarDays size={21} />}
              variant="mint-card"
              href="#/leave"
            /></Widget>
          )}
          {has('employee.read') && (
            <Widget id="new-faces" title="New faces" width={2}><Stat
              label="New faces this month"
              value={joiners.length}
              note={dateLabel(data.today, { month: 'short', year: 'numeric' })}
              icon={<UserPlus size={21} />}
              variant="sand-card"
              href="#/people"
            /></Widget>
          )}
          {data.modules.payroll &&
          has('payroll.read') &&
          data.user.scope === 'all' ? (
            <Widget id="payroll" title="Payroll" width={2}><Stat
              label="Payroll this month"
              value={money(payroll?.net_paise)}
              note={payroll ? pretty(payroll.status) : 'No run for this month'}
              icon={<Wallet size={21} />}
              variant="coral-card"
              href="#/payroll"
            /></Widget>
          ) : (
            <Widget id="pending" title="Pending actions" width={3}><Stat
              label="Your pending actions"
              value={data.approvals.length + data.tasks.length}
              note="Approvals and assigned tasks"
              icon={<CheckCheck size={21} />}
              variant="coral-card"
              href="#/approvals"
            /></Widget>
          )}
        
      
      
        {has('employee.read') && (
          <Widget id="departments" title="Teams" width={3}><Card
            title="A team, many talents"
            subtitle="Your people by department"
            href="#/people"
          >
            {employees.length ? (
              <Donut
                segments={distribution}
                value={employees.length}
                label="people, together"
              />
            ) : (
              <Empty
                title="Your team starts here"
                text="Add your first employee to see your workforce overview."
                action={<ViewLink href="#/people">Go to people</ViewLink>}
              />
            )}
          </Card></Widget>
        )}
        {data.modules.attendance && has('attendance.read') && (
          <Widget id="attendance" title="Attendance" width={3}><Card
            title="Showing up, together"
            subtitle="Attendance today"
            href="#/attendance"
          >
            {totalAttendance ? (
              <Donut
                segments={[
                  { label: 'Present', value: present },
                  {
                    label: 'On leave',
                    value: data.attendance.filter(
                      (a) => a.status === 'on_leave',
                    ).length,
                  },
                  {
                    label: 'Absent',
                    value: data.attendance.filter((a) => a.status === 'absent')
                      .length,
                  },
                  {
                    label: 'Other',
                    value: data.attendance.filter(
                      (a) =>
                        !['present', 'on_duty', 'on_leave', 'absent'].includes(
                          a.status,
                        ),
                    ).length,
                  },
                ]}
                value={`${Math.round((present / totalAttendance) * 100)}%`}
                label="of recorded days"
              />
            ) : (
              <Empty
                title="A fresh start to the day"
                text="Attendance appears here as daily records are created."
              />
            )}
            <div className="card-foot">
              <span className="status-dot" />
              {data.attendance.filter((a) => a.is_remote).length} working
              remotely{' '}
              <span className="subtle">· {totalAttendance} recorded</span>
            </div>
          </Card></Widget>
        )}
        <Widget id="approvals" title="Approvals" width={3}><Card
          title="A little attention"
          subtitle="Your approval inbox"
          href={has('approval.act') ? '#/approvals' : undefined}
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
                          ? `${dateLabel(leave.start_date, { day: 'numeric', month: 'short' })} – ${dateLabel(leave.end_date, { day: 'numeric', month: 'short' })}`
                          : dateLabel(a.created_at)}
                      </span>
                      <a href="#/approvals" className="text-link">
                        Review
                        <ArrowUpRight size={16} />
                      </a>
                    </div>
                  </div>
                )
              })}
            </div>
          ) : (
            <Empty
              title="All caught up"
              text="When a request needs your decision, you’ll find it here."
            />
          )}
        </Card></Widget>
      
      
        <Widget id="joiners" title="New joiners" width={3}><Card
          title="Make them feel at home"
          subtitle="New joiners this month"
          href="#/people"
        >
          {joiners.length ? (
            <div className="joiner-grid">
              {joiners.slice(0, 4).map((e) => (
                <a href={`#/people/${e.id}`} key={e.id}>
                  <Avatar name={fullName(e)} size="large" />
                  <strong>{fullName(e)}</strong>
                  <small>{e.designation ?? 'New team member'}</small>
                  <span>
                    {dateLabel(e.date_of_joining, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </span>
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="Room for the next chapter"
              text="New team members joining this month will appear here."
            />
          )}
        </Card></Widget>
        <Widget id="tasks" title="My tasks" width={3}><Card
          title="On your list"
          subtitle="Small steps, meaningful progress"
          href={has('task.read') ? '#/tasks' : undefined}
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
                        ? `Due ${dateLabel(t.due_date, { day: 'numeric', month: 'short' })}`
                        : 'No due date'}
                    </small>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="A little breathing room"
              text="You have no open assigned tasks."
            />
          )}
        </Card></Widget>
        <Widget id="inspiration" title="A little inspiration" width={3}><section className="insight-card">
          <Sparkles size={30} />
          <h2>
            Good things
            <br />
            grow with
            <br />
            <em>good people.</em>
          </h2>
          <span className="insight-line" />
          <div className="insight-orbit" aria-hidden="true" />
        </section></Widget>
      
      
        <Widget id="activity" title="Recent activity" width={6}><Card
          title="Around your workspace"
          href={has('audit.read') ? '#/activity' : undefined}
          subtitle="Recent activity"
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
                  <time>
                    {dateLabel(a.created_at, {
                      day: 'numeric',
                      month: 'short',
                    })}
                  </time>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="Every step has a story"
              text="Activity you’re permitted to see will appear here."
            />
          )}
        </Card></Widget>
        <Widget id="announcements" title="Announcements" width={6}><Card
          title="Worth sharing"
          subtitle="Announcements for you"
          href={has('announcement.read') ? '#/announcements' : undefined}
        >
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
                  <ArrowUpRight size={16} />
                </a>
              ))}
            </div>
          ) : (
            <Empty
              title="Keep everyone in the loop"
              text="Company updates shared with you will appear here."
            />
          )}
        </Card></Widget>
      
    </WidgetBoard>
    </>
  )
}


