/** Expenses and travel: categories (policy), claims, trips, and the approval hand-off. */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule, asDate, asUuid, asInt, assertScope, can, emit,
} from './deps.ts'
import {
  listCategories, upsertCategory, retireCategory, seedDefaultCategories,
  listClaims, getClaim, submitClaim, cancelClaim,
  listTrips, getTrip, requestTravel, settleTrip, listPerDiemRates, upsertPerDiemRate,
} from '../../work/expenses.ts'
import { scopeIds } from '../ui-data.ts'
import type { ChainCode } from '../../approvals/index.ts'

export function register(router: Router): void {
  router.get('/api/v1/expenses/per-diem-rates', { summary: 'Per-diem rates by city class and grade', tag: 'expenses', permission: 'expense.read' },
    authed('expense.read', async (ctx) => ok({ rates: await listPerDiemRates(ctx.tx) })))
  router.post('/api/v1/expenses/per-diem-rates', { summary: 'Set a per-diem rate (city class × grade, from a date)', tag: 'expenses', permission: 'expense.write',
    requestExample: { cityClass: 'metro', gradeCode: null, ratePaise: 200000, halfDayPct: 50 } },
    authed('expense.write', async (ctx) => {
      const b = requireBody<{ cityClass: string; gradeCode?: string | null; ratePaise: number; halfDayPct?: number; effectiveFrom?: string }>(ctx.req, ['cityClass', 'ratePaise'])
      return created(await upsertPerDiemRate(ctx.tx, { ...b, ratePaise: asInt(b.ratePaise, 'ratePaise', { min: 0 }), effectiveFrom: b.effectiveFrom ? asDate(b.effectiveFrom, 'effectiveFrom') : undefined }))
    }))

  router.get('/api/v1/expenses/categories',
    { summary: 'Expense categories with their policy (limits, receipt threshold, mileage rate)', tag: 'expenses', permission: 'expense.read' },
    authed('expense.read', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      await seedDefaultCategories(ctx.tx)
      return ok({ categories: await listCategories(ctx.tx, ctx.req.query.get('includeRetired') === 'true') })
    }))

  router.post('/api/v1/expenses/categories',
    { summary: 'Define or change a category and its policy', tag: 'expenses', permission: 'expense.policy.write',
      requestExample: { code: 'MEALS', name: 'Meals on duty', perClaimLimitPaise: 200000, monthlyLimitPaise: 1500000, receiptRequiredAbovePaise: 50000 } },
    authed('expense.policy.write', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      const b = requireBody<{ code: string; name: string; perClaimLimitPaise?: number | null; monthlyLimitPaise?: number | null; receiptRequiredAbovePaise?: number; mileageRatePaisePerKm?: number | null; taxable?: boolean }>(
        ctx.req, ['code', 'name'])
      const c = await upsertCategory(ctx.tx, b)
      await emit(ctx.tx, { action: 'expense.category.changed', entityType: 'expense_category', entityId: c.id, actorUserId: ctx.auth.userId, after: { code: c.code, perClaim: c.per_claim_limit_paise, monthly: c.monthly_limit_paise } })
      return created(c)
    }))

  router.post('/api/v1/expenses/categories/:id/retire',
    { summary: 'Retire a category; claims already filed keep it', tag: 'expenses', permission: 'expense.policy.write' },
    authed('expense.policy.write', async (ctx) => {
      await retireCategory(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      return ok({ retired: true })
    }))

  router.get('/api/v1/expenses/claims',
    { summary: 'Claims you may see (own, your reports, or everyone), newest first, paged', tag: 'expenses', permission: 'expense.read' },
    authed('expense.read', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok(await listClaims(ctx.tx, {
        employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, status: ctx.req.query.get('status') ?? undefined,
        from: ctx.req.query.get('from') ?? undefined, to: ctx.req.query.get('to') ?? undefined,
        limit: asInt(ctx.req.query.get('limit') ?? 50, 'limit', { min: 1, max: 200 }),
        offset: asInt(ctx.req.query.get('offset') ?? 0, 'offset', { min: 0, max: 100_000 }),
      }))
    }))

  router.get('/api/v1/expenses/claims/:id',
    { summary: 'One claim', tag: 'expenses', permission: 'expense.read' },
    authed('expense.read', async (ctx) => {
      const c = await getClaim(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'no such claim')
      assertScope(ctx.auth, c.employee_id)
      return ok(c)
    }))

  router.post('/api/v1/expenses/claims',
    { summary: 'Submit a claim (own, or for a report with expense.write); policy limits and duplicates are checked here', tag: 'expenses',
      permission: 'expense.claim',
      requestExample: { categoryId: '…', incurredOn: '2026-10-03', amountPaise: 45000, description: 'Cab to client site', merchant: 'Uber', receiptDocumentId: '…' } },
    authed('expense.claim', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      const b = requireBody<{
        employeeId?: string; categoryId: string; incurredOn: string; amountPaise?: number; distanceKm?: number; description: string
        merchant?: string; receiptDocumentId?: string; travelRequestId?: string; costCentre?: string; notADuplicate?: boolean
      }>(ctx.req, ['categoryId', 'incurredOn', 'description'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'expense.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'filing for someone else needs expense.write')
      assertScope(ctx.auth, employeeId)
      const r = await submitClaim(ctx.tx, {
        employeeId, requestedByUserId: ctx.auth.userId, categoryId: asUuid(b.categoryId, 'categoryId'),
        incurredOn: asDate(b.incurredOn, 'incurredOn'), amountPaise: b.amountPaise, distanceKm: b.distanceKm, description: b.description,
        merchant: b.merchant, receiptDocumentId: b.receiptDocumentId ? asUuid(b.receiptDocumentId, 'receiptDocumentId') : null,
        travelRequestId: b.travelRequestId ? asUuid(b.travelRequestId, 'travelRequestId') : null, costCentre: b.costCentre,
        notADuplicate: b.notADuplicate, fallbackChain: ctx.config.get<string>('expenses.approval_chain') as ChainCode,
      })
      await emit(ctx.tx, { action: 'expense.claim.submitted', entityType: 'expense_claim', entityId: r.claim.id, subjectEmployeeId: employeeId,
        actorUserId: ctx.auth.userId, metadata: { category: r.claim.category_code, amountPaise: r.claim.amount_paise } })
      return created({ claim: r.claim, approvalRequestId: r.approvalRequestId, chain: r.chain })
    }))

  router.post('/api/v1/expenses/claims/:id/cancel',
    { summary: 'Withdraw your own claim before it is paid', tag: 'expenses', permission: 'expense.claim' },
    authed('expense.claim', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const c = await getClaim(ctx.tx, id)
      if (!c) throw new HttpError(404, 'NOT_FOUND', 'no such claim')
      assertScope(ctx.auth, c.employee_id)
      await cancelClaim(ctx.tx, id, c.employee_id)
      await emit(ctx.tx, { action: 'expense.claim.cancelled', entityType: 'expense_claim', entityId: id, subjectEmployeeId: c.employee_id, actorUserId: ctx.auth.userId })
      return noContent()
    }))

  // ── travel ──
  router.get('/api/v1/travel',
    { summary: 'Trips you may see, with claimed vs advance balance', tag: 'expenses', permission: 'expense.read' },
    authed('expense.read', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      const employeeId = ctx.req.query.get('employeeId')
      if (employeeId) assertScope(ctx.auth, asUuid(employeeId, 'employeeId'))
      return ok({ trips: await listTrips(ctx.tx, { employeeIds: scopeIds(ctx), employeeId: employeeId ?? undefined, status: ctx.req.query.get('status') ?? undefined }) })
    }))

  router.post('/api/v1/travel',
    { summary: 'Request a trip, with an optional advance paid on the next payroll once approved', tag: 'expenses', permission: 'expense.claim',
      requestExample: { purpose: 'Client kickoff', destination: 'Mumbai', startsOn: '2026-11-03', endsOn: '2026-11-05', estimatedPaise: 2500000, advancePaise: 1000000 } },
    authed('expense.claim', async (ctx) => {
      requireModule(ctx, 'expenses.enabled')
      const b = requireBody<{ employeeId?: string; purpose: string; destination: string; startsOn: string; endsOn: string; estimatedPaise?: number; advancePaise?: number }>(
        ctx.req, ['purpose', 'destination', 'startsOn', 'endsOn'])
      const employeeId = b.employeeId ? asUuid(b.employeeId, 'employeeId') : ctx.auth.employeeId
      if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
      if (employeeId !== ctx.auth.employeeId && !can(ctx.auth, 'expense.write')) throw new HttpError(403, 'PERMISSION_DENIED', 'requesting for someone else needs expense.write')
      assertScope(ctx.auth, employeeId)
      const r = await requestTravel(ctx.tx, {
        employeeId, requestedByUserId: ctx.auth.userId, purpose: b.purpose, destination: b.destination,
        startsOn: asDate(b.startsOn, 'startsOn'), endsOn: asDate(b.endsOn, 'endsOn'), estimatedPaise: b.estimatedPaise, advancePaise: b.advancePaise,
        fallbackChain: ctx.config.get<string>('expenses.approval_chain') as ChainCode,
      })
      await emit(ctx.tx, { action: 'expense.travel.requested', entityType: 'travel_request', entityId: r.trip.id, subjectEmployeeId: employeeId, actorUserId: ctx.auth.userId,
        metadata: { destination: r.trip.destination, estimatedPaise: r.trip.estimated_paise, advancePaise: r.trip.advance_paise } })
      return created({ trip: r.trip, approvalRequestId: r.approvalRequestId })
    }))

  router.post('/api/v1/travel/:id/settle',
    { summary: 'Close a trip once its claims are in; an unspent advance is recovered on the next payroll', tag: 'expenses', permission: 'expense.claim' },
    authed('expense.claim', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const t = await getTrip(ctx.tx, id)
      if (!t) throw new HttpError(404, 'NOT_FOUND', 'no such trip')
      assertScope(ctx.auth, t.employee_id)
      const settled = await settleTrip(ctx.tx, id, t.employee_id)
      await emit(ctx.tx, { action: 'expense.travel.settled', entityType: 'travel_request', entityId: id, subjectEmployeeId: t.employee_id, actorUserId: ctx.auth.userId,
        metadata: { recoveryPaise: (settled as unknown as { recovery_paise?: string }).recovery_paise ?? '0', claimedPaise: settled.claimed_paise } })
      return ok(settled)
    }))
}
