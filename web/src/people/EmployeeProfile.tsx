import type { FormSpec } from '../forms'
import { useState, useEffect } from 'react'
import {
  ArrowLeft,
  ArrowLeftRight,
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
import { DocumentsPanel } from '../DataTools'
import { CompensationForm } from '../CompensationForm'
import { LoansPanel } from '../LoansPanel'
import { ExitPanel, PrivacyPanel, StatutoryIds } from '../EmployeeLifecycle'
import { EmployeeSites } from '../GeofenceSites'

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
    [tab, setTab] = useState('Overview'),
    [localRevision, setLocalRevision] = useState(0)
  const [compensationForm, setCompensationForm] = useState(false)
  useEffect(() => {
    let cancelled = false
    setProfile(previous => previous?.employee.id === id ? previous : null)
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
  }, [id, revision, localRevision])
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
    'Exit',
    'Privacy',
    ...(data.permissions.includes('payroll.read') ? ['Private payroll'] : []),
    ...(data.permissions.includes('compensation.read') ? ['Compensation'] : []),
    ...(data.permissions.includes('payroll.read') && data.modules.payroll ? ['Loans'] : []),
    'Timeline',
    ...(data.permissions.includes('attendance.read') && data.modules.attendance ? ['Attendance'] : []),
    ...(data.permissions.includes('document.read') && data.modules.documents ? ['Documents'] : []),
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
          {data.permissions.includes('employee.write') && (
            <Button
              variant="secondary"
              onClick={() =>
                open({
                  title: 'Transfer',
                  description: 'A transfer goes through approval and is applied on the effective date. Leave a field blank to keep it.',
                  path: '/transfers',
                  domain: true,
                  success: 'Transfer requested; it shows as pending until approved.',
                  fields: [
                    { name: 'employeeId', label: 'Employee', value: id, options: [{ value: id, label: fullName(e) }] },
                    { name: 'effectiveFrom', label: 'Effective from', type: 'date', value: data.today },
                    { name: 'department', label: 'New department', required: false, value: '' },
                    { name: 'designation', label: 'New designation', required: false, value: '' },
                    { name: 'locationCode', label: 'New location code', required: false, value: '' },
                    { name: 'managerEmployeeId', label: 'New manager', required: false, options: [{ value: '', label: 'Keep current' }, ...data.employees.filter((m) => m.id !== id).map((m) => ({ value: m.id, label: fullName(m) }))] },
                    { name: 'reason', label: 'Reason', type: 'textarea' },
                  ],
                  transform: (v) => Object.fromEntries(Object.entries(v).filter(([, val]) => val !== '')),
                })
              }
            >
              <ArrowLeftRight size={17} />
              Transfer
            </Button>
          )}
          {data.user.employeeId === id && (
            <Button
              variant="ghost"
              onClick={() =>
                open({
                  title: 'Request a change to my profile',
                  description: 'Locked fields change only through HR. Say what should change and attach evidence in Documents first if you have it.',
                  path: '/profile-changes',
                  domain: true,
                  success: 'Sent to HR; you will hear back in your inbox.',
                  fields: [
                    { name: 'lastName', label: 'Last name', required: false, value: '' },
                    { name: 'dateOfBirth', label: 'Date of birth', type: 'date', required: false, value: '' },
                    { name: 'personalEmail', label: 'Personal email', required: false, value: '' },
                    { name: 'phone', label: 'Phone', required: false, value: '' },
                    { name: 'address', label: 'Address', required: false, value: '' },
                    { name: 'note', label: 'Why (and where the evidence is)', type: 'textarea' },
                  ],
                  transform: (v) => ({ note: v.note, changes: Object.fromEntries(Object.entries(v).filter(([k, val]) => k !== 'note' && val !== '')) }),
                })
              }
            >
              Request a change
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
      ) : tab === 'Exit' ? (
        <ExitPanel key={id} employee={e} data={data} onChanged={() => setLocalRevision(value => value + 1)} />
      ) : tab === 'Privacy' ? (
        <PrivacyPanel key={id} employee={e} data={data} onChanged={() => setLocalRevision(value => value + 1)} />
      ) : tab === 'Private payroll' ? (
        <StatutoryIds key={id} id={id} canWrite={data.permissions.includes('compensation.write')} />
      ) : tab === 'Compensation' ? (
        <Card title="Compensation history">
          {data.permissions.includes('compensation.write') && <div className="header-actions"><Button onClick={() => setCompensationForm(true)}>Record salary revision</Button></div>}
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
      ) : tab === 'Loans' ? (
        <LoansPanel key={id} id={id} data={data} />
      ) : tab === 'Attendance' ? (
        <EmployeeSites key={id} id={id} data={data} />
      ) : tab === 'Documents' ? (
        <DocumentsPanel ownerType="employee" ownerId={id} canWrite={data.permissions.includes('document.write')} selfScope={data.user.scope === 'self'} maxUploadMb={Number(data.settings.find(setting => setting.key === 'documents.max_upload_mb')?.value ?? 10)} />
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
      {compensationForm && <CompensationForm key={id} id={id} data={data} onClose={() => setCompensationForm(false)} onChanged={() => setLocalRevision(value => value + 1)} />}
    </>
  )
}
