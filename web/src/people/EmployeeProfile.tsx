import type { FormSpec } from '../forms'
import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  BriefcaseBusiness,
} from 'lucide-react'
import { api, fullName, dateLabel, money } from '../api'
import type { Workspace, Profile } from '../types'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  Skeleton,
  Tabs,
} from '../ui'

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
