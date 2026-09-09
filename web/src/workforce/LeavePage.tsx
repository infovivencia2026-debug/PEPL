import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  CalendarDays,
  Plus,
} from 'lucide-react'
import { fullName, dateLabel, pretty } from '../api'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  SearchBox,
  Tabs,
} from '../ui'
type Props = { data: Workspace; open: (s: FormSpec) => void }

export function LeavePage({ data, open }: Props) {
  const [tab, setTab] = useState('Requests'),
    [status, setStatus] = useState(''),
    [search, setSearch] = useState(''),
    [month, setMonth] = useState(data.today.slice(0, 7))
  const rows = data.leaves.filter(
    (l) =>
      (!status || l.status === status) &&
      fullName(l).toLowerCase().includes(search.toLowerCase()),
  )
  const start = new Date(month + '-01T12:00:00'),
    days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate(),
    offset = (start.getDay() + 6) % 7
  return (
    <>
      <PageHeader
        title="Time to recharge"
        description="Thoughtful time off. A team that stays in sync."
        eyebrow="Leave & wellbeing"
      >
        {data.permissions.includes('leave.apply') && data.user.employeeId && (
          <Button
            onClick={() =>
              open({
                title: 'Make time for yourself',
                description:
                  'Choose full calendar days (up to 31 per request). Every day in this range counts, including weekends. Your assigned approval chain will review the request.',
                path: '/leave/requests',
                submit: 'Submit request',
                success: 'Leave request submitted for approval.',
                fields: [
                  {
                    name: 'leaveTypeId',
                    label: 'Leave type',
                    options: data.leaveTypes.map((t) => ({
                      value: t.id,
                      label: t.name,
                    })),
                  },
                  {
                    name: 'startDate',
                    label: 'First day',
                    type: 'date',
                    value: data.today,
                  },
                  {
                    name: 'endDate',
                    label: 'Last day',
                    type: 'date',
                    value: data.today,
                  },
                  { name: 'reason', label: 'Reason', type: 'textarea' },
                ],
              })
            }
          >
            <Plus size={18} />
            Apply for leave
          </Button>
        )}
      </PageHeader>
      {data.balances.length > 0 && (
        <div className="balance-row">
          {data.balances.map((b, i) => (
            <Card key={b.id} className={i % 2 === 0 ? 'mint-card' : ''}>
              <div className="balance-top">
                <span className="icon-box">
                  <CalendarDays size={20} />
                </span>
                <h2>{b.name}</h2>
              </div>
              <strong className="balance-number">
                {b.available}
                <small> days available</small>
              </strong>
              <p className="subtle">
                {b.consumed} used · {b.opening + b.accrued} opening + accrued
              </p>
            </Card>
          ))}
        </div>
      )}
      <Card className="data-card">
        <div className="section-tabs">
          <Tabs
            value={tab}
            onChange={setTab}
            items={['Requests', 'Team calendar', 'Leave types']}
          />
          {tab === 'Requests' && (
            <span className="subtle">
              {data.leaves.filter((l) => l.status === 'pending').length} pending
              requests
            </span>
          )}
        </div>
        {tab === 'Requests' ? (
          <>
            <div className="filter-bar">
              <SearchBox value={search} onChange={setSearch} />
              <select
                value={status}
                aria-label="Leave status"
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">All requests</option>
                {['pending', 'approved', 'rejected', 'cancelled'].map((s) => (
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
                      <th>Leave type</th>
                      <th>Time away</th>
                      <th>Days</th>
                      <th>Status</th>
                      <th>Reason</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <span className="person-line">
                            <Avatar name={fullName(l)} />
                            <strong>{fullName(l)}</strong>
                          </span>
                        </td>
                        <td>{l.leave_name}</td>
                        <td>
                          {dateLabel(l.start_date, {
                            day: 'numeric',
                            month: 'short',
                          })}{' '}
                          – {dateLabel(l.end_date)}
                        </td>
                        <td>{l.total_days}</td>
                        <td>
                          <Badge>{l.status}</Badge>
                        </td>
                        <td className="reason-cell">{l.reason || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty
                title="No leave requests in this view"
                text="New requests will appear here. Try a different filter if you’re looking for an earlier request."
              />
            )}
          </>
        ) : tab === 'Team calendar' ? (
          <div className="calendar-section">
            <div className="calendar-heading">
              <h2>
                {dateLabel(month + '-01', { month: 'long', year: 'numeric' })}
              </h2>
              <input
                type="month"
                aria-label="Calendar month"
                value={month}
                onChange={(e) => {
                  if (e.target.value) setMonth(e.target.value)
                }}
              />
              <span className="subtle">Approved leave only</span>
            </div>
            <div className="calendar-grid">
              {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => (
                <div className="weekday" key={d}>
                  {d}
                </div>
              ))}
              {Array.from({ length: offset }, (_, i) => (
                <div className="calendar-day muted-day" key={'blank' + i} />
              ))}
              {Array.from({ length: days }, (_, i) => {
                const date = month + '-' + String(i + 1).padStart(2, '0'),
                  leaves = data.leaves.filter(
                    (l) =>
                      l.status === 'approved' &&
                      l.start_date <= date &&
                      l.end_date >= date,
                  )
                return (
                  <div
                    className={`calendar-day ${date === data.today ? 'today' : ''}`}
                    key={date}
                  >
                    <time dateTime={date}>{i + 1}</time>
                    {leaves.map((l) => (
                      <span
                        className="calendar-leave"
                        key={l.id}
                        title={`${fullName(l)} · ${l.leave_name}`}
                      >
                        {fullName(l)}
                      </span>
                    ))}
                  </div>
                )
              })}
            </div>
          </div>
        ) : (
          <div className="leave-type-list">
            {data.leaveTypes.length ? (
              data.leaveTypes.map((t) => (
                <article key={t.id}>
                  <span className="icon-box">
                    <CalendarDays size={21} />
                  </span>
                  <div>
                    <h3>{t.name}</h3>
                    <p>
                      {t.code} · {t.is_paid ? 'Paid leave' : 'Unpaid leave'}
                    </p>
                  </div>
                </article>
              ))
            ) : (
              <Empty
                title="No leave types configured"
                text="Your company administrator needs to configure leave types before requests can be submitted."
              />
            )}
          </div>
        )}
      </Card>
    </>
  )
}
