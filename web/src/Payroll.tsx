import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  FileText,
  LockKeyhole,
  Plus,
  ShieldCheck,
  Users,
  Wallet,
  Send,
} from 'lucide-react'
import { api, dateLabel, exportCsv, fullName, money, pretty } from './api'
import type { Workspace } from './types'
import type { FormSpec } from './forms'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  ErrorBox,
  PageHeader,
  Stat,
  Tabs,
} from './ui'
import { PayrollInputs } from './PayrollInputs'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import { Filings } from './Filings'
import { ChecksTab } from './pay/Checks'
import { JournalTab } from './pay/Journal'
import { CompliancePage } from './pay/Compliance'
import { ContractorsPage } from './pay/Contractors'
import { BonusPage } from './pay/Bonus'
import { PaymentStatusStrip } from './pay/Reconcile'
import { PayslipDetails } from './PayslipDetails'
import { LoansPanel } from './LoansPanel'
interface FrozenInput {
  employee_id: string
  first_name: string
  last_name: string
  calendar_days: string
  payable_days: string
  lop_days: string
  monthly_components: Record<string, number>
  state_code: string
}
type ValidationIssue = { employeeId?: string; code?: string; message: string; severity?: string }
type ValidationResult = { blockers: ValidationIssue[]; warnings: ValidationIssue[] }
type DeltaRow = { employee_id: string; component_code: string; old_amount: string; new_amount: string; delta_paise: string }
export function PayrollPage({
  data,
  open,
  refresh,
  screen = 'runs',
}: {
  data: Workspace
  open: (s: FormSpec) => void
  refresh: () => Promise<void>
  screen?: string
}) {
  const PAY_VIEWS: Array<[string, string, boolean]> = [
    ['runs', 'Runs', true],
    ['compliance', 'Compliance', data.permissions.includes('compliance.read')],
    ['contractors', 'Contractors', data.permissions.includes('contractor.read')],
    ['bonus', 'Bonus', data.permissions.includes('payroll.process')],
  ]
  const payShown = PAY_VIEWS.filter((v) => v[2])
  const payTabs = (
    <Tabs value={payShown.find((v) => v[0] === screen)?.[1] ?? 'Runs'} items={payShown.map((v) => v[1])}
      onChange={(label) => { const v = payShown.find((x) => x[1] === label); window.location.hash = `#/payroll${v && v[0] !== 'runs' ? `/${v[0]}` : ''}` }} />
  )
  const [selected, setSelected] = useState(() => location.hash.replace(/^#\/?/, '').split('/')[1] ?? ''),
    [tab, setTab] = useState('Register'),
    [editing, setEditing] = useState(false),
    [inputs, setInputs] = useState<FrozenInput[]>([]),
    [error, setError] = useState(''),
    [downloading, setDownloading] = useState(''),
    [breakdown, setBreakdown] = useState(''),
    [sentRuns, setSentRuns] = useState<Set<string>>(() => new Set()),
    [distribution, setDistribution] = useState(''),
    [validation, setValidation] = useState<ValidationResult | null>(null),
    [delta, setDelta] = useState<DeltaRow[]>([])
  const run = data.payroll.find((p) => p.id === selected) ?? data.payroll[0],
    steps = ['Freeze', 'Calculate', 'Validate', 'Approve', 'Lock', 'Sent'],
    statusIndex: Record<string, number> = { draft: 0, inputs_frozen: 1, calculated: 2, validated: 3, approved: 4, locked: 5 },
    index = run ? ((sentRuns.has(run.id) || (data.payslips.some(slip => slip.run_id === run.id) && data.payslips.filter(slip => slip.run_id === run.id).every(slip => slip.distributed_at))) ? 6 : statusIndex[run.status] ?? 0) : -1
  const slips = data.payslips.filter((s) => !run || s.run_id === run.id),
    has = (p: string) => data.permissions.includes(p)
  const ytdGross = slips.reduce((total, slip) => total + BigInt(slip.gross_paise), 0n)
  const ytdNet = slips.reduce((total, slip) => total + BigInt(slip.net_paise), 0n)
  const requiresSeparate = data.settings.find(setting => setting.key === 'payroll.require_separate_approver')?.value !== false
  const separationBlocked = Boolean(run && requiresSeparate && run.processed_by_user_id === data.user.id)
  useEffect(() => {
    let cancel = false
    if (run && tab === 'Frozen inputs') {
      setInputs([])
      setError('')
      api<FrozenInput[]>(`/payroll/${run.id}/inputs`)
        .then((d) => {
          if (!cancel) setInputs(d)
        })
        .catch((e) => {
          if (!cancel) setError(e.message)
        })
    }
    return () => {
      cancel = true
    }
  }, [run?.id, run?.status, tab])
  useEffect(() => {
    let cancelled = false
    setDelta([])
    if (!run || run.revision <= 1) return
    domainApi<{ delta: DeltaRow[] }>(`/payroll/runs/${run.id}/delta`).then(result => { if (!cancelled) setDelta(result.delta) }).catch(caught => { if (!cancelled) setError(caught instanceof Error ? caught.message : 'Unable to load revision changes') })
    return () => { cancelled = true }
  }, [run?.id, run?.revision])
  async function downloadPayslip(id: string) {
    setDownloading(id); setError('')
    try {
      const pdf = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/payslips/${id}/pdf`)
      downloadFile(pdf.fileName, pdf.contentType, decodeBase64(pdf.contentBase64))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to download payslip') }
    finally { setDownloading('') }
  }
  async function distribute() {
    if (!run) return
    setDownloading(run.id); setError('')
    try {
      const result = await domainApi<{ sent: number; skipped: unknown[]; failed: unknown[] }>(`/payroll/runs/${run.id}/distribute`, {})
      setSentRuns(current => new Set(current).add(run.id)); setDistribution(`${result.sent} payslips sent${result.failed.length ? ` · ${result.failed.length} failed` : ''}${result.skipped.length ? ` · ${result.skipped.length} already sent` : ''}.`)
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to send payslips') } finally { setDownloading('') }
  }
  async function validateRun() {
    if (!run) return
    setDownloading(run.id); setError(''); setValidation(null)
    try {
      const result = await domainApi<ValidationResult>(`/payroll/runs/${run.id}/validation`)
      setValidation(result)
      await refresh()
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to validate payroll') } finally { setDownloading('') }
  }
  const action =
    run?.status === 'inputs_frozen' && has('payroll.process')
      ? 'calculate'
      : run?.status === 'calculated' && has('payroll.process')
        ? 'validate'
        : run?.status === 'validated' && has('payroll.approve')
          ? 'approve'
          : run?.status === 'approved' && has('payroll.lock')
            ? 'lock'
            : run?.status === 'locked' && has('payroll.revise')
              ? 'revise'
              : null
  function actionForm(action: string) {
    if (!run) return
    open({
      title:
        action === 'lock'
          ? 'Lock this payroll run?'
          : action === 'revise'
            ? 'Start a payroll revision'
            : `${pretty(action)} payroll`,
      description:
        action === 'lock'
          ? `Lock ${run.label} for ${run.employee_count ?? 0} employees with a net payout of ${money(run.net_paise)}. Locked payroll cannot be edited; later changes require a revision.`
          : action === 'revise'
            ? 'Create a new draft linked to this locked run. Record why a revision is needed.'
            : action === 'calculate'
              ? 'Calculate this run using its frozen employee inputs and configuration. The next step checks for blockers and warnings.'
              : action === 'validate'
                ? 'Check this run for blockers and warnings. If warnings are returned, review them before acknowledging and continuing.'
                : action === 'unfreeze'
                  ? 'Return this run to draft and remove its frozen inputs. You can review and freeze a new set before calculating.'
                  : `Approve ${run.label} with a net payout of ${money(run.net_paise)}. The person who processed this run cannot approve it when separation of duties is enabled.`,
      path: `/payroll/${run.id}/actions`,
      submit: `${pretty(action)} payroll`,
      fields:
        action === 'revise'
          ? [{ name: 'reason', label: 'Reason for revision', type: 'textarea' }]
          : action === 'validate'
            ? [
                {
                  name: 'acknowledgeWarnings',
                  label: 'Warning review',
                  value: 'false',
                  options: [
                    { value: 'false', label: 'Check for warnings first' },
                    {
                      value: 'true',
                      label: 'I have reviewed the returned warnings',
                    },
                  ],
                },
              ]
            : [],
      transform: (v) => ({
        ...v,
        action,
        acknowledgeWarnings: v.acknowledgeWarnings === 'true',
      }),
    })
  }
  if (screen === 'compliance') return <><PageHeader title="Compliance calendar" description="What this company owes the state, when, and whether it was filed on time." eyebrow="Pay · Compliance" />{payTabs}<CompliancePage data={data} /></>
  if (screen === 'contractors') return <><PageHeader title="Contractors" description="People paid on invoice — outside the payroll run, with TDS deducted per invoice." eyebrow="Pay · Contractors" />{payTabs}<ContractorsPage data={data} /></>
  if (screen === 'bonus') return <><PageHeader title="Statutory bonus" description="Payment of Bonus Act arithmetic, before any money moves." eyebrow="Pay · Bonus" />{payTabs}<BonusPage data={data} /></>
  return (
    <>
      <PageHeader
        title={data.user.scope === 'self' ? 'My pay' : 'Payroll, with peace of mind'}
        description={data.user.scope === 'self' ? 'Payslips, tax and everything that makes up your pay.' : 'A clear cycle. Every number accounted for.'}
        eyebrow="Compensation & payroll"
      >
        <Button
          variant="secondary"
          disabled={!slips.length}
          onClick={() =>
            exportCsv(
              'payroll-register',
              slips.map((s) => ({
                Employee: fullName(s),
                Period: s.label,
                'Gross (INR)': money(s.gross_paise),
                'Deductions (INR)': money(s.deductions_paise),
                'Net pay (INR)': money(s.net_paise),
              })),
            )
          }
        >
          <ArrowDownToLine size={17} />
          Export register
        </Button>
        {has('payroll.process') && data.user.scope === 'all' && (
          <Button
            onClick={() =>
              open({
                title: 'Start a payroll run',
                description:
                  'Choose a configured payroll period. You’ll review and freeze the inputs before calculation.',
                path: '/payroll/runs',
                submit: 'Create draft run',
                fields: [
                  {
                    name: 'periodId',
                    label: 'Payroll period',
                    options: data.periods.map((p) => ({
                      value: p.id,
                      label: p.label,
                    })),
                  },
                ],
              })
            }
          >
            <Plus size={17} />
            New run
          </Button>
        )}
      </PageHeader>
      {data.user.scope === 'self' && <><div className="my-pay-links"><a href="#/my-tax">Tax declaration</a><a href="#/documents">Form 16 & tax documents</a>{data.user.employeeId && <a href={`#/people/${data.user.employeeId}`}>Employment profile</a>}</div><div className="stats-row"><Stat label="YTD gross" value={money(String(ytdGross))} note={`${slips.length} published payslip${slips.length === 1 ? '' : 's'}`} icon={<Wallet size={20} />} variant="mint-card" /><Stat label="YTD take-home" value={money(String(ytdNet))} note="After deductions" icon={<ShieldCheck size={20} />} /></div></>}
      {data.user.scope === 'all' && data.payroll.length > 0 && <Card title="Payroll runs" subtitle="Select a cycle to open its workbench"><div className="table-scroll"><table><thead><tr><th>Period</th><th>Status</th><th>Employees</th><th>Gross</th><th>Net</th><th>Processed by</th></tr></thead><tbody>{data.payroll.map(item => <tr key={item.id} className={item.id === run?.id ? 'selected-row' : ''} onClick={() => setSelected(item.id)}><td><button className="table-link" onClick={() => setSelected(item.id)}>{item.label} · R{item.revision}</button></td><td><Badge>{item.status}</Badge></td><td>{item.employee_count ?? '—'}</td><td>{money(item.gross_paise)}</td><td>{money(item.net_paise)}</td><td>{fullName(data.employees.find(employee => employee.user_id === item.processed_by_user_id) ?? { first_name: 'Payroll', last_name: 'processor' })}</td></tr>)}</tbody></table></div></Card>}
      {run ? (
        <>
          <div className="payroll-cycle">
            <div>
              <span className="eyebrow">Current selection</span>
              <h2>
                {dateLabel(run.period_start, {
                  month: 'long',
                  year: 'numeric',
                })}
                <Badge>{run.status}</Badge>
              </h2>
              <p>
                Pay date {dateLabel(run.pay_date)} · Revision {run.revision}
              </p>
            </div>
            <select
              aria-label="Payroll cycle"
              value={run.id}
              onChange={(e) => {
                setSelected(e.target.value)
                setTab('Register')
              }}
            >
              {data.payroll.map((p) => (
                <option value={p.id} key={p.id}>
                  {p.label} · Revision {p.revision} · {pretty(p.status)}
                </option>
              ))}
            </select>
            {run.status === 'draft' &&
              has('payroll.process') &&
              has('compensation.read') && (
                <Button onClick={() => setEditing(true)}>
                  <ShieldCheck size={17} />
                  Review inputs
                </Button>
              )}
            {run.status === 'inputs_frozen' && has('payroll.process') && (
              <Button
                variant="secondary"
                onClick={() => actionForm('unfreeze')}
              >
                Unfreeze
              </Button>
            )}
            {action && (
              <Button disabled={downloading === run.id || (separationBlocked && ['approve', 'lock'].includes(action))} title={separationBlocked && ['approve', 'lock'].includes(action) ? 'Another approver must do this' : undefined} onClick={() => action === 'validate' ? void validateRun() : actionForm(action)}>
                <LockKeyhole size={17} />
                {separationBlocked && ['approve', 'lock'].includes(action) ? 'Another approver must do this' : `${pretty(action)} payroll`}
              </Button>
            )}
            {run.status === 'locked' && has('payroll.process') && <Button disabled={downloading === run.id || sentRuns.has(run.id)} onClick={() => void distribute()}><Send size={16} />{sentRuns.has(run.id) ? 'Payslips sent' : 'Send payslips now'}</Button>}
          </div>
          <Card className="payroll-stepper">
            {steps.map((s, i) => (
              <div
                key={s}
                className={
                  i < index ? 'complete' : i === index ? 'current' : ''
                }
              >
                <span>{i < index ? <Check size={17} /> : i + 1}</span>
                <strong>{s}</strong>
                {i < steps.length - 1 && <ChevronRight size={16} />}
              </div>
            ))}
          </Card>
          {separationBlocked && ['validated', 'approved'].includes(run.status) && <p className="freeze-note">Separation of duty is active. Another approver must complete the next decision.</p>}
          {distribution && <p className="success-note" role="status">{distribution}</p>}
          {validation && <Card className="validation-results" title="Validation results" subtitle={validation.blockers.length ? 'Resolve every blocker before approval' : 'This run is ready for approval'}><div className="validation-summary"><span className={validation.blockers.length ? 'danger' : 'success'}>{validation.blockers.length} blockers</span><span>{validation.warnings.length} warnings</span></div>{[...validation.blockers, ...validation.warnings].length ? <ul>{[...validation.blockers, ...validation.warnings].map((issue, issueIndex) => <li key={`${issue.code ?? 'validation'}-${issue.employeeId ?? issueIndex}`} className={validation.blockers.includes(issue) ? 'danger' : ''}><strong>{issue.code ? pretty(issue.code) : validation.blockers.includes(issue) ? 'Blocker' : 'Warning'}</strong><span>{issue.message}</span></li>)}</ul> : <p className="success-note">No blockers or warnings found.</p>}</Card>}
          <div className="stats-row">
            <Stat
              label="Employees in this run"
              value={run.employee_count ?? '—'}
              note="Frozen employee count"
              icon={<Users size={20} />}
            />
            <Stat
              label="Gross pay"
              value={money(run.gross_paise)}
              note="Calculated earnings"
              icon={<Wallet size={20} />}
              variant="mint-card"
            />
            <Stat
              label="Deductions"
              value={money(run.deductions_paise)}
              note="Calculated deductions"
              icon={<FileText size={20} />}
              variant="sand-card"
            />
            <Stat
              label="Net pay"
              value={money(run.net_paise)}
              note="Total calculated payout"
              icon={<ShieldCheck size={20} />}
              variant="coral-card"
            />
          </div>
          <Tabs
            value={tab}
            onChange={setTab}
            items={['Register', 'Frozen inputs', 'Checks', 'Journal']}
          />
        </>
      ) : null}
      {data.user.scope === 'all' && payShown.length > 1 && payTabs}
      {error && <ErrorBox message={error} />}
      <Card
        title={
          tab === 'Frozen inputs'
            ? 'The inputs behind the numbers'
            : data.user.scope === 'all'
              ? 'Payroll register'
              : 'Your payslips'
        }
        subtitle={
          run
            ? `${run.label} · Revision ${run.revision}`
            : 'Published payroll records'
        }
      >
        {tab === 'Checks' && run ? (
          <ChecksTab runId={run.id} data={data} onChanged={refresh} />
        ) : tab === 'Journal' && run ? (
          <JournalTab runId={run.id} locked={run.status === 'locked'} data={data} />
        ) : tab === 'Frozen inputs' ? (
          inputs.length ? (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Calendar days</th>
                    <th>Payable days</th>
                    <th>Loss of pay</th>
                    <th>State</th>
                    <th>Monthly components</th>
                  </tr>
                </thead>
                <tbody>
                  {inputs.map((i) => (
                    <tr key={i.employee_id}>
                      <td>{fullName(i)}</td>
                      <td>{i.calendar_days}</td>
                      <td>{i.payable_days}</td>
                      <td>{i.lop_days}</td>
                      <td>{i.state_code}</td>
                      <td>
                        {Object.entries(i.monthly_components).map(([k, v]) => (
                          <small className="inline-note" key={k}>
                            {pretty(k)}: {money(String(v))}
                          </small>
                        ))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No inputs frozen yet"
              text="Review the employee inputs and freeze them to begin calculation."
            />
          )
        ) : slips.length ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Period</th>
                  <th>Gross pay</th>
                  <th>Deductions</th>
                    <th>Net pay</th>
                    <th>Delivery</th>
                    <th><span className="sr-only">Download</span></th>
                </tr>
              </thead>
              <tbody>
                {slips.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <span className="person-line">
                        <Avatar name={fullName(s)} />
                        <strong>{fullName(s)}</strong>
                      </span>
                    </td>
                    <td>{s.label}</td>
                    <td>{money(s.gross_paise)}</td>
                    <td>{money(s.deductions_paise)}</td>
                    <td className="net-pay">{money(s.net_paise)}</td>
                    <td>{s.distributed_at ? <span className="acknowledged"><Check size={14} />Sent</span> : <span className="inline-note">Pending</span>}</td>
                    <td><Button variant="ghost" onClick={() => setBreakdown(s.id)}>Details</Button><Button variant="ghost" disabled={downloading === s.id} onClick={() => void downloadPayslip(s.id)}><ArrowDownToLine size={16} />{downloading === s.id ? 'Preparing…' : 'PDF'}</Button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty
            title="No payroll records yet"
            text="The register appears after calculation. Employees see only their published payslips."
          />
        )}
      </Card>
      {run && run.revision > 1 && <Card title="Changes from the previous revision" subtitle="Only changed payroll components are shown">{delta.length ? <div className="table-scroll"><table><thead><tr><th>Employee</th><th>Component</th><th>Previous</th><th>Revised</th><th>Change</th></tr></thead><tbody>{delta.map(row => <tr key={`${row.employee_id}-${row.component_code}`}><td>{fullName(data.employees.find(employee => employee.id === row.employee_id) ?? { first_name: 'Employee', last_name: row.employee_id.slice(0, 6) })}</td><td>{pretty(row.component_code)}</td><td>{money(row.old_amount)}</td><td>{money(row.new_amount)}</td><td className={BigInt(row.delta_paise) < 0n ? 'delta-negative' : 'delta-positive'}>{BigInt(row.delta_paise) > 0n ? '+' : ''}{money(row.delta_paise)}</td></tr>)}</tbody></table></div> : <Empty title="No component changes" text="This revision currently matches the previous run." />}</Card>}
      {run && run.status === 'locked' && has('bank.read') && <PaymentStatusStrip runId={run.id} canReconcile={has('bank.export')} />}
      {run && has('payroll.process') && <Filings key={run.id} run={run} data={data} />}
      {data.user.scope === 'self' && data.user.employeeId && <LoansPanel id={data.user.employeeId} data={data} />}
      {breakdown && <PayslipDetails id={breakdown} onClose={() => setBreakdown('')} />}
      {editing && run && (
        <PayrollInputs
          id={run.id}
          onClose={() => setEditing(false)}
          onSaved={refresh}
        />
      )}
    </>
  )
}
