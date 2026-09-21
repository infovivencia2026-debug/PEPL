import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  Clock3,
  ShieldCheck,
  Users,
  CalendarDays,
} from 'lucide-react'
import { dateLabel, exportCsv, fullName, pretty } from '../api'
import { decodeBase64, domainApi, downloadFile } from '../domainApi'
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
  const [from, setFrom] = useState(`${data.today.slice(0, 4)}-01-01`)
  const [to, setTo] = useState(data.today)
  const [attrition, setAttrition] = useState<Record<string, string | number | null>[]>([])
  const [attritionError, setAttritionError] = useState('')
  useEffect(() => {
    if (data.user.scope !== 'all') return
    void domainApi<{ rows: Record<string, string | number | null>[] }>(`/reports/attrition?from=${from}&to=${to}`).then(result => { setAttrition(result.rows); setAttritionError('') }).catch(caught => setAttritionError(caught instanceof Error ? caught.message : 'Unable to load attrition'))
  }, [data.user.scope, from, to])
  const downloadAttrition = async () => { const result = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/reports/attrition?from=${from}&to=${to}&format=csv`); downloadFile(result.fileName, result.contentType, decodeBase64(result.contentBase64)) }
  const departments = Object.entries(
    data.employees.reduce<Record<string, number>>((o, e) => {
      o[e.department ?? 'Unassigned'] =
        (o[e.department ?? 'Unassigned'] ?? 0) + 1
      return o
    }, {}),
  ).map(([label, value]) => ({ label, value }))
  const attritionDepartments = Object.entries(attrition.reduce<Record<string, number>>((result, row) => { const department = String(row.department || 'Unassigned'); result[department] = (result[department] ?? 0) + Number(row.leavers || 0); return result }, {}))
  const maxAttrition = Math.max(1, ...attritionDepartments.map(([, count]) => count))
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
      {data.user.scope === 'all' && <Card className="attrition-report" title="Attrition & exit insights" subtitle="Leavers by department, reason and tenure"><div className="report-range"><label>From<input type="date" value={from} onChange={event => setFrom(event.target.value)} /></label><label>To<input type="date" value={to} onChange={event => setTo(event.target.value)} /></label><Button variant="secondary" disabled={!attrition.length} onClick={() => void downloadAttrition()}><ArrowDownToLine size={16} />Export CSV</Button></div>{attritionError && <p className="form-error" role="alert">{attritionError}</p>}{attrition.length ? <><div className="attrition-bars">{attritionDepartments.map(([department, count]) => <div key={department}><span>{department}</span><i><b style={{ width: `${Math.max(8, count / maxAttrition * 100)}%` }} /></i><strong>{count}</strong></div>)}</div><div className="table-scroll"><table><thead><tr><th>Department</th><th>Reason</th><th>Tenure</th><th>Leavers</th><th>Voluntary</th><th>Exit interview themes</th></tr></thead><tbody>{attrition.map((row, index) => <tr key={`${row.department}-${row.reason}-${row.tenure_band}-${index}`}><td>{row.department || 'Unassigned'}</td><td>{pretty(String(row.reason))}</td><td>{row.tenure_band}</td><td>{row.leavers}</td><td>{row.voluntary}</td><td>{row.exit_interview_reasons || '—'}</td></tr>)}</tbody></table></div></> : <Empty title="No separations in this range" text="Choose a wider date range to review attrition patterns." />}</Card>}
    </>
  )
}
