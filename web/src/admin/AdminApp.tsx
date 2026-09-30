import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import QRCode from 'qrcode'
import {
  AlertTriangle, ArrowLeft, BadgeIndianRupee, Ban, Building2, Check, ChevronRight,
  CircleDollarSign, Clipboard, Download, FileText, IndianRupee, LayoutDashboard,
  LogOut, Plus, RefreshCw, Search, ShieldCheck, Sparkles, Users, X,
} from 'lucide-react'
import { dateLabel, money, pretty } from '../api'
import { PLATFORM_TOKEN, PlatformApiError, platformApi } from './api'

type Operator = { id: string; email: string; full_name: string; status: string; mfa_enabled: boolean }
type Plan = { code: string; name: string; base_price_paise: string; per_employee_price_paise: string; features: Record<string, boolean>; limits: Record<string, number> }
type Tenant = {
  id: string; legal_name: string; display_name: string; status: string; is_sandbox: boolean
  plan_code: string | null; subscription_status: string | null; trial_ends_on: string | null
  employees: number; created_at: string
}
type Billing = {
  plan: Plan; status: string; trial_ends_on: string | null; current_period_start: string; current_period_end: string
  active_employees: number; employee_limit: number | null; billing_gstin: string | null; billing_address: string | null
  billing_email: string | null; billing_state_code: string | null
  estimate: { subtotal_paise: string; gst_paise: string; total_paise: string }
  outstanding: { count: number; total_paise: string; oldest_due_on: string | null }
}
type Invoice = {
  id: string; number: string; period_start: string; period_end: string; plan_code: string; employees: number
  subtotal_paise: string; gst_paise: string; total_paise: string; status: string; due_on: string
  paid_at: string | null; payment_reference: string | null
}
type CreditNote = { id: string; invoice_id: string; number: string; reason: string; total_paise: string; issued_on: string }
type CompanyDetailData = { tenant: Tenant; billing: Billing; invoices: Invoice[]; creditNotes: CreditNote[] }
type RevenueLine = { plan_code: string; status: string; tenants: number; employees: number; monthlyPaise: string }
type Staff = Operator & { last_login_at: string | null }
type Screen = 'companies' | 'company' | 'new' | 'revenue' | 'staff'
type AuthPhase = 'loading' | 'login' | 'verify' | 'enrol' | 'ready'


function Logo({ compact = false }: { compact?: boolean }) {
  return <div className="ops-logo"><span><ShieldCheck size={compact ? 21 : 25} /></span><div><strong>PEPL</strong>{!compact && <small>Operator console</small>}</div></div>
}

function Status({ value }: { value: string | null | undefined }) {
  const status = value ?? 'not set'
  return <span className={`ops-status ${status.toLowerCase().replaceAll('_', '-')}`}><i />{pretty(status)}</span>
}

function Empty({ icon, title, text }: { icon: ReactNode; title: string; text: string }) {
  return <div className="ops-empty"><span>{icon}</span><strong>{title}</strong><p>{text}</p></div>
}

function QrCanvas({ value }: { value: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (ref.current) void QRCode.toCanvas(ref.current, value, { width: 184, margin: 1, color: { dark: '#153f38', light: '#ffffff' } })
  }, [value])
  return <canvas ref={ref} aria-label="Authenticator setup QR code" />
}

function AuthScreen({ phase, setPhase, setOperator }: { phase: AuthPhase; setPhase: (value: AuthPhase) => void; setOperator: (value: Operator | null) => void }) {
  const [code, setCode] = useState('')
  const [enrol, setEnrol] = useState<{ secret: string; otpauth: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const beginEnrol = useCallback(async (token?: string) => {
    const result = await platformApi<{ secret: string; otpauth: string }>('/mfa/enrol', { method: 'POST', body: {}, token })
    setEnrol(result)
    setPhase('enrol')
  }, [setPhase])

  useEffect(() => {
    if (phase !== 'loading') return
    const token = sessionStorage.getItem(PLATFORM_TOKEN)
    if (!token) { setPhase('login'); return }
    void platformApi<{ user: Operator; mfaPending: boolean }>('/me', { token }).then(async result => {
      setOperator(result.user)
      if (!result.user.mfa_enabled) await beginEnrol(token)
      else setPhase(result.mfaPending ? 'verify' : 'ready')
    }).catch(() => { sessionStorage.removeItem(PLATFORM_TOKEN); setPhase('login') })
  }, [beginEnrol, phase, setOperator, setPhase])

  // One login window for the whole product. The console deliberately has no
  // password form of its own: a second place to type an operator credential is
  // a second place to get its handling wrong, and the shared form already
  // routes an operator here by which identity store held their address.
  useEffect(() => {
    if (phase === 'login') window.location.assign('/')
  }, [phase])


  const verify = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try {
      await platformApi('/mfa/verify', { method: 'POST', body: { code } })
      const result = await platformApi<{ user: Operator }>('/me')
      setOperator(result.user); setPhase('ready')
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to verify that code.') }
    finally { setBusy(false) }
  }

  if (phase === 'loading') return <div className="ops-auth-stage"><div className="ops-auth-card loading"><Logo /><span className="ops-spinner" /><p>Opening the protected console…</p></div></div>

  return <div className="ops-auth-stage">
    <div className="ops-auth-art">
      <Logo />
      <div><span className="ops-eyebrow">PEPL INTERNAL</span><h1>Run every account.<br />See no employee data.</h1><p>Company provisioning, subscription billing and revenue operations in one controlled workspace.</p></div>
      <footer><ShieldCheck size={18} /> Separate identity · mandatory second factor · eight-hour sessions</footer>
    </div>
    <section className="ops-auth-card">
      {phase === 'login' ? <>
        <div className="ops-auth-heading"><span><ShieldCheck /></span><div><small>STAFF ACCESS</small><h2>Sign in to continue</h2></div></div>
        <p className="ops-muted">PEPL has one sign-in page for everyone. Your operator account is recognised there and brings you straight back here.</p>
        <a className="ops-button primary" href="/">Go to sign in<ChevronRight size={17} /></a>
      </> : phase === 'enrol' ? <>
        <button className="ops-back" onClick={() => { sessionStorage.removeItem(PLATFORM_TOKEN); setPhase('login') }}><ArrowLeft size={16} /> Start again</button>
        <div className="ops-auth-heading"><span><ShieldCheck /></span><div><small>REQUIRED SETUP</small><h2>Add your second factor</h2></div></div>
        <p className="ops-muted">Scan this code with an authenticator app. The console stays closed until a current code verifies the setup.</p>
        {enrol ? <div className="ops-enrol"><QrCanvas value={enrol.otpauth} /><div><small>CAN'T SCAN?</small><code>{enrol.secret}</code><button type="button" onClick={() => void navigator.clipboard.writeText(enrol.secret)}><Clipboard size={14} /> Copy secret</button></div></div> : <span className="ops-spinner" />}
        <form onSubmit={verify} className="ops-form code-form"><label>6-digit authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required autoFocus /></label>{error && <div className="ops-error" role="alert"><AlertTriangle size={17} />{error}</div>}<button className="ops-button primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify and open console'}</button></form>
      </> : <>
        <button className="ops-back" onClick={() => { sessionStorage.removeItem(PLATFORM_TOKEN); setPhase('login') }}><ArrowLeft size={16} /> Back to sign in</button>
        <div className="ops-auth-heading"><span><ShieldCheck /></span><div><small>SECOND FACTOR</small><h2>Verify it’s you</h2></div></div>
        <p className="ops-muted">Enter the current code from your authenticator. Password-only sessions cannot access company or billing data.</p>
        <form onSubmit={verify} className="ops-form code-form"><label>6-digit authenticator code<input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ''))} placeholder="000000" required autoFocus /></label>{error && <div className="ops-error" role="alert"><AlertTriangle size={17} />{error}</div>}<button className="ops-button primary" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Open operator console'}</button></form>
      </>}
    </section>
  </div>
}

function Companies({ onOpen, onNew, notify }: { onOpen: (tenant: Tenant) => void; onNew: () => void; notify: (message: string, kind?: 'good' | 'bad') => void }) {
  const [tenants, setTenants] = useState<Tenant[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try { setTenants((await platformApi<{ tenants: Tenant[] }>('/tenants')).tenants) }
    catch (caught) { notify(caught instanceof Error ? caught.message : 'Unable to load companies.', 'bad') }
    finally { setLoading(false) }
  }, [notify])
  useEffect(() => { void load() }, [load])
  const filtered = useMemo(() => tenants.filter(tenant => `${tenant.legal_name} ${tenant.display_name} ${tenant.plan_code}`.toLowerCase().includes(query.toLowerCase())), [query, tenants])
  const real = tenants.filter(tenant => !tenant.is_sandbox)
  const sandboxes = filtered.filter(tenant => tenant.is_sandbox)
  const companies = filtered.filter(tenant => !tenant.is_sandbox)
  const runBilling = async (path: string, label: string) => {
    try { const result = await platformApi<Record<string, number>>(path, { method: 'POST', body: {} }); notify(`${label}: ${Object.entries(result).map(([key, value]) => `${pretty(key)} ${value}`).join(' · ')}`, 'good'); await load() }
    catch (caught) { notify(caught instanceof Error ? caught.message : `${label} failed.`, 'bad') }
  }
  return <>
    <header className="ops-page-head"><div><span className="ops-eyebrow">CUSTOMER OPERATIONS</span><h1>Companies</h1><p>Plans, subscription health and headcount without access to employee records.</p></div><div><button className="ops-button ghost" onClick={() => void runBilling('/billing/dunning', 'Dunning complete')}><RefreshCw size={16} /> Run dunning</button><button className="ops-button primary" onClick={onNew}><Plus size={17} /> New company</button></div></header>
    <div className="ops-kpis">
      <article><span className="green"><Building2 /></span><small>Customer companies</small><strong>{real.length}</strong><p>Sandboxes excluded</p></article>
      <article><span className="mint"><Users /></span><small>People served</small><strong>{real.reduce((sum, tenant) => sum + tenant.employees, 0).toLocaleString('en-IN')}</strong><p>Headcount only</p></article>
      <article><span className="sand"><Sparkles /></span><small>Active trials</small><strong>{real.filter(tenant => tenant.subscription_status === 'trial').length}</strong><p>Conversion queue</p></article>
      <article className="coral"><span><AlertTriangle /></span><small>Needs attention</small><strong>{real.filter(tenant => ['past_due', 'suspended'].includes(tenant.subscription_status ?? '')).length}</strong><p>Past due or suspended</p></article>
    </div>
    <section className="ops-panel company-book">
      <div className="ops-panel-head"><div><h2>Company book</h2><p>{companies.length} customer account{companies.length === 1 ? '' : 's'}</p></div><div className="ops-search"><Search size={16} /><input aria-label="Search companies" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by company or plan…" /></div><button className="ops-icon-button" title="Close ended billing periods" onClick={() => void runBilling('/billing/close-periods', 'Billing periods closed')}><CircleDollarSign size={18} /></button></div>
      {loading ? <div className="ops-loading-list"><i /><i /><i /></div> : companies.length ? <div className="ops-table-wrap"><table><thead><tr><th>Company</th><th>Plan</th><th>Subscription</th><th>Headcount</th><th>Trial ends</th><th aria-label="Open" /></tr></thead><tbody>{companies.map(tenant => <tr key={tenant.id} onClick={() => onOpen(tenant)}><td><span className="ops-company-mark">{tenant.display_name.slice(0, 2).toUpperCase()}</span><div><strong>{tenant.display_name}</strong><small>{tenant.legal_name}</small></div></td><td><b>{pretty(tenant.plan_code ?? 'No plan')}</b></td><td><Status value={tenant.subscription_status ?? tenant.status} /></td><td>{tenant.employees.toLocaleString('en-IN')}</td><td>{dateLabel(tenant.trial_ends_on)}</td><td><button aria-label={`Open ${tenant.display_name}`}><ChevronRight size={18} /></button></td></tr>)}</tbody></table></div> : <Empty icon={<Building2 />} title="No matching companies" text="Adjust the search, or create the first customer account." />}
      {sandboxes.length > 0 && <div className="ops-sandboxes"><div><span><Sparkles size={16} /></span><div><strong>Sandboxes</strong><small>Invented data · excluded from revenue</small></div></div>{sandboxes.map(tenant => <button key={tenant.id} onClick={() => onOpen(tenant)}><span>{tenant.display_name}</span><b>{tenant.employees} people</b><ChevronRight size={16} /></button>)}</div>}
    </section>
  </>
}

function NewCompany({ plans, onBack, onCreated, notify }: { plans: Plan[]; onBack: () => void; onCreated: (id: string) => void; notify: (message: string, kind?: 'good' | 'bad') => void }) {
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState<{ tenantId: string; adminEmail: string; password: string; planCode: string } | null>(null)
  const [copied, setCopied] = useState(false)
  // Asked of the server, never hard-coded here: a list kept in two places drifted
  // until none of the five options on this form was a type the server accepted.
  const [presets, setPresets] = useState<Array<{ code: string; label: string; examples: string }>>([])
  const [presetCode, setPresetCode] = useState('')
  useEffect(() => { void platformApi<{ presets: Array<{ code: string; label: string; examples: string }> }>('/presets').then(result => setPresets(result.presets)).catch(caught => notify((caught as Error).message, 'bad')) }, [notify])
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true)
    const form = new FormData(event.currentTarget)
    try {
      setCreated(await platformApi('/tenants', { method: 'POST', body: { legalName: form.get('legalName'), displayName: form.get('displayName') || undefined, adminEmail: form.get('adminEmail'), adminName: form.get('adminName'), planCode: form.get('planCode'), stateCode: form.get('stateCode') || undefined, organisationType: form.get('organisationType') || undefined, activate: form.get('activate') === 'on' } }))
    } catch (caught) { notify(caught instanceof Error ? caught.message : 'Unable to create the company.', 'bad') }
    finally { setBusy(false) }
  }
  if (created) return <section className="ops-secret-card"><div className="ops-success-mark"><Check size={28} /></div><span className="ops-eyebrow">COMPANY CREATED</span><h1>Hand over this password now.</h1><p>It appears once and is stored nowhere else. If it is lost, the customer must use password reset.</p><div className="ops-credential"><small>{created.adminEmail}</small><code>{created.password}</code><button onClick={() => { void navigator.clipboard.writeText(created.password); setCopied(true) }}>{copied ? <Check size={17} /> : <Clipboard size={17} />}{copied ? 'Copied' : 'Copy password'}</button></div><div className="ops-secret-actions"><button className="ops-button ghost" onClick={onBack}>Return to companies</button><button className="ops-button primary" onClick={() => onCreated(created.tenantId)}>Open company account<ChevronRight size={17} /></button></div></section>
  return <>
    <header className="ops-page-head"><div><button className="ops-back" onClick={onBack}><ArrowLeft size={16} /> Companies</button><span className="ops-eyebrow">ACCOUNT PROVISIONING</span><h1>New company</h1><p>Create the customer, its first administrator and the subscription sold.</p></div></header>
    <form className="ops-panel ops-company-form" onSubmit={submit}>
      <div className="ops-form-section"><span>01</span><div><h2>Organisation</h2><p>The legal identity and the name people see inside PEPL.</p></div></div>
      <div className="ops-form-grid"><label>Legal name<input name="legalName" required placeholder="Vindhya Textiles Pvt Ltd" /></label><label>Display name<input name="displayName" placeholder="Vindhya Textiles" /></label><label>Organisation type<select name="organisationType" value={presetCode} onChange={event => setPresetCode(event.target.value)}><option value="">Standard — no preset</option>{presets.map(preset => <option key={preset.code} value={preset.code}>{preset.label}</option>)}</select></label><label>State code<input name="stateCode" maxLength={2} placeholder="TS" /></label></div>
      <p className="ops-muted ops-type-hint">{presets.find(preset => preset.code === presetCode) ? `Fits: ${presets.find(preset => preset.code === presetCode)!.examples}. Starts the company with matching shifts, leave and attendance rules.` : 'Sets the starting shifts, leave and attendance rules. The customer can change every one of them afterwards.'}</p>
      <div className="ops-form-section"><span>02</span><div><h2>First administrator</h2><p>This person receives the one-time credential shown after creation.</p></div></div>
      <div className="ops-form-grid"><label>Administrator name<input name="adminName" required placeholder="Lata Rao" /></label><label>Work email<input name="adminEmail" type="email" required placeholder="ops@vindhya.com" /></label></div>
      <div className="ops-form-section"><span>03</span><div><h2>Subscription</h2><p>Choose what sales agreed. Activation removes the trial immediately.</p></div></div>
      <div className="ops-form-grid"><label>Plan<select name="planCode" defaultValue="trial">{plans.map(plan => <option key={plan.code} value={plan.code}>{plan.name} · {money(plan.base_price_paise)}/month</option>)}</select></label><label className="ops-check"><input type="checkbox" name="activate" /><span><strong>Activate immediately</strong><small>Start billing now instead of opening a trial.</small></span></label></div>
      <div className="ops-form-actions"><button type="button" className="ops-button ghost" onClick={onBack}>Cancel</button><button className="ops-button primary" disabled={busy}>{busy ? 'Creating account…' : 'Create company'}<ChevronRight size={17} /></button></div>
    </form>
  </>
}

type InvoiceAction = { kind: 'pay' | 'void' | 'credit'; invoice: Invoice }

function CompanyDetail({ id, plans, onBack, notify }: { id: string; plans: Plan[]; onBack: () => void; notify: (message: string, kind?: 'good' | 'bad') => void }) {
  const [data, setData] = useState<CompanyDetailData | null>(null)
  const [loading, setLoading] = useState(true)
  const [billingOpen, setBillingOpen] = useState(false)
  const [action, setAction] = useState<InvoiceAction | null>(null)
  const [statusOpen, setStatusOpen] = useState(false)
  const load = useCallback(async () => {
    setLoading(true)
    try { setData(await platformApi(`/tenants/${id}`)) }
    catch (caught) { notify(caught instanceof Error ? caught.message : 'Unable to load this company.', 'bad') }
    finally { setLoading(false) }
  }, [id, notify])
  useEffect(() => { void load() }, [load])
  if (loading || !data) return <div className="ops-page-loading"><span className="ops-spinner" /><p>Loading company account…</p></div>
  const { tenant, billing, invoices, creditNotes } = data
  const changePlan = async (planCode: string) => { try { await platformApi(`/tenants/${id}/plan`, { method: 'POST', body: { planCode } }); notify('Plan updated and entitlements projected.', 'good'); await load() } catch (caught) { notify((caught as Error).message, 'bad') } }
  const changeStatus = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await platformApi(`/tenants/${id}/status`, { method: 'POST', body: { status: billing.status === 'suspended' ? 'active' : 'suspended', reason: form.get('reason') } }); setStatusOpen(false); notify(billing.status === 'suspended' ? 'Company reactivated.' : 'Company suspended. Every module is now off; no data was deleted.', 'good'); await load() } catch (caught) { notify((caught as Error).message, 'bad') } }
  const saveBilling = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = new FormData(event.currentTarget); try { await platformApi(`/tenants/${id}/billing-details`, { method: 'PATCH', body: { gstin: form.get('gstin'), address: form.get('address'), email: form.get('email'), stateCode: form.get('stateCode') } }); setBillingOpen(false); notify('Billing details updated.', 'good'); await load() } catch (caught) { notify((caught as Error).message, 'bad') } }
  const invoiceAction = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!action) return; const form = new FormData(event.currentTarget); const body = action.kind === 'pay' ? { reference: form.get('reference') } : action.kind === 'void' ? { reason: form.get('reason') } : { reason: form.get('reason'), ...(form.get('amountRupees') ? { amountRupees: Number(form.get('amountRupees')) } : {}) }; try { await platformApi(`/invoices/${action.invoice.id}/${action.kind}`, { method: 'POST', body }); setAction(null); notify(action.kind === 'pay' ? 'Payment recorded.' : action.kind === 'void' ? 'Invoice voided.' : 'Credit note issued.', 'good'); await load() } catch (caught) { notify((caught as Error).message, 'bad') } }
  const download = async (invoice: Invoice) => { try { const file = await platformApi<{ fileName: string; contentBase64: string }> (`/invoices/${invoice.id}/pdf`); const bytes = Uint8Array.from(atob(file.contentBase64), char => char.charCodeAt(0)); const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' })); const link = document.createElement('a'); link.href = url; link.download = file.fileName; link.click(); URL.revokeObjectURL(url) } catch (caught) { notify((caught as Error).message, 'bad') } }
  return <>
    <header className="ops-page-head company-detail-head"><div><button className="ops-back" onClick={onBack}><ArrowLeft size={16} /> Companies</button><div className="ops-title-line"><span className="ops-company-mark large">{tenant.display_name.slice(0, 2).toUpperCase()}</span><div><span className="ops-eyebrow">CUSTOMER ACCOUNT</span><h1>{tenant.display_name}</h1><p>{tenant.legal_name}</p></div></div></div><div><Status value={billing.status} /><button className="ops-button ghost" onClick={() => setBillingOpen(true)}>Edit billing</button><button className={`ops-button ${billing.status === 'suspended' ? 'primary' : 'danger'}`} onClick={() => setStatusOpen(true)}>{billing.status === 'suspended' ? <RefreshCw size={16} /> : <Ban size={16} />}{billing.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button></div></header>
    <div className="ops-kpis company-kpis"><article><span className="green"><Users /></span><small>Active employees</small><strong>{billing.active_employees}</strong><p>{billing.employee_limit ? `${Math.round(billing.active_employees / billing.employee_limit * 100)}% of ${billing.employee_limit.toLocaleString('en-IN')} limit` : 'No plan limit'}</p></article><article><span className="mint"><BadgeIndianRupee /></span><small>Next invoice</small><strong>{money(billing.estimate.total_paise)}</strong><p>{dateLabel(billing.current_period_end)}</p></article><article><span className="sand"><FileText /></span><small>Outstanding</small><strong>{money(billing.outstanding.total_paise)}</strong><p>{billing.outstanding.count} invoice{billing.outstanding.count === 1 ? '' : 's'}</p></article><article className={billing.outstanding.count ? 'coral' : ''}><span><ShieldCheck /></span><small>Current plan</small><strong className="text-value">{billing.plan.name}</strong><p>{dateLabel(billing.current_period_start)} – {dateLabel(billing.current_period_end)}</p></article></div>
    <div className="ops-detail-grid"><section className="ops-panel ops-subscription"><div className="ops-panel-head"><div><h2>Subscription</h2><p>Plan, billing period and projected charge</p></div></div><label>Plan<select value={billing.plan.code} onChange={event => void changePlan(event.target.value)}>{plans.map(plan => <option key={plan.code} value={plan.code}>{plan.name}</option>)}</select></label><dl><div><dt>Base</dt><dd>{money(billing.plan.base_price_paise)}</dd></div><div><dt>Per employee</dt><dd>{money(billing.plan.per_employee_price_paise)}</dd></div><div><dt>Subtotal</dt><dd>{money(billing.estimate.subtotal_paise)}</dd></div><div><dt>GST</dt><dd>{money(billing.estimate.gst_paise)}</dd></div><div className="total"><dt>Estimated total</dt><dd>{money(billing.estimate.total_paise)}</dd></div></dl></section><section className="ops-panel ops-billing-card"><div className="ops-panel-head"><div><h2>Billing identity</h2><p>Tax details and place of supply</p></div><button onClick={() => setBillingOpen(true)}>Edit</button></div><dl><div><dt>Billing email</dt><dd>{billing.billing_email || 'Not set'}</dd></div><div><dt>GSTIN</dt><dd>{billing.billing_gstin || 'Not set'}</dd></div><div><dt>State code</dt><dd>{billing.billing_state_code || 'Not set'}</dd></div><div><dt>Address</dt><dd>{billing.billing_address || 'Not set'}</dd></div></dl>{!billing.billing_state_code && <div className="ops-warning"><AlertTriangle size={16} />Without a place of supply, every invoice uses IGST.</div>}</section></div>
    <section className="ops-panel"><div className="ops-panel-head"><div><h2>Invoices</h2><p>{invoices.length} billing record{invoices.length === 1 ? '' : 's'}</p></div></div>{invoices.length ? <div className="ops-table-wrap"><table><thead><tr><th>Invoice</th><th>Period</th><th>Amount</th><th>Status</th><th>Due / paid</th><th>Actions</th></tr></thead><tbody>{invoices.map(invoice => <tr key={invoice.id}><td><strong>{invoice.number}</strong><small>{invoice.employees} employees · {pretty(invoice.plan_code)}</small></td><td>{dateLabel(invoice.period_start)} – {dateLabel(invoice.period_end)}</td><td><b>{money(invoice.total_paise)}</b></td><td><Status value={invoice.status} /></td><td>{invoice.paid_at ? dateLabel(invoice.paid_at) : dateLabel(invoice.due_on)}</td><td><div className="ops-row-actions"><button title="Download PDF" onClick={() => void download(invoice)}><Download size={16} /></button>{invoice.status === 'due' && <><button onClick={() => setAction({ kind: 'pay', invoice })}>Pay</button><button onClick={() => setAction({ kind: 'void', invoice })}>Void</button></>}{invoice.status === 'paid' && <button onClick={() => setAction({ kind: 'credit', invoice })}>Credit</button>}</div></td></tr>)}</tbody></table></div> : <Empty icon={<FileText />} title="No invoices yet" text="An invoice appears when a paid billing period closes." />}</section>
    {creditNotes.length > 0 && <section className="ops-panel"><div className="ops-panel-head"><div><h2>Credit notes</h2><p>Adjustments against paid invoices</p></div></div><div className="ops-credit-grid">{creditNotes.map(note => <article key={note.id}><span><FileText size={18} /></span><div><strong>{note.number}</strong><small>{dateLabel(note.issued_on)} · {note.reason}</small></div><b>{money(note.total_paise)}</b></article>)}</div></section>}
    {billingOpen && <div className="ops-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) setBillingOpen(false) }}><form className="ops-modal" onSubmit={saveBilling}><div className="ops-modal-head"><div><small>BILLING IDENTITY</small><h2>Edit billing details</h2></div><button type="button" onClick={() => setBillingOpen(false)}><X /></button></div><label>Billing email<input name="email" type="email" defaultValue={billing.billing_email ?? ''} /></label><div className="ops-two"><label>GSTIN<input name="gstin" defaultValue={billing.billing_gstin ?? ''} /></label><label>State code<input name="stateCode" maxLength={2} defaultValue={billing.billing_state_code ?? ''} /></label></div><label>Registered address<textarea name="address" defaultValue={billing.billing_address ?? ''} rows={4} /></label><div className="ops-form-actions"><button type="button" className="ops-button ghost" onClick={() => setBillingOpen(false)}>Cancel</button><button className="ops-button primary">Save billing details</button></div></form></div>}
    {statusOpen && <div className="ops-modal-backdrop"><form className="ops-modal" onSubmit={changeStatus}><div className="ops-modal-head"><div><small>{billing.status === 'suspended' ? 'REACTIVATE' : 'HIGH IMPACT'}</small><h2>{billing.status === 'suspended' ? 'Reactivate this company?' : 'Suspend this company?'}</h2></div><button type="button" onClick={() => setStatusOpen(false)}><X /></button></div><p>{billing.status === 'suspended' ? 'The customer regains the modules included in its plan.' : 'Every customer module turns off immediately. No company or employee data is deleted.'}</p><label>Reason<textarea name="reason" required rows={3} placeholder="Payment received, commercial hold, duplicate account…" /></label><div className="ops-form-actions"><button type="button" className="ops-button ghost" onClick={() => setStatusOpen(false)}>Cancel</button><button className={`ops-button ${billing.status === 'suspended' ? 'primary' : 'danger'}`}>{billing.status === 'suspended' ? 'Reactivate company' : 'Suspend company'}</button></div></form></div>}
    {action && <div className="ops-modal-backdrop"><form className="ops-modal" onSubmit={invoiceAction}><div className="ops-modal-head"><div><small>INVOICE {action.invoice.number}</small><h2>{action.kind === 'pay' ? 'Record payment' : action.kind === 'void' ? 'Void unpaid invoice' : 'Issue credit note'}</h2></div><button type="button" onClick={() => setAction(null)}><X /></button></div><p>{action.kind === 'pay' ? `Record the transfer against ${money(action.invoice.total_paise)}.` : action.kind === 'void' ? 'The invoice keeps its number and is marked void. This cannot be used for a paid invoice.' : `Reduce the paid invoice. Leave the amount empty to credit the remaining full value.`}</p>{action.kind === 'pay' ? <label>Payment reference<input name="reference" required placeholder="NEFT UTR SBIN426100234891" /></label> : <><label>Reason<textarea name="reason" required rows={3} placeholder="Billed on the wrong headcount, agreed goodwill adjustment…" /></label>{action.kind === 'credit' && <label>Amount in rupees <span>(optional)</span><input name="amountRupees" type="number" min="0.01" step="0.01" placeholder="Full remaining amount" /></label>}</>}<div className="ops-form-actions"><button type="button" className="ops-button ghost" onClick={() => setAction(null)}>Cancel</button><button className={`ops-button ${action.kind === 'void' ? 'danger' : 'primary'}`}>{action.kind === 'pay' ? 'Record payment' : action.kind === 'void' ? 'Void invoice' : 'Issue credit note'}</button></div></form></div>}
  </>
}

function Revenue({ notify }: { notify: (message: string, kind?: 'good' | 'bad') => void }) {
  const [data, setData] = useState<{ lines: RevenueLine[]; mrrPaise: string } | null>(null)
  useEffect(() => { void platformApi<{ lines: RevenueLine[]; mrrPaise: string }>('/revenue').then(setData).catch(caught => notify((caught as Error).message, 'bad')) }, [notify])
  const active = data?.lines.filter(line => ['active', 'past_due'].includes(line.status)) ?? []
  const max = Math.max(1, ...active.map(line => Number(BigInt(line.monthlyPaise) / 100n)))
  return <><header className="ops-page-head"><div><span className="ops-eyebrow">COMMERCIAL HEALTH</span><h1>Revenue</h1><p>Monthly recurring revenue by plan. Trials and sandboxes are excluded.</p></div></header>{data ? <><div className="ops-revenue-hero"><div><span><IndianRupee /></span><small>MONTHLY RECURRING REVENUE</small><strong>{money(data.mrrPaise)}</strong><p>{active.reduce((sum, line) => sum + line.tenants, 0)} paying companies · {active.reduce((sum, line) => sum + line.employees, 0).toLocaleString('en-IN')} employees</p></div><div className="ops-revenue-bars">{active.map(line => <div key={`${line.plan_code}-${line.status}`}><span>{pretty(line.plan_code)} <small>{pretty(line.status)}</small></span><i><b style={{ width: `${Math.max(5, Number(BigInt(line.monthlyPaise) / 100n) / max * 100)}%` }} /></i><strong>{money(line.monthlyPaise)}</strong></div>)}</div></div><section className="ops-panel"><div className="ops-panel-head"><div><h2>Revenue by plan</h2><p>Current recurring value at today’s headcount</p></div></div><div className="ops-table-wrap"><table><thead><tr><th>Plan</th><th>Status</th><th>Companies</th><th>Employees</th><th>Monthly value</th></tr></thead><tbody>{data.lines.map(line => <tr key={`${line.plan_code}-${line.status}`}><td><strong>{pretty(line.plan_code)}</strong></td><td><Status value={line.status} /></td><td>{line.tenants}</td><td>{line.employees.toLocaleString('en-IN')}</td><td><b>{money(line.monthlyPaise)}</b></td></tr>)}</tbody></table></div></section></> : <div className="ops-page-loading"><span className="ops-spinner" /></div>}</>
}

function StaffView({ notify }: { notify: (message: string, kind?: 'good' | 'bad') => void }) {
  const [staff, setStaff] = useState<Staff[]>([])
  const [loading, setLoading] = useState(true)
  useEffect(() => { void platformApi<{ staff: Staff[] }>('/staff').then(result => setStaff(result.staff)).catch(caught => notify((caught as Error).message, 'bad')).finally(() => setLoading(false)) }, [notify])
  return <><header className="ops-page-head"><div><span className="ops-eyebrow">ACCESS CONTROL</span><h1>Operator staff</h1><p>Who can reach every customer’s billing. New operators are created from the CLI.</p></div></header><div className="ops-kpis staff-kpis"><article><span className="green"><Users /></span><small>Active operators</small><strong>{staff.filter(member => member.status === 'active').length}</strong><p>Eight-hour sessions</p></article><article className={staff.some(member => !member.mfa_enabled) ? 'coral' : ''}><span><ShieldCheck /></span><small>Without second factor</small><strong>{staff.filter(member => !member.mfa_enabled).length}</strong><p>Needs immediate setup</p></article></div><section className="ops-panel"><div className="ops-panel-head"><div><h2>Staff directory</h2><p>Authentication posture and recent access</p></div><code>npm run ops staff-add</code></div>{loading ? <div className="ops-loading-list"><i /><i /></div> : <div className="ops-table-wrap"><table><thead><tr><th>Operator</th><th>Status</th><th>Second factor</th><th>Last sign-in</th></tr></thead><tbody>{staff.map(member => <tr key={member.id}><td><span className="ops-company-mark">{member.full_name.split(' ').map(part => part[0]).slice(0, 2).join('')}</span><div><strong>{member.full_name}</strong><small>{member.email}</small></div></td><td><Status value={member.status} /></td><td>{member.mfa_enabled ? <span className="ops-secure"><ShieldCheck size={16} /> Enrolled</span> : <span className="ops-mfa-missing"><AlertTriangle size={16} /> Not enrolled</span>}</td><td>{member.last_login_at ? dateLabel(member.last_login_at) : 'Never'}</td></tr>)}</tbody></table></div>}</section></>
}

export function AdminApp() {
  const [phase, setPhase] = useState<AuthPhase>('loading')
  const [operator, setOperator] = useState<Operator | null>(null)
  const [screen, setScreen] = useState<Screen>('companies')
  const [companyId, setCompanyId] = useState<string | null>(null)
  const [plans, setPlans] = useState<Plan[]>([])
  const [toast, setToast] = useState<{ message: string; kind: 'good' | 'bad' } | null>(null)
  const notify = useCallback((message: string, kind: 'good' | 'bad' = 'good') => { setToast({ message, kind }); window.setTimeout(() => setToast(null), 5000) }, [])
  useEffect(() => {
    const expired = () => { setOperator(null); setPhase('login'); setScreen('companies'); notify('Your operator session ended. Sign in again.', 'bad') }
    const verify = () => setPhase('verify')
    window.addEventListener('pepl-platform-auth-expired', expired)
    window.addEventListener('pepl-platform-mfa-required', verify)
    return () => { window.removeEventListener('pepl-platform-auth-expired', expired); window.removeEventListener('pepl-platform-mfa-required', verify) }
  }, [notify])
  useEffect(() => { if (phase === 'ready') void platformApi<{ plans: Plan[] }>('/plans').then(result => setPlans(result.plans)).catch(caught => notify((caught as Error).message, 'bad')) }, [notify, phase])
  const logout = async () => { await platformApi('/logout', { method: 'POST', body: {} }).catch(() => undefined); sessionStorage.removeItem(PLATFORM_TOKEN); setOperator(null); setPhase('login'); setScreen('companies') }
  if (phase !== 'ready') return <AuthScreen phase={phase} setPhase={setPhase} setOperator={setOperator} />
  const openCompany = (tenant: Tenant) => { setCompanyId(tenant.id); setScreen('company') }
  return <div className="ops-stage"><div className="ops-shell"><header className="ops-topbar"><Logo /><nav aria-label="Operator navigation"><button className={screen === 'companies' || screen === 'company' ? 'active' : ''} onClick={() => setScreen('companies')}><LayoutDashboard size={17} />Companies</button><button className={screen === 'revenue' ? 'active' : ''} onClick={() => setScreen('revenue')}><BadgeIndianRupee size={17} />Revenue</button><button className={screen === 'staff' ? 'active' : ''} onClick={() => setScreen('staff')}><Users size={17} />Staff</button></nav><div className="ops-operator"><span>{operator?.full_name.split(' ').map(part => part[0]).slice(0, 2).join('')}</span><div><strong>{operator?.full_name}</strong><small>{operator?.email}</small></div><button onClick={() => void logout()} title="Sign out"><LogOut size={18} /></button></div></header><main>{screen === 'companies' ? <Companies onOpen={openCompany} onNew={() => setScreen('new')} notify={notify} /> : screen === 'new' ? <NewCompany plans={plans} onBack={() => setScreen('companies')} onCreated={id => { setCompanyId(id); setScreen('company') }} notify={notify} /> : screen === 'company' && companyId ? <CompanyDetail id={companyId} plans={plans} onBack={() => setScreen('companies')} notify={notify} /> : screen === 'revenue' ? <Revenue notify={notify} /> : <StaffView notify={notify} />}</main></div>{toast && <div className={`ops-toast ${toast.kind}`} role="status">{toast.kind === 'good' ? <Check size={17} /> : <AlertTriangle size={17} />}{toast.message}<button onClick={() => setToast(null)}><X size={15} /></button></div>}</div>
}
