/** Contractor workforce: terms, invoices with TDS, the 26Q register; statutory bonus arithmetic. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, asDate, asInt, assertScope, emit } from './deps.ts'
import { scopeIds } from '../ui-data.ts'
import { setTerms, getTerms, listContractors, removeTerms, submitInvoice, getInvoice, listInvoices, decideInvoice, markInvoicePaid, tdsRegister26Q, statutoryBonus, type TdsSection, type EntityType } from '../../payroll/contractors.ts'

export function register(router: Router): void {
  router.get('/api/v1/contractors', { summary: 'People paid on invoice, with their terms', tag: 'contractors', permission: 'contractor.read' },
    authed('contractor.read', async (ctx) => { requireModule(ctx, 'payroll.enabled'); return ok({ contractors: await listContractors(ctx.tx, scopeIds(ctx)) }) }))

  router.get('/api/v1/contractors/:employeeId', { summary: 'One contractor\'s terms and invoices', tag: 'contractors', permission: 'contractor.read' },
    authed('contractor.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const e = asUuid(ctx.req.params.employeeId, 'employeeId'); assertScope(ctx.auth, e)
      const terms = await getTerms(ctx.tx, e)
      if (!terms) throw new HttpError(404, 'NOT_FOUND', 'not a contractor')
      return ok({ terms, invoices: await listInvoices(ctx.tx, { employeeId: e }) })
    }))

  router.patch('/api/v1/contractors/:employeeId', { summary: 'Set or update contractor terms: PAN/GSTIN, TDS section, rate. Takes the person OFF the payroll run.', tag: 'contractors', permission: 'contractor.manage',
    requestExample: { pan: 'ABCPE1234F', tdsSection: '194J', rateType: 'monthly', ratePaise: 8000000, invoiceRequired: true, contractStart: '2026-10-01', contractEnd: '2027-03-31' } },
    authed('contractor.manage', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const e = asUuid(ctx.req.params.employeeId, 'employeeId'); assertScope(ctx.auth, e)
      const b = (ctx.req.body ?? {}) as { pan?: string | null; gstin?: string | null; entityType?: EntityType; tdsSection?: TdsSection; tdsRatePct?: number | null; rateType?: 'monthly' | 'daily' | 'hourly' | 'per_unit' | 'fixed'; ratePaise?: number; invoiceRequired?: boolean; contractStart?: string | null; contractEnd?: string | null; notes?: string | null }
      if (b.tdsSection && !['194C', '194J', '194H', 'none'].includes(b.tdsSection)) throw new HttpError(422, 'VALIDATION_FAILED', 'tdsSection is 194C, 194J, 194H or none')
      const t = await setTerms(ctx.tx, { employeeId: e, ...b, ratePaise: b.ratePaise === undefined ? undefined : asInt(b.ratePaise, 'ratePaise', { min: 0 }), contractStart: b.contractStart ? asDate(b.contractStart, 'contractStart') : b.contractStart, contractEnd: b.contractEnd ? asDate(b.contractEnd, 'contractEnd') : b.contractEnd })
      await emit(ctx.tx, { action: 'contractor.terms.set', entityType: 'employee', entityId: e, actorUserId: ctx.auth.userId, subjectEmployeeId: e, metadata: { section: t.tds_section, rateType: t.rate_type } })
      return ok(t)
    }))

  router.del('/api/v1/contractors/:employeeId', { summary: 'Remove contractor terms (no open invoices)', tag: 'contractors', permission: 'contractor.manage' },
    authed('contractor.manage', async (ctx) => { requireModule(ctx, 'payroll.enabled'); const e = asUuid(ctx.req.params.employeeId, 'employeeId'); assertScope(ctx.auth, e); await removeTerms(ctx.tx, e); return noContent() }))

  router.get('/api/v1/contractor-invoices', { summary: 'Invoices (?employeeId=&status=&from=&to=)', tag: 'contractors', permission: 'contractor.read' },
    authed('contractor.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const employeeId = ctx.req.query.get('employeeId') ? asUuid(ctx.req.query.get('employeeId'), 'employeeId') : undefined
      if (employeeId) assertScope(ctx.auth, employeeId)
      return ok({ invoices: await listInvoices(ctx.tx, { employeeIds: scopeIds(ctx), employeeId, status: ctx.req.query.get('status') ?? undefined, from: ctx.req.query.get('from') ? asDate(ctx.req.query.get('from'), 'from') : undefined, to: ctx.req.query.get('to') ? asDate(ctx.req.query.get('to'), 'to') : undefined }) })
    }))

  router.post('/api/v1/contractor-invoices', { summary: 'Record an invoice (HR/finance, or the contractor for themself); TDS is computed from the section, entity and FY threshold', tag: 'contractors', permission: undefined,
    requestExample: { employeeId: '…', invoiceNo: 'INV-042', invoiceDate: '2026-10-31', periodStart: '2026-10-01', periodEnd: '2026-10-31', amountPaise: 8000000, gstPaise: 1440000, documentId: '…' } },
    authed(null, async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ employeeId?: string; invoiceNo: string; invoiceDate: string; periodStart: string; periodEnd: string; description?: string; units?: number; amountPaise?: number; gstPaise?: number; documentId?: string }>(ctx.req, ['invoiceNo', 'invoiceDate', 'periodStart', 'periodEnd'])
      const e = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!e) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (e !== ctx.auth.employeeId) { if (!ctx.auth.permissions.has('contractor.manage')) throw new HttpError(403, 'PERMISSION_DENIED', 'only HR/finance files for someone else'); assertScope(ctx.auth, e) }
      const inv = await submitInvoice(ctx.tx, { employeeId: e, invoiceNo: b.invoiceNo, invoiceDate: asDate(b.invoiceDate, 'invoiceDate'), periodStart: asDate(b.periodStart, 'periodStart'), periodEnd: asDate(b.periodEnd, 'periodEnd'), description: b.description, units: b.units, amountPaise: b.amountPaise === undefined ? undefined : asInt(b.amountPaise, 'amountPaise', { min: 1 }), gstPaise: b.gstPaise === undefined ? undefined : asInt(b.gstPaise, 'gstPaise', { min: 0 }), documentId: b.documentId ? asUuid(b.documentId, 'documentId') : null, submittedByUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'contractor.invoice.submitted', entityType: 'contractor_invoice', entityId: inv.id, actorUserId: ctx.auth.userId, subjectEmployeeId: e, metadata: { invoiceNo: inv.invoice_no, amount: inv.amount_paise, tds: inv.tds_paise } })
      return created(inv)
    }))

  router.post('/api/v1/contractor-invoices/:id/decide', { summary: 'Approve (TDS recomputed against the FY threshold) or reject with a reason', tag: 'contractors', permission: 'contractor.manage', requestExample: { status: 'approved' } },
    authed('contractor.manage', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ status: 'approved' | 'rejected'; reason?: string }>(ctx.req, ['status'])
      if (!['approved', 'rejected'].includes(b.status)) throw new HttpError(422, 'VALIDATION_FAILED', 'status is approved or rejected')
      const before = await getInvoice(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!before) throw new HttpError(404, 'NOT_FOUND', 'no such invoice')
      assertScope(ctx.auth, before.employee_id)
      const inv = await decideInvoice(ctx.tx, { id: before.id, status: b.status, reason: b.reason, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'contractor.invoice.decided', entityType: 'contractor_invoice', entityId: inv.id, actorUserId: ctx.auth.userId, subjectEmployeeId: inv.employee_id, reason: b.reason, metadata: { status: inv.status, tds: inv.tds_paise, net: inv.net_paise } })
      return ok(inv)
    }))

  router.post('/api/v1/contractor-invoices/:id/paid', { summary: 'Mark paid with the bank reference', tag: 'contractors', permission: 'contractor.pay', requestExample: { paymentRef: 'UTR 1234567890', paidOn: '2026-11-05' } },
    authed('contractor.pay', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ paymentRef: string; paidOn?: string }>(ctx.req, ['paymentRef'])
      const inv = await markInvoicePaid(ctx.tx, { id: asUuid(ctx.req.params.id, 'id'), paymentRef: b.paymentRef, paidOn: b.paidOn ? asDate(b.paidOn, 'paidOn') : undefined })
      await emit(ctx.tx, { action: 'contractor.invoice.paid', entityType: 'contractor_invoice', entityId: inv.id, actorUserId: ctx.auth.userId, subjectEmployeeId: inv.employee_id, metadata: { paymentRef: inv.payment_ref, net: inv.net_paise } })
      return ok(inv)
    }))

  router.get('/api/v1/reports/tds-26q', { summary: 'TDS on contractor payments for a window (?from=&to=), by deductee and section — the 26Q feed; flags missing PANs', tag: 'reports', permission: 'contractor.read' },
    authed('contractor.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'the register is company-wide')
      return ok(await tdsRegister26Q(ctx.tx, { from: asDate(ctx.req.query.get('from'), 'from'), to: asDate(ctx.req.query.get('to'), 'to') }))
    }))

  router.post('/api/v1/payroll/bonus/compute', { summary: 'Payment of Bonus Act arithmetic for a list of people (no writes): eligibility and amount at the company rate', tag: 'payroll', permission: 'payroll.process',
    requestExample: { ratePct: 8.33, people: [{ employeeId: '…', monthlyWagePaise: 1500000, monthsWorked: 12, daysWorked: 280 }] } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ ratePct: number; minimumWagePaise?: number; people: Array<{ employeeId: string; monthlyWagePaise: number; monthsWorked: number; daysWorked: number }> }>(ctx.req, ['ratePct', 'people'])
      if (!Array.isArray(b.people) || b.people.length > 5000) throw new HttpError(422, 'VALIDATION_FAILED', 'people is a list of up to 5000')
      const rows = b.people.map((p) => ({ employeeId: asUuid(p.employeeId, 'employeeId'), ...statutoryBonus({ monthlyWagePaise: asInt(p.monthlyWagePaise, 'monthlyWagePaise', { min: 0 }), monthsWorked: Number(p.monthsWorked), daysWorked: Number(p.daysWorked), ratePct: Number(b.ratePct), minimumWagePaise: b.minimumWagePaise }) }))
      return ok({ ratePct: Math.min(20, Math.max(8.33, Number(b.ratePct))), rows, totalPaise: rows.reduce((s, r) => s + r.bonusPaise, 0), eligible: rows.filter((r) => r.eligible).length })
    }))
}
