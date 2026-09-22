/**
 * Plan & modules.
 *
 * PEPL is sold by people, in a room, so this screen is built to be shown: the
 * company's current plan on the left, and the whole matrix beside it with the
 * modules this plan does NOT include called out rather than hidden. A
 * salesperson should be able to point at the gap and name the price of closing
 * it; an admin should be able to see what they are paying for without asking.
 *
 * Prices come from the same /plans endpoint that bills the customer, so the
 * figure on this screen can never drift from the figure on the invoice.
 */
import { useEffect, useState } from 'react'
import { BadgeCheck, Check, Minus, TriangleAlert } from 'lucide-react'
import { domainApi } from '../domainApi'
import { money, dateLabel } from '../api'
import { Card, ErrorBox, Skeleton } from '../ui'

interface Plan {
  code: string
  name: string
  base_price_paise: string
  per_employee_price_paise: string
  features: Record<string, boolean>
  limits: Record<string, number>
}
interface Billing {
  plan: Plan
  status: string
  trial_ends_on: string | null
  current_period_start: string
  current_period_end: string
  active_employees: number
  employee_limit: number | null
  estimate: { subtotal_paise: string; gst_paise: string; total_paise: string }
  outstanding: { count: number; total_paise: string; oldest_due_on: string | null }
}

/**
 * The order a demo walks the matrix in: what everyone gets, then what each tier
 * adds. Labels are the words a customer uses, not the entitlement keys.
 */
const MODULES: Array<[string, string]> = [
  ['payroll', 'Payroll, payslips and statutory filings'],
  ['expenses', 'Expense claims and reimbursement'],
  ['timesheets', 'Timesheets and project time'],
  ['recruitment', 'Recruitment and the hiring pipeline'],
  ['performance', 'Goals, reviews and appraisals'],
  ['assets', 'Asset register and issue/return'],
  ['learning', 'Courses, compliance training and records'],
  ['surveys', 'Surveys, feedback and eNPS'],
  ['helpdesk', 'Helpdesk and grievances'],
  ['chat', 'Internal chat'],
  ['mail', 'Shared mailboxes'],
  ['incentives', 'Incentives and variable pay'],
  ['integrations', 'API keys, webhooks and connectors'],
  ['branding', 'Your own branding and custom domain'],
]

const STATUS_LABEL: Record<string, string> = {
  trialing: 'On trial', active: 'Active', past_due: 'Payment overdue',
  suspended: 'Suspended', cancelled: 'Cancelled',
}

export function PlanAndModules() {
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [billing, setBilling] = useState<Billing | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void Promise.all([
      domainApi<{ plans: Plan[] }>('/plans'),
      domainApi<Billing>('/billing'),
    ]).then(([p, b]) => { setPlans(p.plans); setBilling(b) })
      .catch((e: Error) => setError(e.message))
  }, [])

  if (error) return <ErrorBox message={error} />
  if (!plans || !billing) return <Skeleton />

  // The trial carries every module, so showing it as a column implies a tier
  // that nobody can buy. It is the current plan's badge, not a option.
  const sellable = plans.filter((p) => p.code !== 'trial')
  const current = billing.plan
  const missing = MODULES.filter(([key]) => current.features[key] !== true)
  const perMonth = (p: Plan) =>
    `${money(p.base_price_paise)} + ${money(p.per_employee_price_paise)}/person`

  return (
    <div className="plan-screen">
      <div className="plan-summary">
        <Card className="plan-current">
          <span className="eyebrow"><BadgeCheck size={15} aria-hidden="true" /> Current plan</span>
          <h2>{current.name}</h2>
          <p className="plan-price">{perMonth(current)} <small>per month, before GST</small></p>
          <dl className="plan-facts">
            <div>
              <dt>Status</dt>
              <dd>{STATUS_LABEL[billing.status] ?? billing.status}
                {billing.trial_ends_on ? ` · ends ${dateLabel(billing.trial_ends_on)}` : ''}</dd>
            </div>
            <div>
              <dt>People</dt>
              <dd>{billing.active_employees}{billing.employee_limit === null ? '' : ` of ${billing.employee_limit}`}</dd>
            </div>
            <div>
              <dt>Billing period</dt>
              <dd>{dateLabel(billing.current_period_start)} – {dateLabel(billing.current_period_end)}</dd>
            </div>
            <div>
              <dt>Next invoice, at today&rsquo;s headcount</dt>
              <dd>{money(billing.estimate.total_paise)} <small>incl. GST</small></dd>
            </div>
          </dl>
          {billing.outstanding.count > 0 && (
            <p className="plan-outstanding" role="status">
              <TriangleAlert size={15} aria-hidden="true" />
              {billing.outstanding.count} unpaid invoice{billing.outstanding.count === 1 ? '' : 's'} ·{' '}
              {money(billing.outstanding.total_paise)}
              {billing.outstanding.oldest_due_on ? ` · oldest due ${dateLabel(billing.outstanding.oldest_due_on)}` : ''}
            </p>
          )}
        </Card>

        <Card className="plan-gap">
          <span className="eyebrow">Not included in {current.name}</span>
          {missing.length === 0 ? (
            <p className="subtle">Every module on the platform is included in this plan.</p>
          ) : (
            <>
              <ul className="plan-missing">
                {missing.map(([key, label]) => (
                  <li key={key}><Minus size={14} aria-hidden="true" /> {label}</li>
                ))}
              </ul>
              <p className="subtle">
                Changing plan is handled by your account manager — the modules switch on
                for everyone the moment the plan changes, with nothing to reinstall.
              </p>
            </>
          )}
        </Card>
      </div>

      <Card className="data-card plan-matrix-card">
        <div className="card-head">
          <h2>What each plan includes</h2>
          <p>Prices are per month before GST, and come from the same place the invoice does.</p>
        </div>
        <div className="table-scroll">
          <table className="plan-matrix">
            <thead>
              <tr>
                <th scope="col">Module</th>
                {sellable.map((p) => (
                  <th key={p.code} scope="col" className={p.code === current.code ? 'is-current' : undefined}>
                    {p.name}
                    {p.code === current.code && <span className="badge green"><span />current</span>}
                    <small>{perMonth(p)}</small>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {MODULES.map(([key, label]) => (
                <tr key={key}>
                  <th scope="row">{label}</th>
                  {sellable.map((p) => {
                    const included = p.features[key] === true
                    return (
                      <td key={p.code} className={p.code === current.code ? 'is-current' : undefined}>
                        {/* Never colour alone: the icon and the label carry it too. */}
                        {included
                          ? <span className="plan-yes"><Check size={16} aria-hidden="true" /><span className="sr-only">Included</span></span>
                          : <span className="plan-no"><Minus size={16} aria-hidden="true" /><span className="sr-only">Not included</span></span>}
                      </td>
                    )
                  })}
                </tr>
              ))}
              <tr>
                <th scope="row">People included</th>
                {sellable.map((p) => (
                  <td key={p.code} className={p.code === current.code ? 'is-current' : undefined}>
                    {p.limits.employees ?? '—'}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
