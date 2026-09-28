/**
 * The back office, for the people who sell and bill.
 *
 *   npm run ops <command> [args]
 *
 * PEPL is sold by salespeople to organisations, invoiced, and paid by transfer
 * — so the operations that matter are: open an account for a customer, put
 * them on the plan that was sold, raise the invoices when a period closes, and
 * record the money when it arrives.
 *
 * This is a CLI and not a web console on purpose. Every user in PEPL belongs to
 * a tenant; there is no platform-staff identity, and inventing one would create
 * a login that can reach every customer's data. Shell access on the server is
 * the right bar for "create a company" and "mark this invoice paid". Every
 * command here goes through the same control-plane functions the product uses
 * and lands in control_plane.platform_audit.
 *
 * Nothing here can read inside a tenant: the control connection provisions and
 * bills, and employee data stays behind RLS where the app role lives.
 */
import { controlDb, changePlan, setSubscriptionStatus } from '../src/control-plane/index.ts'
import {
  signup, listPlans, listInvoices, markInvoicePaid, voidInvoice,
  billingSummary, closePeriods, runDunning, priceFor, updateBillingDetails,
} from '../src/control-plane/billing.ts'
import { invoicePdf, supplierFromEnv } from '../src/control-plane/invoice-pdf.ts'
import { issueCreditNote, listCreditNotes } from '../src/control-plane/credit-notes.ts'
import { upsertPlatformUser, listPlatformUsers, setPlatformUserStatus } from '../src/control-plane/platform-auth.ts'
import { randomBytes } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { closePools } from '../src/db/pool.ts'

const rupees = (paise: string | bigint | number): string =>
  `₹${(Number(paise) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`

/** --flag value pairs, plus the bare positional arguments. */
function parse(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a.startsWith('--')) { flags[a.slice(2)] = argv[i + 1] ?? ''; i++ } else positional.push(a)
  }
  return { positional, flags }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A tenant by id, or by a name fragment — refusing an ambiguous one rather than guessing. */
async function resolveTenant(ref: string): Promise<{ id: string; name: string }> {
  if (UUID.test(ref)) {
    const { rows } = await controlDb.query<{ id: string; display_name: string }>(
      `SELECT id, display_name FROM tenants WHERE id = $1`, [ref])
    if (!rows[0]) throw new Error(`no tenant with id ${ref}`)
    return { id: rows[0].id, name: rows[0].display_name }
  }
  const { rows } = await controlDb.query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM tenants WHERE legal_name ILIKE $1 OR display_name ILIKE $1 ORDER BY created_at`,
    [`%${ref}%`])
  if (!rows.length) throw new Error(`no tenant matching "${ref}"`)
  if (rows.length > 1) {
    throw new Error(`"${ref}" matches ${rows.length} companies:\n` +
      rows.map((r) => `  ${r.id}  ${r.display_name}`).join('\n') + '\nUse the id.')
  }
  return { id: rows[0]!.id, name: rows[0]!.display_name }
}

function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const line = (cells: string[]) => cells.map((c, i) => (c ?? '').padEnd(widths[i]!)).join('  ')
  return [line(headers), widths.map((w) => '-'.repeat(w)).join('  '), ...rows.map(line)].join('\n')
}

const COMMANDS: Record<string, (p: string[], f: Record<string, string>) => Promise<void>> = {
  async tenants() {
    const { rows } = await controlDb.query<{
      id: string; display_name: string; status: string; plan_code: string; sub_status: string
      trial_ends_on: string | null; employees: number; is_sandbox: boolean
    }>(`SELECT t.id, t.display_name, t.status, s.plan_code, s.status AS sub_status, s.trial_ends_on::text,
               (SELECT count(*)::int FROM employees e WHERE e.tenant_id = t.id) AS employees, t.is_sandbox
          FROM tenants t LEFT JOIN control_plane.subscriptions s ON s.tenant_id = t.id
         ORDER BY t.is_sandbox, t.created_at`)
    if (!rows.length) return console.log('No companies yet. `npm run ops create --help`.')
    console.log(table(
      ['ID', 'COMPANY', 'PLAN', 'SUBSCRIPTION', 'PEOPLE', 'NOTE'],
      rows.map((r) => [
        r.id, r.display_name, r.plan_code ?? '—', r.sub_status ?? r.status,
        String(r.employees),
        r.is_sandbox ? 'sandbox' : r.trial_ends_on ? `trial ends ${r.trial_ends_on}` : '',
      ])))
  },

  async show(p) {
    const t = await resolveTenant(p[0] ?? '')
    const b = await billingSummary(t.id)
    console.log(`${t.name}  (${t.id})

  Plan            ${b.plan.name} — ${rupees(b.plan.base_price_paise)} + ${rupees(b.plan.per_employee_price_paise)}/person
  Subscription    ${b.status}${b.trial_ends_on ? ` · trial ends ${b.trial_ends_on}` : ''}
  Period          ${b.current_period_start} to ${b.current_period_end}
  People          ${b.active_employees}${b.employee_limit === null ? '' : ` of ${b.employee_limit}`}
  Next invoice    ${rupees(b.estimate.total_paise)} incl. GST
  Outstanding     ${b.outstanding.count} invoice(s), ${rupees(b.outstanding.total_paise)}${b.outstanding.oldest_due_on ? ` · oldest due ${b.outstanding.oldest_due_on}` : ''}
  Billing to      ${b.billing_email ?? '—'}${b.billing_gstin ? ` · GSTIN ${b.billing_gstin}` : ''}`)
  },

  async create(_p, f) {
    for (const required of ['name', 'admin-email', 'admin-name']) {
      if (!f[required]) throw new Error(`--${required} is required`)
    }
    // A password the customer must change; ops reads it out once and it is not stored anywhere else.
    const password = f.password ?? `pepl-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 6)}`
    const planCode = f.plan ?? 'trial'
    const { tenantId } = await signup({
      legalName: f.name!, displayName: f['display-name'] ?? f.name!,
      adminEmail: f['admin-email']!, adminName: f['admin-name']!, password,
      stateCode: f.state, planCode, organisationType: f.type,
    })
    // signup always opens a 14-day trial. A sold deal starts paying now.
    if (f.activate !== undefined) {
      await changePlan(tenantId, planCode)
      await setSubscriptionStatus(tenantId, 'active')
      await controlDb.query(
        `UPDATE control_plane.subscriptions SET trial_ends_on = NULL WHERE tenant_id = $1`, [tenantId])
    }
    console.log(`Created ${f.name}

  Tenant id   ${tenantId}
  Plan        ${planCode}${f.activate !== undefined ? ' (active, no trial)' : ' (14-day trial)'}
  Sign in     ${f['admin-email']}
  Password    ${password}

Give these to the customer and have them change the password at first sign-in.`)
  },

  async plan(p) {
    const t = await resolveTenant(p[0] ?? '')
    const code = p[1]
    if (!code) throw new Error(`usage: ops plan <company> <${(await listPlans()).map((x) => x.code).join('|')}>`)
    await changePlan(t.id, code)
    console.log(`${t.name} is now on ${code}.`)
  },

  async suspend(p, f) {
    const t = await resolveTenant(p[0] ?? '')
    await setSubscriptionStatus(t.id, 'suspended')
    await controlDb.query(
      `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('tenant.suspended', $1, $2::jsonb)`,
      [t.id, JSON.stringify({ reason: f.reason ?? 'operator action' })])
    console.log(`${t.name} suspended. Modules are off; nothing has been deleted.`)
  },

  async activate(p) {
    const t = await resolveTenant(p[0] ?? '')
    await setSubscriptionStatus(t.id, 'active')
    console.log(`${t.name} reactivated.`)
  },

  async invoices(p) {
    const t = await resolveTenant(p[0] ?? '')
    const rows = await listInvoices(t.id)
    if (!rows.length) return console.log(`${t.name} has no invoices yet.`)
    console.log(`${t.name}\n`)
    console.log(table(
      ['NUMBER', 'PERIOD', 'PEOPLE', 'TOTAL', 'STATUS', 'DUE', 'REFERENCE'],
      rows.map((i) => [
        i.number, `${i.period_start} → ${i.period_end}`, String(i.employees),
        rupees(i.total_paise), i.status, i.due_on, i.payment_reference ?? '',
      ])))
  },

  async pay(p, f) {
    const ref = f.ref ?? f.reference
    if (!ref) throw new Error('--ref is required: the NEFT/UTR or cheque number that settled it')
    // An unquoted reference with spaces would otherwise record only its first
    // word, and a truncated payment reference is a reconciliation problem
    // nobody notices until the auditor does.
    if (p.length > 1) throw new Error(`unexpected extra words: ${p.slice(1).join(' ')}
Quote the reference: --ref "NEFT UTR 12345"`)
    const invoice = await findInvoice(p[0] ?? '')
    const paid = await markInvoicePaid(invoice, ref)
    console.log(`Invoice ${paid.number} marked paid — ${rupees(paid.total_paise)}, reference ${ref}.`)
    console.log('Dunning has been re-run, so a suspension for this debt is lifted.')
  },

  async void(p, f) {
    if (!f.reason) throw new Error('--reason is required: a voided invoice has to say why')
    if (p.length > 1) throw new Error(`unexpected extra words: ${p.slice(1).join(' ')}
Quote the reason: --reason "raised in error"`)
    const invoice = await findInvoice(p[0] ?? '')
    const v = await voidInvoice(invoice, f.reason)
    console.log(`Invoice ${v.number} voided — ${rupees(v.total_paise)}. Reason: ${f.reason}`)
  },

  async 'invoice-pdf'(p, f) {
    const id = await findInvoice(p[0] ?? '')
    const supplier = supplierFromEnv()
    if (!supplier.gstin) {
      console.warn('Warning: PEPL_GSTIN is not set, so this will NOT be a tax invoice.')
    }
    const pdf = await invoicePdf(id)
    const out = f.out ?? pdf.fileName
    writeFileSync(out, pdf.bytes)
    console.log(`Wrote ${out} (${pdf.bytes.length} bytes). Email it to the customer's accounts address.`)
  },

  async 'billing-details'(p, f) {
    const t = await resolveTenant(p[0] ?? '')
    const patch: { gstin?: string; address?: string; email?: string; stateCode?: string } = {}
    if (f.gstin !== undefined) patch.gstin = f.gstin
    if (f.address !== undefined) patch.address = f.address
    if (f.email !== undefined) patch.email = f.email
    // The place of supply decides CGST+SGST against IGST, so it is the one
    // field an invoice cannot be raised correctly without.
    if (f.state !== undefined) patch.stateCode = f.state
    if (!Object.keys(patch).length) throw new Error('nothing to change: pass --gstin, --address, --email or --state')
    await updateBillingDetails(t.id, patch)
    const b = await billingSummary(t.id)
    console.log(`${t.name}
  GSTIN            ${b.billing_gstin ?? '—'}
  Address          ${b.billing_address ?? '—'}
  Billing email    ${b.billing_email ?? '—'}
  Place of supply  ${b.billing_state_code ?? '— (invoices will carry IGST)'}`)
  },

  async credit(p, f) {
    if (!f.reason) throw new Error('--reason is required: a credit has to be explicable later')
    if (p.length > 1) throw new Error(`unexpected extra words: ${p.slice(1).join(' ')}
Quote the reason.`)
    const id = await findInvoice(p[0] ?? '')
    // --amount is the taxable value in RUPEES; GST is added at the invoice's own
    // rate so nobody has to restate the tax by hand.
    const subtotalPaise = f.amount ? Math.round(Number(f.amount) * 100) : undefined
    if (f.amount && !Number.isFinite(subtotalPaise)) throw new Error('--amount must be a number of rupees')
    const note = await issueCreditNote({ invoiceId: id, reason: f.reason, subtotalPaise })
    console.log(`Credit note ${note.number} issued — ${rupees(note.total_paise)} (${rupees(note.subtotal_paise)} + GST).`)
  },

  async 'credit-notes'(p) {
    const t = await resolveTenant(p[0] ?? '')
    const rows = await listCreditNotes(t.id)
    if (!rows.length) return console.log(`${t.name} has no credit notes.`)
    console.log(`${t.name}
`)
    console.log(table(['NUMBER', 'ISSUED', 'TOTAL', 'REASON'],
      rows.map((n) => [n.number, n.issued_on, rupees(n.total_paise), n.reason.slice(0, 44)])))
  },

  async 'staff-add'(_p, f) {
    for (const required of ['email', 'name']) {
      if (!f[required]) throw new Error(`--${required} is required`)
    }
    // Generated here and printed once. Longer than a customer password because
    // this account reaches every company's billing -- and from the CSPRNG, not
    // Math.random(), which is seeded predictably and is not a place to get
    // clever about convenience.
    const password = f.password ?? `${randomBytes(9).toString('base64url')}-${randomBytes(9).toString('base64url')}`
    const r = await upsertPlatformUser({ email: f.email!, fullName: f.name!, password })
    console.log(`${r.created ? 'Created' : 'Updated'} platform operator

  Sign in at   https://<your-host>/   (the ordinary sign-in page: PEPL has one
               login form, and an operator address is recognised there and sent
               to the console)
  Email        ${f.email}
  Password     ${password}

They must enrol a second factor on first sign-in; the console opens nothing
until they do.`)
  },

  async staff() {
    const rows = await listPlatformUsers()
    if (!rows.length) return console.log('No platform operators yet. `npm run ops staff-add --email ... --name "..."`')
    console.log(table(['EMAIL', 'NAME', 'STATUS', '2FA', 'LAST SIGN-IN'],
      rows.map((u) => [u.email, u.full_name, u.status, u.mfa_enabled ? 'yes' : 'NOT SET', u.last_login_at ?? 'never'])))
  },

  async 'staff-suspend'(p) {
    const email = p[0]
    if (!email) throw new Error('usage: ops staff-suspend <email>')
    await setPlatformUserStatus(email, 'suspended')
    console.log(`${email} suspended; their sessions are revoked immediately.`)
  },

  async revenue() {
    const { rows } = await controlDb.query<{ plan_code: string; status: string; tenants: number; employees: number }>(
      `SELECT s.plan_code, s.status, count(*)::int AS tenants,
              coalesce(sum((SELECT count(*) FROM employees e WHERE e.tenant_id = s.tenant_id)), 0)::int AS employees
         FROM control_plane.subscriptions s
         JOIN tenants t ON t.id = s.tenant_id AND NOT t.is_sandbox
        GROUP BY s.plan_code, s.status ORDER BY s.plan_code, s.status`)
    const plans = new Map((await listPlans()).map((p) => [p.code, p]))
    let mrr = 0n
    const out = rows.map((r) => {
      const plan = plans.get(r.plan_code)
      const billed = r.status === 'active' || r.status === 'past_due'
      const value = plan && billed ? priceFor(plan, r.employees).subtotal : 0n
      mrr += value
      return [r.plan_code, r.status, String(r.tenants), String(r.employees), rupees(String(value))]
    })
    console.log(table(['PLAN', 'STATUS', 'COMPANIES', 'PEOPLE', 'MONTHLY (ex GST)'], out))
    console.log(`\n  MRR, excluding GST, trials and sandboxes: ${rupees(String(mrr))}`)
  },

  async 'close-periods'(_p, f) {
    // --as-of exists because a billing day can be missed, and the run has to be
    // repeatable for the date it should have happened on, not for today.
    const r = await closePeriods(f['as-of'] ? new Date(`${f['as-of']}T00:00:00Z`) : undefined)
    console.log(`Invoiced ${r.invoiced} company(ies); skipped ${r.skipped}.`)
  },

  async dunning(_p, f) {
    const r = await runDunning(f['as-of'] ? new Date(`${f['as-of']}T00:00:00Z`) : undefined)
    console.log(`Past due ${r.pastDue} · suspended ${r.suspended} · reactivated ${r.reactivated}.`)
  },

  async plans() {
    const rows = await listPlans()
    console.log(table(
      ['CODE', 'NAME', 'BASE/MONTH', 'PER PERSON', 'PEOPLE'],
      rows.map((p) => [p.code, p.name, rupees(p.base_price_paise), rupees(p.per_employee_price_paise),
        String(p.limits.employees ?? '—')])))
  },
}

/** An invoice by number (what a customer quotes) or by id. */
async function findInvoice(ref: string): Promise<string> {
  if (!ref) throw new Error('give an invoice number or id')
  if (UUID.test(ref)) return ref
  const { rows } = await controlDb.query<{ id: string }>(
    `SELECT id FROM control_plane.invoices WHERE number = $1`, [ref])
  if (!rows[0]) throw new Error(`no invoice numbered ${ref}`)
  return rows[0].id
}

const USAGE = `PEPL back office

  npm run ops tenants                          every company, plan and headcount
  npm run ops show <company>                   plan, period, headcount, what is outstanding
  npm run ops plans                            the plans on sale

  npm run ops create --name "Acme Pvt Ltd" --admin-email hr@acme.com --admin-name "Priya Sharma"
                     [--plan growth] [--state TS] [--type manufacturing] [--activate]
  npm run ops plan <company> <planCode>         move a company onto the plan that was sold
  npm run ops suspend <company> --reason "..."  modules off, nothing deleted
  npm run ops activate <company>

  npm run ops invoices <company>
  npm run ops pay <invoice-number> --ref "NEFT UTR..."   money arrived
  npm run ops void <invoice-number> --reason "..."       raised in error
  npm run ops invoice-pdf <invoice-number> [--out file.pdf]  the GST tax invoice
  npm run ops credit <invoice-number> --reason "..." [--amount 2500]
                                                a PAID invoice is reduced by a credit
                                                note; an unpaid one is voided instead
  npm run ops credit-notes <company>
  npm run ops billing-details <company> --gstin ... --address "..." --state TS
  npm run ops close-periods [--as-of 2026-11-01] raise invoices for periods that have ended
  npm run ops dunning                           apply the overdue/suspend/reactivate rules
  npm run ops revenue                           MRR by plan

  npm run ops staff                             who can sign in to the operator console
  npm run ops staff-add --email a@b.c --name "..."   create an operator
  npm run ops staff-suspend <email>             revoke access and every session

  PEPL_DEMO_SUFFIX=ravi npm run seed:demo       a demo company of this rep's own,
                                                so two people can demo at once

A company can be named by id or by any unambiguous part of its name.`

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  if (!command || command === 'help' || command === '--help') { console.log(USAGE); return }
  const run = COMMANDS[command]
  if (!run) { console.error(`Unknown command "${command}".\n\n${USAGE}`); process.exitCode = 1; return }
  const { positional, flags } = parse(rest)
  await run(positional, flags)
}

main()
  .catch((e: Error) => { console.error(e.message); process.exitCode = 1 })
  .finally(async () => { await closePools(); await controlDb.end() })
