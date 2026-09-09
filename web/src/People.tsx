import { useState, useEffect } from 'react'
import {
  Plus,
  Download,
  LayoutGrid,
  List,
  ArrowUpRight,
  ArrowLeft,
  BriefcaseBusiness,
  Users,
} from 'lucide-react'
import { api, fullName, dateLabel, money, exportCsv } from './api'
import type { Workspace, Profile } from './types'
import type { FormSpec } from './forms'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  PageHeader,
  SearchBox,
  Skeleton,
  Tabs,
} from './ui'
export function People({
  data,
  open,
}: {
  data: Workspace
  open: (s: FormSpec) => void
}) {
  const [search, setSearch] = useState(''),
    [department, setDepartment] = useState(''),
    [status, setStatus] = useState(''),
    [view, setView] = useState('table'),
    [page, setPage] = useState(1)
  const rows = data.employees.filter(
    (e) =>
      `${fullName(e)} ${e.employee_number} ${e.designation ?? ''}`
        .toLowerCase()
        .includes(search.toLowerCase()) &&
      (!department || e.department === department) &&
      (!status || e.status === status),
  )
  const pages = Math.max(1, Math.ceil(rows.length / 12)),
    current = Math.min(page, pages),
    visible = rows.slice((current - 1) * 12, current * 12)
  function add() {
    open({
      title: 'A new chapter starts here',
      description:
        'Add the employee’s identity and first employment assignment. You can record future role changes from their profile.',
      path: '/employees',
      submit: 'Add employee',
      success: 'Employee added to your team.',
      fields: [
        { name: 'firstName', label: 'First name' },
        { name: 'lastName', label: 'Last name', required: false },
        { name: 'employeeNumber', label: 'Employee number' },
        {
          name: 'dateOfJoining',
          label: 'Joining date',
          type: 'date',
          value: data.today,
        },
        { name: 'department', label: 'Department' },
        { name: 'designation', label: 'Job title' },
      ],
    })
  }
  return (
    <>
      <PageHeader
        title="People"
        description="Every person. Every possibility. One place."
        eyebrow="The heart of your company"
      >
        <Button
          variant="secondary"
          disabled={!rows.length}
          onClick={() =>
            exportCsv(
              'pepl-people',
              rows.map((e) => ({
                Name: fullName(e),
                'Employee number': e.employee_number,
                Department: e.department,
                'Job title': e.designation,
                Status: e.status,
                'Joining date': e.date_of_joining,
              })),
            )
          }
        >
          <Download size={17} />
          Export
        </Button>
        {data.permissions.includes('employee.write') &&
          data.user.scope === 'all' && (
            <Button onClick={add}>
              <Plus size={18} />
              Add employee
            </Button>
          )}
      </PageHeader>
      <div className="people-summary">
        <span>
          <b>{data.employees.length}</b> people in your workspace
        </span>
        <span className="divider" />
        <span>
          <span className="status-dot" />
          {data.employees.filter((e) => e.status === 'active').length} active
        </span>
        <span className="summary-right">
          <Users size={17} />
          {
            new Set(data.employees.map((e) => e.department).filter(Boolean))
              .size
          }{' '}
          departments, one team
        </span>
      </div>
      <Card className="data-card">
        <div className="filter-bar">
          <SearchBox
            value={search}
            onChange={(v) => {
              setSearch(v)
              setPage(1)
            }}
            placeholder="Search by name, ID or role..."
          />
          <select
            aria-label="Filter by department"
            value={department}
            onChange={(e) => {
              setDepartment(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All departments</option>
            {[
              ...new Set(
                data.employees.map((e) => e.department).filter(Boolean),
              ),
            ]
              .sort()
              .map((d) => (
                <option key={d} value={d!}>
                  {d}
                </option>
              ))}
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value)
              setPage(1)
            }}
          >
            <option value="">All statuses</option>
            {[...new Set(data.employees.map((e) => e.status))].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
          <div className="view-toggle">
            <button
              aria-label="Table view"
              aria-pressed={view === 'table'}
              onClick={() => setView('table')}
            >
              <List size={19} />
            </button>
            <button
              aria-label="Card view"
              aria-pressed={view === 'cards'}
              onClick={() => setView('cards')}
            >
              <LayoutGrid size={18} />
            </button>
          </div>
        </div>
        {rows.length ? (
          view === 'table' ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Department</th>
                    <th>Job title</th>
                    <th>Joined on</th>
                    <th>Status</th>
                    <th>
                      <span className="sr-only">Profile</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((e) => (
                    <tr key={e.id}>
                      <td>
                        <a className="person-line" href={`#/people/${e.id}`}>
                          <Avatar name={fullName(e)} />
                          <span>
                            <strong>{fullName(e)}</strong>
                            <small>{e.employee_number}</small>
                          </span>
                        </a>
                      </td>
                      <td>{e.department ?? 'Unassigned'}</td>
                      <td>{e.designation ?? '—'}</td>
                      <td>{dateLabel(e.date_of_joining)}</td>
                      <td>
                        <Badge>{e.status}</Badge>
                      </td>
                      <td>
                        <a
                          className="row-open"
                          href={`#/people/${e.id}`}
                          aria-label={`Open ${fullName(e)} profile`}
                        >
                          <ArrowUpRight size={19} />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="employee-cards">
              {visible.map((e) => (
                <a
                  href={`#/people/${e.id}`}
                  className="employee-card"
                  key={e.id}
                >
                  <div>
                    <Avatar name={fullName(e)} size="large" />
                    <ArrowUpRight size={19} />
                  </div>
                  <h3>{fullName(e)}</h3>
                  <p>{e.designation ?? 'Team member'}</p>
                  <small>
                    {e.department ?? 'Unassigned'} · {e.employee_number}
                  </small>
                  <footer>
                    <Badge>{e.status}</Badge>
                    <span>
                      {dateLabel(e.date_of_joining, {
                        month: 'short',
                        year: 'numeric',
                      })}
                    </span>
                  </footer>
                </a>
              ))}
            </div>
          )
        ) : (
          <Empty
            title={
              search || department || status
                ? 'No people match these filters'
                : 'Meet your future team'
            }
            text={
              search || department || status
                ? 'Try another name or clear a filter.'
                : 'Add your first employee to bring your workspace to life.'
            }
            action={
              search || department || status ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setSearch('')
                    setDepartment('')
                    setStatus('')
                  }}
                >
                  Clear filters
                </Button>
              ) : data.permissions.includes('employee.write') &&
                data.user.scope === 'all' ? (
                <Button onClick={add}>
                  <Plus size={17} />
                  Add employee
                </Button>
              ) : undefined
            }
          />
        )}
        <footer className="table-footer">
          <span>
            {rows.length
              ? `${(current - 1) * 12 + 1}–${Math.min(current * 12, rows.length)} of ${rows.length} people`
              : '0 people'}
          </span>
          <div>
            <Button
              variant="secondary"
              disabled={current === 1}
              onClick={() => setPage(current - 1)}
            >
              Previous
            </Button>
            <span>
              {current} / {pages}
            </span>
            <Button
              variant="secondary"
              disabled={current === pages}
              onClick={() => setPage(current + 1)}
            >
              Next
            </Button>
          </div>
        </footer>
      </Card>
    </>
  )
}
export function EmployeeProfile({
  id,
  data,
  open,
  revision,
}: {
  id: string
  data: Workspace
  open: (s: FormSpec) => void
  revision: number
}) {
  const [profile, setProfile] = useState<Profile | null>(null),
    [error, setError] = useState(''),
    [tab, setTab] = useState('Overview')
  useEffect(() => {
    let cancelled = false
    setProfile(null)
    setError('')
    api<Profile>(`/employees/${id}`)
      .then((d) => {
        if (!cancelled) setProfile(d)
      })
      .catch((e) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [id, revision])
  if (error) return <ErrorBox message={error} />
  if (!profile) return <Skeleton />
  const e = profile.employee,
    current = profile.assignments.find(
      (a) =>
        !a.superseded_at &&
        a.effective_from <= data.today &&
        (!a.effective_to || a.effective_to > data.today),
    )
  const tabs = [
    'Overview',
    'Employment',
    ...(data.permissions.includes('compensation.read') ? ['Compensation'] : []),
    'Timeline',
  ]
  return (
    <>
      <a className="back-link" href="#/people">
        <ArrowLeft size={17} />
        Back to people
      </a>
      <Card className="profile-hero">
        <div className="profile-cover" />
        <div className="profile-header">
          <Avatar name={fullName(e)} size="large" />
          <div>
            <h1>{fullName(e)}</h1>
            <p>
              {current?.designation ?? 'Team member'}
              <span> · </span>
              {current?.department ?? 'Unassigned'}
            </p>
            <small>{e.employee_number}</small>
          </div>
          <Badge>{e.status}</Badge>
          {data.permissions.includes('employee.write') && (
            <Button
              variant="secondary"
              onClick={() =>
                open({
                  title: 'Record an employment change',
                  description:
                    'This creates a new effective-dated assignment and preserves the employee’s history.',
                  path: `/employees/${id}/assignments`,
                  fields: [
                    {
                      name: 'department',
                      label: 'Department',
                      value: current?.department,
                    },
                    {
                      name: 'designation',
                      label: 'Job title',
                      value: current?.designation,
                    },
                    {
                      name: 'effectiveFrom',
                      label: 'Effective from',
                      type: 'date',
                      value: data.today,
                    },
                    {
                      name: 'reason',
                      label: 'Reason for change',
                      type: 'textarea',
                    },
                  ],
                })
              }
            >
              <BriefcaseBusiness size={17} />
              Change assignment
            </Button>
          )}
        </div>
        <Tabs value={tab} onChange={setTab} items={tabs} />
      </Card>
      {tab === 'Overview' ? (
        <div className="two-column">
          <Card title="At a glance">
            <dl className="details">
              <div>
                <dt>Full name</dt>
                <dd>{fullName(e)}</dd>
              </div>
              <div>
                <dt>Employee number</dt>
                <dd>{e.employee_number}</dd>
              </div>
              <div>
                <dt>Joining date</dt>
                <dd>{dateLabel(e.date_of_joining)}</dd>
              </div>
              <div>
                <dt>Employment status</dt>
                <dd>
                  <Badge>{e.status}</Badge>
                </dd>
              </div>
            </dl>
          </Card>
          <Card title="Their place in the team">
            <dl className="details">
              <div>
                <dt>Department</dt>
                <dd>{current?.department ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt>Job title</dt>
                <dd>{current?.designation ?? 'Unassigned'}</dd>
              </div>
              <div>
                <dt>Assignment effective from</dt>
                <dd>{dateLabel(current?.effective_from)}</dd>
              </div>
              <div>
                <dt>People operations</dt>
                <dd>Employment changes are recorded with history.</dd>
              </div>
            </dl>
          </Card>
        </div>
      ) : tab === 'Compensation' ? (
        <Card title="Compensation history">
          {profile.compensation.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Effective from</th>
                    <th>Annual CTC</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {profile.compensation.map((c) => (
                    <tr key={c.id}>
                      <td>{dateLabel(c.effective_from)}</td>
                      <td>{money(c.annual_ctc_paise)}</td>
                      <td>{c.change_reason ?? 'Initial compensation'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No compensation recorded"
              text="Compensation records will appear here once configured."
            />
          )}
        </Card>
      ) : (
        <Card
          title={
            tab === 'Timeline' ? 'Every chapter, kept' : 'Employment history'
          }
        >
          <div className="timeline">
            {profile.assignments.map((a) => (
              <article key={a.id}>
                <span className="timeline-dot" />
                <time>{dateLabel(a.effective_from)}</time>
                <h3>{a.designation}</h3>
                <p>{a.department}</p>
                <small>
                  {a.change_reason ?? 'Employment assignment'}
                  {a.superseded_at ? ' · Superseded record' : ''}
                </small>
              </article>
            ))}
          </div>
        </Card>
      )}
    </>
  )
}
