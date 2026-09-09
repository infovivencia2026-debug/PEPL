import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import {
  ArrowDownToLine,
  Clock3,
  ShieldCheck,
  Users,
  CalendarDays,
} from 'lucide-react'
import { dateLabel, exportCsv, fullName, pretty } from '../api'
import {
  Button,
  Card,
  Empty,
  PageHeader,
  Donut,
} from '../ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
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
