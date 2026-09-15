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
import { PayslipDetails } from './PayslipDetails'
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
export function PayrollPage({
  data,
  open,
  refresh,
}: {
  data: Workspace
  open: (s: FormSpec) => void
  refresh: () => Promise<void>
}) {
  const [selected, setSelected] = useState(() => location.hash.replace(/^#\/?/, '').split('/')[1] ?? ''),
    [tab, setTab] = useState('Register'),
    [editing, setEditing] = useState(false),
    [inputs, setInputs] = useState<FrozenInput[]>([]),
    [error, setError] = useState(''),
    [downloading, setDownloading] = useState(''),
    [breakdown, setBreakdown] = useState('')
  const run = data.payroll.find((p) => p.id === selected) ?? data.payroll[0],
    steps = [
      'draft',
      'inputs_frozen',
      'calculated',
      'validated',
      'approved',
      'locked',
    ],
    index = run ? steps.indexOf(run.status) : -1
  const slips = data.payslips.filter((s) => !run || s.run_id === run.id),
    has = (p: string) => data.permissions.includes(p)
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
  async function downloadPayslip(id: string) {
    setDownloading(id); setError('')
    try {
      const pdf = await domainApi<{ fileName: string; contentType: string; contentBase64: string }>(`/payslips/${id}/pdf`)
      downloadFile(pdf.fileName, pdf.contentType, decodeBase64(pdf.contentBase64))
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to download payslip') }
    finally { setDownloading('') }
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
  return (
    <>
      <PageHeader
        title="Payroll, with peace of mind"
        description="A clear cycle. Every number accounted for."
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
              <Button onClick={() => actionForm(action)}>
                <LockKeyhole size={17} />
                {pretty(action)} payroll
              </Button>
            )}
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
                <strong>{pretty(s)}</strong>
                {i < steps.length - 1 && <ChevronRight size={16} />}
              </div>
            ))}
          </Card>
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
            items={['Register', 'Frozen inputs']}
          />
        </>
      ) : null}
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
        {tab === 'Frozen inputs' ? (
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
      {run && has('payroll.process') && <Filings key={run.id} run={run} data={data} />}
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
