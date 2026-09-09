import { useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clock3,
  Settings2,
  ShieldCheck,
  Users,
  CalendarDays,
  Send,
  Sparkles,
} from 'lucide-react'
import type { Workspace, Setting } from './types'
import type { FormSpec } from './forms'
import { dateLabel, exportCsv, fullName, pretty } from './api'
import {
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  SearchBox,
  Donut,
} from './ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
}
export function TasksPage({ data, act }: Props) {
  const [busy, setBusy] = useState('')
  return (
    <>
      <PageHeader
        title="Small steps. Real progress."
        description="Your assigned work, with room to focus."
        eyebrow="Your task list"
      />
      <div className="two-column">
        <Card title="Up next" subtitle={`${data.tasks.length} open tasks`}>
          {data.tasks.length ? (
            <div className="task-list">
              {data.tasks.map((t) => (
                <article key={t.id}>
                  <Button
                    variant="secondary"
                    disabled={busy === t.id}
                    aria-label={`Complete ${t.title}`}
                    onClick={async () => {
                      setBusy(t.id)
                      try {
                        await act(
                          `/tasks/${t.id}/complete`,
                          {},
                          'Task completed.',
                        )
                      } finally {
                        setBusy('')
                      }
                    }}
                  >
                    <Check size={18} />
                  </Button>
                  <div>
                    <h3>{t.title}</h3>
                    <p>
                      {t.due_date
                        ? `Due ${dateLabel(t.due_date)}`
                        : 'No due date'}
                    </p>
                  </div>
                  <Badge>{t.overdue ? 'overdue' : t.status}</Badge>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="A little breathing room"
              text="You have no open assigned tasks. New tasks will appear here when they’re assigned to you."
            />
          )}
        </Card>
        <section className="focus-card">
          <Sparkles size={30} />
          <h2>
            One thing
            <br />
            at a time.
          </h2>
          <p>
            Give the important work
            <br />
            the attention it deserves.
          </p>
          <span className="focus-orb" />
        </section>
      </div>
    </>
  )
}
export function AnnouncementsPage({ data, act }: Props) {
  return (
    <>
      <PageHeader
        title="Worth sharing"
        description="Company news, useful updates, and a sense of belonging."
        eyebrow="Your noticeboard"
      />
      <div className="announcement-grid">
        {data.announcements.length ? (
          data.announcements.map((a) => (
            <Card key={a.id}>
              <div className="announcement-header">
                <span className="icon-box">
                  <Send size={21} />
                </span>
                <time>{dateLabel(a.publish_at)}</time>
              </div>
              <h2>{a.title}</h2>
              <p className="announcement-body">
                {
                  new DOMParser().parseFromString(a.body_html, 'text/html').body
                    .textContent
                }
              </p>
              {a.requires_acknowledgement && (
                <footer>
                  {a.acknowledged_at ? (
                    <span className="acknowledged">
                      <CheckCheck size={18} />
                      Acknowledged {dateLabel(a.acknowledged_at)}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void act(
                          `/announcements/${a.id}/acknowledge`,
                          {},
                          'Announcement acknowledged.',
                        )
                      }
                    >
                      <Check size={17} />
                      I’ve read this
                    </Button>
                  )}
                </footer>
              )}
            </Card>
          ))
        ) : (
          <Card>
            <Empty
              title="A quiet noticeboard, for now"
              text="Announcements addressed to you will appear here when published."
            />
          </Card>
        )}
      </div>
    </>
  )
}
export function SettingsPage({ data, open }: Props) {
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('All settings')
  const settings = data.settings.filter(
    (s) =>
      (category === 'All settings' ||
        s.key.startsWith(category.toLowerCase() + '.')) &&
      `${s.label} ${s.help}`.toLowerCase().includes(search.toLowerCase()),
  )
  function edit(s: Setting) {
    open({
      title: s.label,
      description: s.help,
      path: '/settings',
      fields: [
        {
          name: 'value',
          label: 'Value',
          value: String(s.value),
          type: s.kind === 'int' ? 'number' : 'text',
          options: ['flag', 'bool'].includes(s.kind)
            ? [
                { value: 'true', label: 'Enabled' },
                { value: 'false', label: 'Disabled' },
              ]
            : undefined,
          help:
            s.kind === 'enum'
              ? `Current value: ${s.value}. Enter a supported policy value.`
              : undefined,
        },
        ...(s.affects.includes('payroll')
          ? [
              {
                name: 'effectiveFrom',
                label: 'Effective from',
                type: 'date',
                value: data.today,
                help: 'Must be after any frozen payroll period.',
              },
            ]
          : []),
        { name: 'reason', label: 'Reason for change', type: 'textarea' },
      ],
      transform: (v) => ({
        ...v,
        key: s.key,
        value: ['flag', 'bool'].includes(s.kind)
          ? v.value === 'true'
          : s.kind === 'int'
            ? Number(v.value)
            : v.value,
      }),
    })
  }
  return (
    <>
      <PageHeader
        title="A workspace that works for you"
        description="Company policies, with thoughtful defaults and a clear history."
        eyebrow="Settings"
      />
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="company-tile">
            <span className="icon-box">
              <Users size={23} />
            </span>
            <h3>{data.company}</h3>
            <small>Your company workspace</small>
          </div>
          {['All settings', 'Leave', 'Attendance', 'Payroll', 'Helpdesk'].map(
            (s) => (
              <button
                className={s === category ? 'active' : ''}
                key={s}
                onClick={() => setCategory(s)}
              >
                <Settings2 size={17} />
                {s}
                <ChevronRight size={16} />
              </button>
            ),
          )}
        </aside>
        <Card>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Find a policy or setting..."
          />
          <div className="settings-list">
            {settings.length ? (
              settings.map((s) => (
                <article key={s.key}>
                  <div>
                    <span className="setting-category">
                      {s.key.split('.')[0]}
                    </span>
                    <h3>{s.label}</h3>
                    <p>{s.help}</p>
                    {s.affects.includes('payroll') && (
                      <small className="policy-note">
                        <ShieldCheck size={13} />
                        Effective-dated · affects payroll
                      </small>
                    )}
                  </div>
                  <div className="setting-control">
                    <span
                      className={
                        typeof s.value === 'boolean'
                          ? `toggle-preview ${s.value ? 'on' : ''}`
                          : 'setting-value'
                      }
                      aria-label={
                        typeof s.value === 'boolean'
                          ? s.value
                            ? 'Enabled'
                            : 'Disabled'
                          : undefined
                      }
                    >
                      {typeof s.value === 'boolean' ? (
                        <i />
                      ) : (
                        pretty(String(s.value))
                      )}
                    </span>
                    <Button variant="ghost" onClick={() => edit(s)}>
                      Edit
                      <ArrowUpRight size={15} />
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <Empty
                title="No matching settings"
                text="Try another search or category."
              />
            )}
          </div>
        </Card>
      </div>
    </>
  )
}
export function ReportsPage({ data }: Props) {
  const departments = Object.entries(
    data.employees.reduce<Record<string, number>>((o, e) => {
      o[e.department ?? 'Unassigned'] =
        (o[e.department ?? 'Unassigned'] ?? 0) + 1
      return o
    }, {}),
  ).map(([label, value]) => ({ label, value }))
  const reports = [
    {
      name: 'People directory',
      text: 'Your permitted workforce, departments and employment status.',
      count: data.employees.length,
      rows: data.employees.map((e) => ({
        Employee: fullName(e),
        Number: e.employee_number,
        Department: e.department,
        Status: e.status,
        Joined: e.date_of_joining,
      })),
      permission: 'employee.read',
      icon: <Users size={22} />,
    },
    {
      name: 'Attendance snapshot',
      text: `Recorded employee days for ${dateLabel(data.date)}.`,
      count: data.attendance.length,
      rows: data.attendance.map((a) => ({
        Employee: fullName(a),
        Date: a.work_date,
        Status: a.status,
        Minutes: a.worked_minutes,
        Remote: a.is_remote,
      })),
      permission: 'attendance.read',
      icon: <Clock3 size={22} />,
    },
    {
      name: 'Leave request register',
      text: 'Time off requests and their current approval status.',
      count: data.leaves.length,
      rows: data.leaves.map((l) => ({
        Employee: fullName(l),
        Type: l.leave_name,
        From: l.start_date,
        To: l.end_date,
        Days: l.total_days,
        Status: l.status,
      })),
      permission: 'leave.read',
      icon: <CalendarDays size={22} />,
    },
  ]
  return (
    <>
      <PageHeader
        title="Clarity for your next move"
        description="Useful perspectives, built from your workspace’s real records."
        eyebrow="Reports & insights"
      />
      <div className="report-grid">
        {reports
          .filter((r) => data.permissions.includes(r.permission))
          .map((r) => (
            <Card key={r.name}>
              <span className="icon-box">{r.icon}</span>
              <h2>{r.name}</h2>
              <p>{r.text}</p>
              <footer>
                <small>{r.count} records</small>
                <Button
                  variant="secondary"
                  disabled={!r.count}
                  onClick={() => exportCsv(r.name, r.rows)}
                >
                  <ArrowDownToLine size={16} />
                  Export CSV
                </Button>
              </footer>
            </Card>
          ))}
      </div>
      <div className="two-column">
        <Card
          title="How your team comes together"
          subtitle="Department distribution"
        >
          {data.employees.length ? (
            <Donut
              segments={departments}
              value={data.employees.length}
              label="people"
            />
          ) : (
            <Empty
              title="Your people tell the story"
              text="Add employees to see department insights."
            />
          )}
        </Card>
        <Card title="A view you can trust">
          <div className="report-note">
            <ShieldCheck size={32} />
            <h2>
              Same records.
              <br />A clearer perspective.
            </h2>
            <p>
              Exports follow your current access scope. Attendance counts
              reflect recorded days, and leave totals reflect submitted
              requests.
            </p>
            <span className="scope-chip">
              Access scope: {pretty(data.user.scope)}
            </span>
          </div>
        </Card>
      </div>
    </>
  )
}
export function ActivityPage({ data }: Props) {
  const [search, setSearch] = useState('')
  const rows = data.activity.filter((a) =>
    `${a.action} ${a.entity_label ?? ''} ${a.actor_label ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <>
      <PageHeader
        title="Every step, accounted for"
        description="A record of changes across your workspace."
        eyebrow="Activity log"
      />
      <Card>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search recent activity..."
        />
        {rows.length ? (
          <div className="activity-full">
            {rows.map((a) => (
              <article key={a.id}>
                <span className="icon-box">
                  <Clock3 size={19} />
                </span>
                <div>
                  <h3>{pretty(a.action)}</h3>
                  <p>
                    {a.entity_label ?? pretty(a.entity_type)}
                    {a.actor_label ? ` · ${a.actor_label}` : ''}
                  </p>
                </div>
                <Badge>{a.severity}</Badge>
                <time>
                  {dateLabel(a.created_at)}
                  <small>
                    {new Date(a.created_at).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </time>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="No recent activity in this view"
            text="The latest 30 permitted events appear here as work happens."
          />
        )}
      </Card>
    </>
  )
}
