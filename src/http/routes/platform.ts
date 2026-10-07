/**
 * The operator console's API.
 *
 * Mounted under /api/platform, deliberately not /api/v1: nothing a customer's
 * session carries can reach these, and nothing here goes through `authed()`,
 * which resolves a TENANT session. The two authentication paths never meet.
 *
 * Every route below is the same operation the `npm run ops` CLI performs, on
 * the same control-plane functions, recorded in the same platform_audit. The
 * console is a second door onto one back office rather than a parallel one —
 * so a fix to the rules cannot apply to only half of it.
 *
 * What is NOT here, on purpose: any route that reads a customer's own data.
 * An operator can see that a company has 47 employees and owes one invoice.
 * They cannot see who those employees are or what they are paid. Reaching
 * inside a tenant requires that tenant's consent, which is what the existing
 * support-access grant is for.
 */
import { randomBytes } from 'node:crypto'
import type { Router } from '../router.ts'
import { HttpError, ok, created, requireBody, asUuid, type Req } from './deps.ts'
import type { Res } from '../router.ts'
import {
  platformLogin, requirePlatformSession, resolvePlatformSession, revokePlatformSession,
  beginPlatformMfa, verifyPlatformMfa, listPlatformUsers, PlatformAuthError,
} from '../../control-plane/platform-auth.ts'
import { controlDb, setSubscriptionStatus } from '../../control-plane/index.ts'
import {
  signup, listPlans, listInvoices, markInvoicePaid, voidInvoice,
  billingSummary, switchPlan, closePeriods, runDunning, priceFor, updateBillingDetails,
} from '../../control-plane/billing.ts'
import { issueCreditNote, listCreditNotes } from '../../control-plane/credit-notes.ts'
import { listPresets } from '../../control-plane/presets.ts'
import { invoicePdf } from '../../control-plane/invoice-pdf.ts'

const bearer = (req: Req): string | undefined => {
  const h = String(req.headers.authorization ?? '')
  return h.startsWith('Bearer ') ? h.slice(7) : undefined
}

/** Wraps a handler so it runs only for a signed-in, second-factor-verified operator. */
const staff = (handler: (req: Req, session: Awaited<ReturnType<typeof requirePlatformSession>>) => Promise<Res>) =>
  async (req: Req): Promise<Res> => {
    try {
      const session = await requirePlatformSession(bearer(req))
      return await handler(req, session)
    } catch (e) {
      if (e instanceof PlatformAuthError) throw new HttpError(e.status, e.code, e.message)
      throw e
    }
  }

export function register(router: Router): void {
  // ── signing in ─────────────────────────────────────────────────────────────

  router.post('/api/platform/login',
    { summary: 'PEPL staff sign-in. Not a customer login; a different identity store entirely',
      tag: 'platform', public: true },
    async (req: Req) => {
      const b = requireBody<{ email: string; password: string }>(req, ['email', 'password'])
      try {
        const s = await platformLogin({
          email: b.email, password: b.password,
          ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
        })
        return ok({
          token: s.token, expiresAt: s.expiresAt.toISOString(),
          user: s.user, mfaPending: s.mfaPending,
        })
      } catch (e) {
        if (e instanceof PlatformAuthError) throw new HttpError(e.status, e.code, e.message)
        throw e
      }
    })

  router.post('/api/platform/logout',
    { summary: 'End this operator session', tag: 'platform', public: true },
    async (req: Req) => {
      const token = bearer(req)
      if (token) {
        const s = await resolvePlatformSession(token).catch(() => null)
        if (s) await revokePlatformSession(s.sessionId)
      }
      return ok({ signedOut: true })
    })

  // Deliberately reachable with a session whose second factor is still pending:
  // enrolling IS the thing they need to do, and locking them out of it would
  // make the requirement unsatisfiable.
  router.post('/api/platform/mfa/enrol',
    { summary: 'Begin second-factor enrolment', tag: 'platform', public: true },
    async (req: Req) => {
      const token = bearer(req)
      if (!token) throw new HttpError(401, 'MISSING_TOKEN', 'sign in first')
      const s = await resolvePlatformSession(token)
      return ok(await beginPlatformMfa(s.user.id, s.user.email))
    })

  router.post('/api/platform/mfa/verify',
    { summary: 'Verify a code and open this session', tag: 'platform', public: true },
    async (req: Req) => {
      const token = bearer(req)
      if (!token) throw new HttpError(401, 'MISSING_TOKEN', 'sign in first')
      const b = requireBody<{ code: string }>(req, ['code'])
      try {
        await verifyPlatformMfa({ token, code: b.code })
        return ok({ verified: true })
      } catch (e) {
        if (e instanceof PlatformAuthError) throw new HttpError(e.status, e.code, e.message)
        throw e
      }
    })

  router.get('/api/platform/me',
    { summary: 'The signed-in operator', tag: 'platform', public: true },
    async (req: Req) => {
      const token = bearer(req)
      if (!token) throw new HttpError(401, 'MISSING_TOKEN', 'sign in first')
      const s = await resolvePlatformSession(token)
      return ok({ user: s.user, mfaPending: s.mfaPending })
    })

  // ── the book of customers ──────────────────────────────────────────────────

  router.get('/api/platform/tenants',
    { summary: 'Every company, its plan and its headcount', tag: 'platform', public: true },
    staff(async () => {
      const { rows } = await controlDb.query(
        `SELECT t.id, t.legal_name, t.display_name, t.status, t.is_sandbox,
                s.plan_code, s.status AS subscription_status, s.trial_ends_on::text,
                (SELECT count(*)::int FROM employees e WHERE e.tenant_id = t.id) AS employees,
                t.created_at::text
           FROM tenants t
           LEFT JOIN control_plane.subscriptions s ON s.tenant_id = t.id
          ORDER BY t.is_sandbox, t.created_at DESC`)
      return ok({ tenants: rows })
    }))

  router.get('/api/platform/tenants/:id',
    { summary: 'One company: plan, period, headcount, what is outstanding', tag: 'platform', public: true },
    staff(async (req) => {
      const id = asUuid(req.params.id, 'id')
      const { rows } = await controlDb.query(
        `SELECT id, legal_name, display_name, status, is_sandbox, created_at::text FROM tenants WHERE id = $1`, [id])
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'no such company')
      return ok({
        tenant: rows[0],
        billing: await billingSummary(id),
        invoices: await listInvoices(id),
        creditNotes: await listCreditNotes(id),
      })
    }))

  router.post('/api/platform/tenants',
    { summary: 'Open an account for a customer', tag: 'platform', public: true,
      requestExample: { legalName: 'Vindhya Textiles Pvt Ltd', adminEmail: 'ops@vindhya.com', adminName: 'Lata Rao', planCode: 'growth', stateCode: 'TS', activate: true } },
    staff(async (req, session) => {
      const b = requireBody<{
        legalName: string; displayName?: string; adminEmail: string; adminName: string
        planCode?: string; stateCode?: string; organisationType?: string; activate?: boolean
      }>(req, ['legalName', 'adminEmail', 'adminName'])

      // Generated here, shown once, never stored anywhere else — the operator
      // reads it out to the customer, who changes it at first sign-in.
      const password = `pepl-${randomBytes(6).toString('base64url')}-${randomBytes(3).toString('base64url')}`
      const planCode = b.planCode ?? 'trial'
      const { tenantId } = await signup({
        legalName: b.legalName, displayName: b.displayName ?? b.legalName,
        adminEmail: b.adminEmail, adminName: b.adminName, password,
        stateCode: b.stateCode, planCode, organisationType: b.organisationType,
      })
      if (b.activate) {
        await switchPlan(tenantId, planCode)
        await setSubscriptionStatus(tenantId, 'active')
        await controlDb.query(
          `UPDATE control_plane.subscriptions SET trial_ends_on = NULL WHERE tenant_id = $1`, [tenantId])
      }
      await controlDb.query(
        `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('platform.tenant.created', $1, $2::jsonb)`,
        [tenantId, JSON.stringify({ by: session.user.email, planCode, activated: !!b.activate })])
      return created({ tenantId, adminEmail: b.adminEmail, password, planCode })
    }))

  router.post('/api/platform/tenants/:id/plan',
    { summary: 'Move a company onto the plan that was sold', tag: 'platform', public: true,
      requestExample: { planCode: 'professional' } },
    staff(async (req, session) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ planCode: string }>(req, ['planCode'])
      const summary = await switchPlan(id, b.planCode).then(() => billingSummary(id))
      await controlDb.query(
        `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('platform.plan.changed', $1, $2::jsonb)`,
        [id, JSON.stringify({ by: session.user.email, planCode: b.planCode })])
      return ok(summary)
    }))

  router.post('/api/platform/tenants/:id/status',
    { summary: 'Suspend or reactivate a company. Modules go off; nothing is deleted',
      tag: 'platform', public: true, requestExample: { status: 'suspended', reason: 'non-payment' } },
    staff(async (req, session) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ status: string; reason?: string }>(req, ['status'])
      if (b.status !== 'suspended' && b.status !== 'active') {
        throw new HttpError(422, 'VALIDATION_FAILED', 'status must be active or suspended')
      }
      await setSubscriptionStatus(id, b.status)
      await controlDb.query(
        `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('platform.status.changed', $1, $2::jsonb)`,
        [id, JSON.stringify({ by: session.user.email, status: b.status, reason: b.reason ?? null })])
      return ok(await billingSummary(id))
    }))

  router.patch('/api/platform/tenants/:id/billing-details',
    { summary: 'GSTIN, address and place of supply. Without the last one every invoice carries IGST',
      tag: 'platform', public: true, requestExample: { gstin: '36AAAAA0000A1Z5', stateCode: 'TS' } },
    staff(async (req) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ gstin?: string; address?: string; email?: string; stateCode?: string }>(req, [])
      await updateBillingDetails(id, b)
      return ok(await billingSummary(id))
    }))

  // ── money ──────────────────────────────────────────────────────────────────

  router.post('/api/platform/invoices/:id/pay',
    { summary: 'Record a transfer against an invoice', tag: 'platform', public: true,
      requestExample: { reference: 'NEFT UTR SBIN426100234891' } },
    staff(async (req, session) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ reference: string }>(req, ['reference'])
      const paid = await markInvoicePaid(id, b.reference)
      // markInvoicePaid already records the payment itself; this second line
      // records WHO, which the CLI cannot know and the console can.
      await controlDb.query(
        `INSERT INTO control_plane.platform_audit (action, tenant_id, detail)
         SELECT 'platform.invoice.paid', i.tenant_id, $2::jsonb
           FROM control_plane.invoices i WHERE i.id = $1`,
        [id, JSON.stringify({ by: session.user.email, invoice: paid.number })])
      return ok(paid)
    }))

  router.post('/api/platform/invoices/:id/void',
    { summary: 'Void an UNPAID invoice raised in error. A paid one needs a credit note',
      tag: 'platform', public: true, requestExample: { reason: 'billed on the wrong headcount' } },
    staff(async (req) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ reason: string }>(req, ['reason'])
      return ok(await voidInvoice(id, b.reason))
    }))

  router.post('/api/platform/invoices/:id/credit',
    { summary: 'Reduce a PAID invoice with a credit note', tag: 'platform', public: true,
      requestExample: { reason: 'agreed goodwill adjustment', amountRupees: 2500 } },
    staff(async (req) => {
      const id = asUuid(req.params.id, 'id')
      const b = requireBody<{ reason: string; amountRupees?: number }>(req, ['reason'])
      return ok(await issueCreditNote({
        invoiceId: id, reason: b.reason,
        subtotalPaise: b.amountRupees === undefined ? undefined : Math.round(b.amountRupees * 100),
      }))
    }))

  router.get('/api/platform/invoices/:id/pdf',
    { summary: 'The GST tax invoice', tag: 'platform', public: true },
    staff(async (req) => {
      const pdf = await invoicePdf(asUuid(req.params.id, 'id'))
      return ok({
        fileName: pdf.fileName, contentType: 'application/pdf',
        sizeBytes: pdf.bytes.length, contentBase64: pdf.bytes.toString('base64'),
      })
    }))

  router.post('/api/platform/billing/close-periods',
    { summary: 'Raise invoices for every period that has ended', tag: 'platform', public: true },
    staff(async () => ok(await closePeriods())))

  router.post('/api/platform/billing/dunning',
    { summary: 'Apply the overdue, suspend and reactivate rules', tag: 'platform', public: true },
    staff(async () => ok(await runDunning())))

  router.get('/api/platform/revenue',
    { summary: 'MRR by plan, excluding trials and sandboxes', tag: 'platform', public: true },
    staff(async () => {
      const { rows } = await controlDb.query<{ plan_code: string; status: string; tenants: number; employees: number }>(
        `SELECT s.plan_code, s.status, count(*)::int AS tenants,
                coalesce(sum((SELECT count(*) FROM employees e WHERE e.tenant_id = s.tenant_id)), 0)::int AS employees
           FROM control_plane.subscriptions s
           JOIN tenants t ON t.id = s.tenant_id AND NOT t.is_sandbox
          GROUP BY s.plan_code, s.status ORDER BY s.plan_code, s.status`)
      const plans = new Map((await listPlans()).map((p) => [p.code, p]))
      let mrrPaise = 0n
      const lines = rows.map((r) => {
        const plan = plans.get(r.plan_code)
        const billed = r.status === 'active' || r.status === 'past_due'
        const value = plan && billed ? priceFor(plan, r.employees).subtotal : 0n
        mrrPaise += value
        return { ...r, monthlyPaise: String(value) }
      })
      return ok({ lines, mrrPaise: String(mrrPaise) })
    }))

  router.get('/api/platform/plans',
    { summary: 'The plans on sale', tag: 'platform', public: true },
    staff(async () => ok({ plans: await listPlans() })))

  // The organisation types a company can be opened as. The console used to carry
  // its own list of five -- company, ngo, school, hospital, government -- none of
  // which the server knew, so choosing one (or leaving the default) stranded a
  // half-built company. The server owns the list; the console asks.
  router.get('/api/platform/presets',
    { summary: 'The organisation types a company can be opened as', tag: 'platform', public: true },
    staff(async () => ok({ presets: listPresets() })))

  router.get('/api/platform/staff',
    { summary: 'Who can sign in to this console', tag: 'platform', public: true },
    staff(async () => ok({ staff: await listPlatformUsers() })))
}
