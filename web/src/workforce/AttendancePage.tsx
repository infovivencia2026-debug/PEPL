import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Download,
  House,
  MapPinned,
  Plus,
  Users,
} from 'lucide-react'
import { fullName, dateLabel, exportCsv, pretty } from '../api'
import { PunchControl } from '../PunchControl'
import { RemoteWorkPanel } from '../RemoteWork'
import { MusterPage } from '../time/Muster'
import { MyMonth } from '../time/MyMonth'
import { ControlRoom } from '../time/ControlRoom'
import { KioskPage } from '../time/Kiosk'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  SearchBox,
  Stat,
  Tabs,
} from '../ui'
type Props = { data: Workspace; open: (s: FormSpec) => void }

export function AttendancePage({
  data,
  open,
  onDate,
  view = 'register',
}: { onDate: (s: string) => void; view?: string } & Props) {
  const [search, setSearch] = useState(''),
    [status, setStatus] = useState('')
  // Sub-views live in the route (#/attendance/muster …) so each is deep-linkable.
  const VIEWS: Array<[string, string, boolean]> = [
    ['register', 'Register', true],
    ['muster', 'Muster', data.permissions.includes('attendance.read') && data.user.scope !== 'self'],
    ['month', 'My month', Boolean(data.user.employeeId)],
    ['control-room', 'Control room', data.user.scope !== 'self'],
    ['kiosk', 'Kiosk', data.permissions.includes('attendance.kiosk')],
  ]
  const visible = VIEWS.filter((v) => v[2])
  const tabs = (
    <Tabs value={visible.find((v) => v[0] === view)?.[1] ?? 'Register'} onChange={(label) => { const v = visible.find((x) => x[1] === label); window.location.hash = `#/attendance${v && v[0] !== 'register' ? `/${v[0]}` : ''}` }} items={visible.map((v) => v[1])} />
  )
  if (view === 'muster') return <><PageHeader title="Muster roll" description="What payroll will freeze: one code per person per day, from the same classification." eyebrow="Time · Muster" />{tabs}<MusterPage data={data} open={open} /></>
  if (view === 'month') return <><PageHeader title="My month" description="Your own days, as they will count." eyebrow="Time · My month" />{tabs}<MyMonth data={data} /></>
  if (view === 'control-room') return <><PageHeader title="Control room" description="Who is in, late, missing or on break — right now." eyebrow="Time · Live" />{tabs}<ControlRoom data={data} /></>
  if (view === 'kiosk') return <><PageHeader title="Kiosk" description="Put this on the wall tablet at the door." eyebrow="Time · Kiosk" />{tabs}<KioskPage data={data} /></>
  const rows = data.attendance.filter(
    (a) =>
      fullName(a).toLowerCase().includes(search.toLowerCase()) &&
      (!status || a.status === status),
  )
  const time = (s: string | null) =>
    s
      ? new Date(s).toLocaleTimeString('en-IN', {
          hour: '2-digit',
          minute: '2-digit',
        })
      : '—'
  function move(n: number) {
    const d = new Date(data.date + 'T12:00:00')
    d.setDate(d.getDate() + n)
    onDate(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    )
  }
  return (
    <>
      <PageHeader
        title="Attendance"
        description="A clear picture of every working day."
        eyebrow="Presence, with perspective"
      >
        <Button
          variant="secondary"
          disabled={!rows.length}
          onClick={() =>
            exportCsv(
              `attendance-${data.date}`,
              rows.map((a) => ({
                Name: fullName(a),
                Date: a.work_date,
                'Check in': a.first_in,
                'Check out': a.last_out,
                'Minutes worked': a.worked_minutes,
                Status: a.status,
                Remote: a.is_remote,
              })),
            )
          }
        >
          <Download size={17} />
          Export
        </Button>
        {data.permissions.includes('attendance.correct') && (
          <Button
            onClick={() =>
              open({
                title: 'Correct an attendance day',
                description:
                  'A correction records what changed and why. Closed periods are protected; frozen-period corrections carry into the next open period.',
                path: '/attendance/corrections',
                domain: true,
                fields: [
                  {
                    name: 'employeeId',
                    label: 'Employee',
                    options: data.employees.map((e) => ({
                      value: e.id,
                      label: fullName(e),
                    })),
                  },
                  {
                    name: 'workDate',
                    label: 'Date',
                    type: 'date',
                    value: data.date,
                  },
                  {
                    name: 'action',
                    label: 'Correction',
                    options: [
                      'mark_present',
                      'mark_absent',
                      'mark_half_day',
                      'mark_full_day',
                      'mark_remote',
                      'revoke_remote',
                      'mark_field_duty',
                    ].map((value) => ({ value, label: pretty(value) })),
                  },
                  {
                    name: 'reason',
                    label: 'Reason for correction',
                    type: 'textarea',
                  },
                ],
              })
            }
          >
            <Plus size={17} />
            Record correction
          </Button>
        )}
      </PageHeader>
      {tabs}
      {data.user.employeeId && <PunchControl data={data} />}
      <RemoteWorkPanel data={data} />
      <div className="stats-row">
        <Stat
          label="Present"
          value={data.attendance.filter((a) => a.status === 'present').length}
          note="Recorded as present"
          icon={<Users size={20} />}
          variant="mint-card"
        />
        <Stat
          label="Remote"
          value={data.attendance.filter((a) => a.is_remote).length}
          note="Across recorded statuses"
          icon={<House size={20} />}
        />
        <Stat
          label="On leave"
          value={data.attendance.filter((a) => a.status === 'on_leave').length}
          note="Approved time away"
          icon={<CalendarDays size={20} />}
          variant="sand-card"
        />
        <Stat
          label="Absent"
          value={data.attendance.filter((a) => a.status === 'absent').length}
          note="Recorded absences"
          icon={<Clock3 size={20} />}
          variant="coral-card"
        />
      </div>
      <Card className="data-card">
        <div className="filter-bar">
          <div className="date-navigator">
            <Button
              variant="ghost"
              aria-label="Previous day"
              onClick={() => move(-1)}
            >
              <ChevronLeft size={18} />
            </Button>
            <label>
              <span className="sr-only">Attendance date</span>
              <input
                type="date"
                value={data.date}
                onChange={(e) => {
                  if (e.target.value) onDate(e.target.value)
                }}
              />
            </label>
            <Button
              variant="ghost"
              aria-label="Next day"
              onClick={() => move(1)}
            >
              <ChevronRight size={18} />
            </Button>
            <Button variant="secondary" onClick={() => onDate(data.today)}>
              Today
            </Button>
          </div>
          <SearchBox value={search} onChange={setSearch} />
          <select
            value={status}
            aria-label="Attendance status"
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">All statuses</option>
            {[
              'present',
              'absent',
              'on_leave',
              'on_duty',
              'weekly_off',
              'holiday',
            ].map((s) => (
              <option key={s} value={s}>
                {pretty(s)}
              </option>
            ))}
          </select>
        </div>
        {rows.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Check in</th>
                  <th>Check out</th>
                  <th>Working time</th>
                  <th>Status</th>
                  <th>Work mode</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.employee_id}>
                    <td>
                      <a
                        className="person-line"
                        href={`#/people/${a.employee_id}`}
                      >
                        <Avatar name={fullName(a)} />
                        <span>
                          <strong>{fullName(a)}</strong>
                          <small>{a.employee_number}</small>
                        </span>
                      </a>
                    </td>
                    <td>{time(a.first_in)}</td>
                    <td>
                      {time(a.last_out)}
                      {a.first_in && !a.last_out && (
                        <small className="inline-note">Open punch</small>
                      )}
                    </td>
                    <td>
                      {Math.floor(a.worked_minutes / 60)}h{' '}
                      {a.worked_minutes % 60}m
                    </td>
                    <td>
                      <Badge>{a.status}</Badge>
                      {Number(a.day_fraction) === 0.5 && (
                        <small className="inline-note">Half day</small>
                      )}
                    </td>
                    <td>
                      {a.is_remote
                        ? <span className="work-mode"><House size={14} />Remote</span>
                        : a.is_field_duty
                          ? <span className="work-mode"><MapPinned size={14} />Field duty</span>
                          : <span className="work-mode"><Users size={14} />On site</span>}
                      {a.is_regularized && (
                        <small className="inline-note">Regularized</small>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No attendance records for this view"
            text="Select another day or clear your filters. Missing records are not counted as absences."
          />
        )}
        <footer className="table-footer">
          {rows.length} recorded employee days · {dateLabel(data.date)}
        </footer>
      </Card>
    </>
  )
}
