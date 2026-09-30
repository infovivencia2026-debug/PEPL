/**
 * Signup, plans, billing and dunning — the part of the product that lets a
 * company start without talking to us, and lets us stop serving one that has
 * stopped paying.
 *
 * All of it runs on the control-plane connection: subscriptions and invoices
 * are ABOUT a tenant, not inside it. The tenant-facing routes pass their own
 * tenant id explicitly and only ever read their own rows.
 */
import { randomBytes } from 'node:crypto'
import type pg from 'pg'
import { controlDb, provisionTenant, projectEntitlements, ControlPlaneError } from './index.ts'
import { financialYear } from './financial-year.ts'
import { abandonProvisioning } from './abandon.ts'
import { hashPassword } from '../auth/index.ts'

export const GST_RATE = 0.18

/**
 * Whether this deployment may charge GST at all.
 *
 * A supplier who is not GST-registered MUST NOT collect GST. Until today the
 * 18% went onto every invoice regardless, while the PDF printed "Not a tax
 * invoice - no GSTIN configured for the supplier" -- a document that refuses to
 * call itself a tax invoice and charges tax anyway. Whichever way the customer
 * reads that, one of the two is wrong, and collecting tax you are not
 * registered to collect is the worse half.
 *
 * Registration is the deployment's own fact, so it lives in the environment
 * beside the rest of the supplier identity. The day a GSTIN is set, invoices
 * raised after it carry GST; ones already raised are untouched, which is what
 * you want -- an issued invoice is a record, not a view.
 */
export const gstApplies = (): boolean => Boolean(process.env.PEPL_GSTIN?.trim())

/** The rate actually charged: zero when this supplier is not registered. */
export const effectiveGstRate = (): number => (gstApplies() ? GST_RATE : 0)
export const TRIAL_DAYS = 14
export const DUE_DAYS = 7
export const PAST_DUE_AFTER_DAYS = 15
export const SUSPEND_AFTER_DAYS = 45

export interface Plan {
  code: string
  name: string
  base_price_paise: string
  per_employee_price_paise: string
  features: Record<string, boolean>
  limits: Record<string, number>
}

export async function listPlans(): Promise<Plan[]> {
  const { rows } = await controlDb.query<Plan>(
    `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits
       FROM control_plane.plans WHERE status = 'active'
      -- Qualified, because the select list aliases base_price_paise to its ::text
      -- cast and an unqualified ORDER BY binds to the OUTPUT column: the plans
      -- then sort lexicographically and 12000 comes before 2000.
      ORDER BY plans.base_price_paise, plans.code`)
  return rows
}

/**
 * A new company, from a form. The admin's email must be new to the platform:
 * login resolves an email across tenants, so a second tenant with the same
 * admin address would make sign-in ambiguous.
 */
export async function signup(args: {
  legalName: string; displayName?: string; adminEmail: string; adminName: string; password: string
  stateCode?: string; planCode?: string; organisationType?: string
}): Promise<{ tenantId: string; adminUserId: string }> {
  const email = args.adminEmail.trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ControlPlaneError('VALIDATION_FAILED', 'adminEmail must be an address')
  if (!args.legalName?.trim()) throw new ControlPlaneError('VALIDATION_FAILED', 'legalName is required')
  if (!args.adminName?.trim()) throw new ControlPlaneError('VALIDATION_FAILED', 'adminName is required')
  if ((args.password ?? '').length < 10) throw new ControlPlaneError('WEAK_PASSWORD', 'password must be at least 10 characters')
  const taken = await controlDb.query(`SELECT 1 FROM app_users WHERE lower(email) = $1`, [email])
  if (taken.rowCount) throw new ControlPlaneError('EMAIL_TAKEN', 'an account with this email already exists; sign in instead')

  const planCode = args.planCode ?? 'trial'
  const plan = await controlDb.query(`SELECT 1 FROM control_plane.plans WHERE code = $1 AND status = 'active'`, [planCode])
  if (!plan.rowCount) throw new ControlPlaneError('PLAN_NOT_FOUND', `no such plan: ${planCode}`)

  let tenantId: string
  try {
    ({ tenantId } = await provisionTenant({
      legalName: args.legalName.trim(), displayName: (args.displayName ?? args.legalName).trim(),
      planCode, adminEmail: email, adminName: args.adminName.trim(), stateCode: args.stateCode, organisationType: args.organisationType,
    }))
  } catch (err) {
    // A failed set-up must not strand a company and hold the address hostage: the
    // retry used to be told "an account with this email already exists; sign in
    // instead" for an admin who has no password. abandonProvisioning refuses
    // anything that is not plainly debris, so this cannot reach a real customer.
    const half = (err as { tenantId?: string }).tenantId
    if (half) await abandonProvisioning(half).catch(() => undefined)
    throw err
  }
  // The provisioner creates the admin without a password; the form gave us one.
  const hash = await hashPassword(args.password)
  const { rows } = await controlDb.query<{ id: string }>(
    `UPDATE app_users SET password_hash = $3, status = 'active' WHERE tenant_id = $1 AND lower(email) = $2 RETURNING id`,
    [tenantId, email, hash])
  const adminUserId = rows[0]!.id
  await controlDb.query(
    `INSERT INTO user_roles (tenant_id, user_id, role) VALUES ($1,$2,'org_admin') ON CONFLICT DO NOTHING`, [tenantId, adminUserId])
  await controlDb.query(
    `UPDATE control_plane.subscriptions
        SET trial_ends_on = CURRENT_DATE + $2::int, billing_email = $3, billing_state_code = $4
      WHERE tenant_id = $1`,
    [tenantId, TRIAL_DAYS, email, args.stateCode?.toUpperCase().trim() || null])
  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('tenant.signup', $1, $2::jsonb)`,
    [tenantId, JSON.stringify({ email, planCode })])
  return { tenantId, adminUserId }
}

export interface BillingSummary {
  plan: Plan
  status: string
  trial_ends_on: string | null
  current_period_start: string
  current_period_end: string
  active_employees: number
  employee_limit: number | null
  billing_gstin: string | null
  billing_address: string | null
  billing_email: string | null
  /** Place of supply for GST; without it an invoice cannot pick CGST+SGST over IGST. */
  billing_state_code: string | null
  /** What the next invoice would be at today's headcount. */
  estimate: { subtotal_paise: string; gst_paise: string; total_paise: string }
  outstanding: { count: number; total_paise: string; oldest_due_on: string | null }
}

export function priceFor(plan: Plan, employees: number): { subtotal: bigint; gst: bigint; total: bigint } {
  const subtotal = BigInt(plan.base_price_paise) + BigInt(plan.per_employee_price_paise) * BigInt(employees)
  const gst = BigInt(Math.round(Number(subtotal) * effectiveGstRate()))
  return { subtotal, gst, total: subtotal + gst }
}

async function activeHeadcount(tenantId: string): Promise<number> {
  const { rows } = await controlDb.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM employees WHERE tenant_id = $1 AND status <> 'exited'`, [tenantId])
  return Number(rows[0]!.n)
}

export async function billingSummary(tenantId: string): Promise<BillingSummary> {
  const { rows } = await controlDb.query<{
    plan_code: string; status: string; trial_ends_on: string | null; current_period_start: string; current_period_end: string
    billing_gstin: string | null; billing_address: string | null; billing_email: string | null
    billing_state_code: string | null
  }>(
    `SELECT plan_code, status, trial_ends_on::text, current_period_start::text, current_period_end::text,
            billing_gstin, billing_address, billing_email, billing_state_code
       FROM control_plane.subscriptions WHERE tenant_id = $1`, [tenantId])
  const sub = rows[0]
  if (!sub) throw new ControlPlaneError('NO_SUBSCRIPTION', 'this company has no subscription record')
  const plan = (await controlDb.query<Plan>(
    `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits FROM control_plane.plans WHERE code = $1`,
    [sub.plan_code])).rows[0]!
  const employees = await activeHeadcount(tenantId)
  const p = priceFor(plan, employees)
  const out = (await controlDb.query<{ n: string; total: string; oldest: string | null }>(
    `SELECT count(*)::text AS n, coalesce(sum(total_paise),0)::text AS total, min(due_on)::text AS oldest
       FROM control_plane.invoices WHERE tenant_id = $1 AND status = 'due'`, [tenantId])).rows[0]!
  return {
    plan, status: sub.status, trial_ends_on: sub.trial_ends_on,
    current_period_start: sub.current_period_start, current_period_end: sub.current_period_end,
    active_employees: employees, employee_limit: plan.limits.employees ?? null,
    billing_gstin: sub.billing_gstin, billing_address: sub.billing_address, billing_email: sub.billing_email,
    billing_state_code: sub.billing_state_code,
    estimate: { subtotal_paise: String(p.subtotal), gst_paise: String(p.gst), total_paise: String(p.total) },
    outstanding: { count: Number(out.n), total_paise: out.total, oldest_due_on: out.oldest },
  }
}

export async function updateBillingDetails(
  tenantId: string,
  patch: { gstin?: string | null; address?: string | null; email?: string | null; stateCode?: string | null },
): Promise<void> {
  if (patch.gstin && !/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(patch.gstin.toUpperCase())) {
    throw new ControlPlaneError('VALIDATION_FAILED', 'that is not a valid GSTIN')
  }
  await controlDb.query(
    `UPDATE control_plane.subscriptions
        SET billing_gstin = CASE WHEN $2::boolean THEN $3 ELSE billing_gstin END,
            billing_address = CASE WHEN $4::boolean THEN $5 ELSE billing_address END,
            billing_email = CASE WHEN $6::boolean THEN $7 ELSE billing_email END,
            billing_state_code = CASE WHEN $8::boolean THEN $9 ELSE billing_state_code END
      WHERE tenant_id = $1`,
    [tenantId, 'gstin' in patch, patch.gstin?.toUpperCase().trim() || null,
     'address' in patch, patch.address?.trim() || null, 'email' in patch, patch.email?.trim().toLowerCase() || null,
     'stateCode' in patch, patch.stateCode?.toUpperCase().trim() || null])
}

/**
 * A plan change. Upgrades take effect now. A downgrade is refused while the
 * company is over the new plan's headcount limit — the software must never
 * silently hide employees to fit a cheaper tier.
 */
/**
 * What an upgrade costs for the rest of the period it happens in.
 *
 * Without this a customer who moves to a better plan on the second day gets
 * twenty-eight days of it free, every time, which is a discount nobody decided
 * to give. The charge is the DIFFERENCE between the plans for the days that
 * remain, so the customer is never billed twice for what they already paid.
 *
 * A downgrade returns zero on purpose. Handing money back for service already
 * delivered is a credit note, and choosing a cheaper plan is not a billing
 * error; the lower price simply starts at the next period.
 */
export function prorationFor(
  from: Plan,
  to: Plan,
  employees: number,
  daysRemaining: number,
  daysInPeriod: number,
): { subtotalPaise: bigint; gstPaise: bigint; totalPaise: bigint } {
  const nothing = { subtotalPaise: 0n, gstPaise: 0n, totalPaise: 0n }
  if (daysRemaining <= 0 || daysInPeriod <= 0) return nothing

  const before = priceFor(from, employees).subtotal
  const after = priceFor(to, employees).subtotal
  if (after <= before) return nothing

  const subtotal = ((after - before) * BigInt(Math.min(daysRemaining, daysInPeriod))) / BigInt(daysInPeriod)
  if (subtotal <= 0n) return nothing
  const gst = (subtotal * BigInt(Math.round(effectiveGstRate() * 10_000))) / 10_000n
  return { subtotalPaise: subtotal, gstPaise: gst, totalPaise: subtotal + gst }
}

export async function switchPlan(tenantId: string, planCode: string): Promise<BillingSummary> {
  const plan = (await controlDb.query<Plan>(
    `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits FROM control_plane.plans WHERE code = $1 AND status = 'active'`,
    [planCode])).rows[0]
  if (!plan) throw new ControlPlaneError('PLAN_NOT_FOUND', `no such plan: ${planCode}`)
  if (plan.code === 'trial') throw new ControlPlaneError('PLAN_NOT_FOUND', 'a company cannot move back to the trial')
  const employees = await activeHeadcount(tenantId)
  if (plan.limits.employees !== undefined && employees > plan.limits.employees) {
    throw new ControlPlaneError('OVER_PLAN_LIMIT',
      `${plan.name} allows ${plan.limits.employees} employees; you have ${employees}. Exit or choose a larger plan first.`)
  }
  // ONE transaction. The plan, the entitlements, the top-up invoice and the audit rows were
  // separate statements on separate connections, so a failure part-way left a customer on a
  // new plan with nothing invoiced for it. The subscription row is locked first, so two
  // switches for the same company queue instead of both reading the same period.
  const client = await controlDb.connect()
  try {
    await client.query('BEGIN')
    const sub = (await client.query<{
      plan_code: string; current_period_start: string; current_period_end: string; status: string
      period_plan_code: string | null; period_covered_plan_code: string | null
    }>(
      `SELECT plan_code, current_period_start::text, current_period_end::text, status, period_plan_code, period_covered_plan_code
         FROM control_plane.subscriptions WHERE tenant_id = $1 FOR UPDATE`, [tenantId])).rows[0]
    // What the customer has already paid for through the end of this period: the plan in
    // force, or the priciest plan an earlier top-up covered.
    const coveredCode = sub ? (sub.period_covered_plan_code ?? sub.plan_code) : undefined
    const covered = coveredCode
      ? (await client.query<Plan>(
        `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits
           FROM control_plane.plans WHERE code = $1`, [coveredCode])).rows[0]
      : undefined

    // A company still on trial has paid nothing for this period, so there is nothing to top
    // up; its first period is billed at the plan it chose. Otherwise the period stays billed
    // at the plan it started on and the new plan starts at the next one.
    const trialing = !sub || sub.status === 'trialing'
    const periodPlan = trialing ? null : (sub!.period_plan_code ?? sub!.plan_code)

    let prorata: { subtotalPaise: bigint; gstPaise: bigint; totalPaise: bigint } | undefined
    let daysRemaining = 0
    let daysInPeriod = 1
    if (sub && covered && !trialing) {
      const day = 86_400_000
      const today = Date.parse((await client.query<{ d: string }>('SELECT CURRENT_DATE::text AS d')).rows[0]!.d)
      daysRemaining = Math.max(0, Math.round((Date.parse(sub.current_period_end) - today) / day))
      daysInPeriod = Math.max(1, Math.round((Date.parse(sub.current_period_end) - Date.parse(sub.current_period_start)) / day))
      prorata = prorationFor(covered, plan, employees, daysRemaining, daysInPeriod)
    }
    const toppedUp = prorata !== undefined && prorata.totalPaise > 0n

    await client.query(
      `UPDATE control_plane.subscriptions
          SET plan_code = $2, status = CASE WHEN status = 'trialing' THEN 'active' ELSE status END, trial_ends_on = NULL,
              period_plan_code = $3, period_covered_plan_code = $4
        WHERE tenant_id = $1`,
      [tenantId, planCode, periodPlan, trialing ? null : (toppedUp ? planCode : (sub!.period_covered_plan_code ?? null))])
    await projectEntitlements(client, tenantId)

    if (sub && prorata && toppedUp) {
      const number = await nextInvoiceNumber(client, tenantId, sub.current_period_end)
      await client.query(
        `INSERT INTO control_plane.invoices
           (tenant_id, number, period_start, period_end, plan_code, employees, base_paise, per_employee_paise,
            subtotal_paise, gst_rate, gst_paise, total_paise, due_on, kind)
         VALUES ($1,$2,CURRENT_DATE,$3::date,$4,$5,0,0,$6,$7,$8,$9, CURRENT_DATE + $10::int, 'proration')`,
        [tenantId, number, sub.current_period_end, planCode, employees,
         prorata.subtotalPaise.toString(), effectiveGstRate(), prorata.gstPaise.toString(),
         prorata.totalPaise.toString(), DUE_DAYS])
      await client.query(
        `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('subscription.prorated', $1, $2::jsonb)`,
        [tenantId, JSON.stringify({ invoice: number, from: covered!.code, to: planCode, daysRemaining, daysInPeriod, totalPaise: prorata.totalPaise.toString() })])
    }
    await client.query(
      `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('subscription.plan_changed', $1, $2::jsonb)`,
      [tenantId, JSON.stringify({ planCode, employees })])
    await client.query('COMMIT')
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
  return billingSummary(tenantId)
}

export interface Invoice {
  id: string; number: string; period_start: string; period_end: string; plan_code: string; employees: number
  base_paise: string; per_employee_paise: string; subtotal_paise: string; gst_rate: string; gst_paise: string; total_paise: string
  status: string; due_on: string; paid_at: string | null; payment_reference: string | null
}

export async function listInvoices(tenantId: string): Promise<Invoice[]> {
  const { rows } = await controlDb.query<Invoice>(
    `SELECT id, number, period_start::text, period_end::text, plan_code, employees,
            base_paise::text, per_employee_paise::text, subtotal_paise::text, gst_rate::text, gst_paise::text, total_paise::text,
            status, due_on::text, paid_at::text, payment_reference
       FROM control_plane.invoices WHERE tenant_id = $1 ORDER BY period_start DESC`, [tenantId])
  return rows
}

/**
 * Closes a subscription period that has ended: writes the invoice for it and
 * opens the next period. Idempotent per (tenant, period_start). A trial that
 * has ended with no plan chosen is not invoiced; it is suspended by dunning.
 */
export async function closePeriods(now = new Date()): Promise<{ invoiced: number; skipped: number }> {
  const today = now.toISOString().slice(0, 10)
  // The period is billed at the plan it STARTED on: a mid-period switch either paid a
  // top-up (upgrade) or waits for the next period (downgrade), so billing the period at the
  // plan in force at its end counted an upgrade twice and applied a downgrade retroactively.
  const { rows: due } = await controlDb.query<{ tenant_id: string; plan_code: string; current_period_start: string; current_period_end: string; status: string }>(
    `SELECT tenant_id, coalesce(period_plan_code, plan_code) AS plan_code, current_period_start::text, current_period_end::text, status
       FROM control_plane.subscriptions WHERE current_period_end <= $1 AND status IN ('active','past_due')`, [today])
  let invoiced = 0; let skipped = 0
  for (const s of due) {
    const client = await controlDb.connect()
    try {
      await client.query('BEGIN')
      const plan = (await client.query<Plan>(
        `SELECT code, name, base_price_paise::text, per_employee_price_paise::text, features, limits FROM control_plane.plans WHERE code = $1`,
        [s.plan_code])).rows[0]!
      const employees = Number((await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM employees WHERE tenant_id = $1 AND status <> 'exited'`, [s.tenant_id])).rows[0]!.n)
      const p = priceFor(plan, employees)
      const number = await nextInvoiceNumber(client, s.tenant_id, s.current_period_end)
      const ins = await client.query(
        `INSERT INTO control_plane.invoices
           (tenant_id, number, period_start, period_end, plan_code, employees, base_paise, per_employee_paise,
            subtotal_paise, gst_rate, gst_paise, total_paise, status, due_on, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::bigint, CASE WHEN $12::bigint = 0 THEN 'paid' ELSE 'due' END, $4::date + $13::int, 'period')
         ON CONFLICT (tenant_id, period_start) WHERE kind = 'period' DO NOTHING`,
        [s.tenant_id, number, s.current_period_start, s.current_period_end, plan.code, employees,
         plan.base_price_paise, plan.per_employee_price_paise, String(p.subtotal), effectiveGstRate(), String(p.gst), String(p.total), DUE_DAYS])
      // Roll the period forward by a month from its end, whatever today is.
      await client.query(
        `UPDATE control_plane.subscriptions
            SET current_period_start = current_period_end,
                current_period_end = (current_period_end + interval '1 month')::date,
                period_plan_code = NULL, period_covered_plan_code = NULL
          WHERE tenant_id = $1`, [s.tenant_id])
      await projectEntitlements(client, s.tenant_id)
      await client.query('COMMIT')
      if (ins.rowCount) invoiced++; else skipped++
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      client.release()
    }
  }
  return { invoiced, skipped }
}

/**
 * `INV/26-27/00001`.
 *
 * CGST Rule 46(b): consecutive, unique within the FINANCIAL year, letters,
 * digits, '-' and '/' only, and at most SIXTEEN characters. The old form was
 * `INV-2026-ABCDEF-00001` -- twenty-one -- so every invoice PEPL could issue
 * breached the length limit, and the year came off the period end as a CALENDAR
 * year, which is not the unit the rule is about.
 *
 * One supplier-wide series per financial year rather than one per customer.
 * Multiple series are permitted, but one is easier to defend and PEPL is one
 * supplier. The tenant id is not in the number; the invoice row already says
 * whose it is.
 */
async function nextInvoiceNumber(client: pg.PoolClient, _tenantId: string, periodEnd: string): Promise<string> {
  const fy = financialYear(periodEnd)
  const { rows } = await client.query<{ next: number }>(
    `INSERT INTO control_plane.document_series (kind, fy, next) VALUES ('invoice', $1, 2)
     ON CONFLICT (kind, fy) DO UPDATE SET next = control_plane.document_series.next + 1
     RETURNING next - 1 AS next`, [fy])
  return `INV/${fy}/${String(rows[0]!.next).padStart(5, '0')}`
}

/**
 * Dunning. Trial over with no plan → suspended. Oldest unpaid invoice 15 days
 * past due → past_due (a banner, nothing removed); 45 days → suspended, which
 * the entitlement projection turns into every module off. Payment reverses it.
 */
export async function runDunning(now = new Date()): Promise<{ pastDue: number; suspended: number; reactivated: number }> {
  const today = now.toISOString().slice(0, 10)
  const r1 = await controlDb.query(
    `UPDATE control_plane.subscriptions SET status = 'suspended', suspension_cause = 'automatic'
      WHERE status = 'trialing' AND trial_ends_on IS NOT NULL AND trial_ends_on < $1::date RETURNING tenant_id`, [today])
  const r2 = await controlDb.query(
    `UPDATE control_plane.subscriptions s SET status = 'past_due'
      WHERE s.status = 'active' AND EXISTS (
        SELECT 1 FROM control_plane.invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'due' AND i.due_on + $2::int < $1::date)
      RETURNING tenant_id`, [today, PAST_DUE_AFTER_DAYS])
  const r3 = await controlDb.query(
    `UPDATE control_plane.subscriptions s SET status = 'suspended', suspension_cause = 'automatic'
      WHERE s.status IN ('active','past_due') AND EXISTS (
        SELECT 1 FROM control_plane.invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'due' AND i.due_on + $2::int < $1::date)
      RETURNING tenant_id`, [today, SUSPEND_AFTER_DAYS])
  // Lifts only what THIS job put there. "Suspended, trial over, nothing owed" is equally
  // true of a customer an operator suspended on purpose -- a dispute, an abuse complaint,
  // a request to be paused -- and the job used to switch them back on the next night.
  // A row with no recorded cause counts as an operator's decision, not as the job's.
  const r4 = await controlDb.query(
    `UPDATE control_plane.subscriptions s SET status = 'active', suspension_cause = NULL
      WHERE (s.status = 'past_due' OR (s.status = 'suspended' AND s.suspension_cause = 'automatic'))
        AND s.trial_ends_on IS NULL
        AND NOT EXISTS (SELECT 1 FROM control_plane.invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'due')
      RETURNING tenant_id`)
  const touched = new Set([...r1.rows, ...r2.rows, ...r3.rows, ...r4.rows].map((r: { tenant_id: string }) => r.tenant_id))
  for (const t of touched) await projectEntitlements(controlDb, t)
  return { pastDue: r2.rowCount ?? 0, suspended: (r1.rowCount ?? 0) + (r3.rowCount ?? 0), reactivated: r4.rowCount ?? 0 }
}

/**
 * An invoice raised in error. Voiding rather than deleting, because an invoice
 * number that vanishes is a hole in a sequence a CFO will ask about — and
 * because dunning must stop chasing it. A paid invoice is never voided; that is
 * a credit note, which is a different document.
 */
export async function voidInvoice(invoiceId: string, reason: string): Promise<Invoice> {
  const { rows } = await controlDb.query<Invoice & { tenant_id: string }>(
    `UPDATE control_plane.invoices SET status = 'void'
      WHERE id = $1 AND status = 'due'
      RETURNING tenant_id, id, number, period_start::text, period_end::text, plan_code, employees, base_paise::text, per_employee_paise::text,
                subtotal_paise::text, gst_rate::text, gst_paise::text, total_paise::text, status, due_on::text, paid_at::text, payment_reference`,
    [invoiceId])
  if (!rows[0]) throw new ControlPlaneError('INVOICE_NOT_FOUND', 'no such unpaid invoice; a paid invoice is reversed with a credit note')
  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('invoice.voided', $1, $2::jsonb)`,
    [rows[0].tenant_id, JSON.stringify({ invoice: rows[0].number, reason })])
  // The debt is gone, so a company suspended only for this invoice comes back.
  await runDunning()
  return rows[0]
}

/** Operator action (or a gateway webhook): the invoice is settled. Dunning reactivates on its next pass. */
export async function markInvoicePaid(invoiceId: string, reference: string): Promise<Invoice> {
  const { rows } = await controlDb.query<Invoice & { tenant_id: string }>(
    `UPDATE control_plane.invoices SET status = 'paid', paid_at = now(), payment_reference = $2
      WHERE id = $1 AND status = 'due'
      RETURNING tenant_id, id, number, period_start::text, period_end::text, plan_code, employees, base_paise::text, per_employee_paise::text,
                subtotal_paise::text, gst_rate::text, gst_paise::text, total_paise::text, status, due_on::text, paid_at::text, payment_reference`,
    [invoiceId, reference.trim().slice(0, 120)])
  if (!rows[0]) throw new ControlPlaneError('INVOICE_NOT_FOUND', 'no such unpaid invoice')
  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('invoice.paid', $1, $2::jsonb)`,
    [rows[0].tenant_id, JSON.stringify({ invoice: rows[0].number, reference })])
  await runDunning()
  return rows[0]
}

/** A verification token for the signup email (stored hashed by the caller if needed). */
export const signupToken = (): string => randomBytes(24).toString('base64url')
