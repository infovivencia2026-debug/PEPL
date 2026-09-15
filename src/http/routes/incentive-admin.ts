/**
 * Incentive administration. Plans are `incentive.write`; targets and sales
 * too, scoped to the people they name; reading is `incentive.read`.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, asUuid, asDate, assertScope, emit } from './deps.ts'
import {
  createPeriod, listPlans, listTargets, publishPlan, recordSales, retirePlan, setTargets,
  type CalcType, type SaleInput, type TargetInput,
} from '../../work/incentive-admin.ts'
import type { PlanConfig } from '../../work/incentives.ts'

export function register(router: Router): void {
  router.get('/api/v1/incentives/plans',
    { summary: 'Plans in force (?asOf=, ?includeClosed=true for every version)', tag: 'incentives', permission: 'incentive.read' },
    authed('incentive.read', async (ctx) => ok({
      plans: await listPlans(ctx.tx, { asOf: ctx.req.query.get('asOf') ?? undefined, includeClosed: ctx.req.query.get('includeClosed') === 'true' }),
    })))

  router.post('/api/v1/incentives/plans',
    { summary: 'Publish a plan version (a new version of an existing name closes the old one the day before)',
      tag: 'incentives', permission: 'incentive.write',
      requestExample: { name: 'Field sales', calcType: 'slab', effectiveFrom: '2026-11-01', config: { slabs: [
        { fromPct: 0, toPct: 80, ratePct: 0 }, { fromPct: 80, toPct: 100, ratePct: 0.02 }, { fromPct: 100, ratePct: 0.04 } ], capPaise: 5000000 } } },
    authed('incentive.write', async (ctx) => {
      const b = requireBody<{ name: string; metric?: string; calcType: CalcType; config: PlanConfig; prorationRule?: string; clawbackEnabled?: boolean; effectiveFrom: string }>(
        ctx.req, ['name', 'calcType', 'config', 'effectiveFrom'])
      const plan = await publishPlan(ctx.tx, { ...b, effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom') })
      await emit(ctx.tx, { action: 'incentive.plan.published', entityType: 'incentive_plan', entityId: plan.id,
        actorUserId: ctx.auth.userId, metadata: { name: plan.name, version: plan.version, calcType: plan.calc_type, effectiveFrom: plan.effective_from } })
      return created({ plan })
    }))

  router.post('/api/v1/incentives/plans/:name/retire',
    { summary: 'End a plan on a date; no version after it', tag: 'incentives', permission: 'incentive.write',
      requestExample: { lastDay: '2026-12-31' } },
    authed('incentive.write', async (ctx) => {
      const b = requireBody<{ lastDay: string }>(ctx.req, ['lastDay'])
      const plan = await retirePlan(ctx.tx, decodeURIComponent(ctx.req.params.name!), asDate(b.lastDay, 'lastDay'))
      await emit(ctx.tx, { action: 'incentive.plan.published', entityType: 'incentive_plan', entityId: plan.id,
        actorUserId: ctx.auth.userId, metadata: { name: plan.name, version: plan.version, retiredOn: plan.effective_to } })
      return ok({ plan })
    }))

  router.post('/api/v1/incentives/periods',
    { summary: 'Open an incentive period', tag: 'incentives', permission: 'incentive.write',
      requestExample: { label: '2026-11', periodStart: '2026-11-01', periodEnd: '2026-11-30' } },
    authed('incentive.write', async (ctx) => {
      const b = requireBody<{ label: string; periodStart: string; periodEnd: string }>(ctx.req, ['label', 'periodStart', 'periodEnd'])
      return created(await createPeriod(ctx.tx, { label: String(b.label), periodStart: asDate(b.periodStart, 'periodStart'), periodEnd: asDate(b.periodEnd, 'periodEnd') }))
    }))

  router.get('/api/v1/incentives/periods/:id/targets',
    { summary: 'Targets set for a period', tag: 'incentives', permission: 'incentive.read' },
    authed('incentive.read', async (ctx) => {
      const rows = await listTargets(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      // A manager sees their reports' targets, not the whole company's.
      return ok({ targets: rows.filter((r) => { try { assertScope(ctx.auth, r.employee_id as string); return true } catch { return false } }) })
    }))

  router.patch('/api/v1/incentives/periods/:id/targets',
    { summary: 'Set targets in bulk (replaces per employee+plan); only while the period is open', tag: 'incentives',
      permission: 'incentive.write', requestExample: { targets: [{ employeeId: '…', planId: '…', targetValue: 1500000 }] } },   // targetValue is in the metric's unit (rupees for sales_value)
    authed('incentive.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ targets: TargetInput[] }>(ctx.req, ['targets'])
      if (!Array.isArray(b.targets) || !b.targets.length || b.targets.length > 2000) throw new HttpError(422, 'VALIDATION_FAILED', 'targets is a list of 1–2000')
      for (const t of b.targets) { asUuid(t.employeeId, 'employeeId'); asUuid(t.planId, 'planId'); assertScope(ctx.auth, t.employeeId) }
      const r = await setTargets(ctx.tx, id, b.targets, ctx.auth.userId)
      await emit(ctx.tx, { action: 'incentive.targets.set', entityType: 'incentive_period', entityId: id, actorUserId: ctx.auth.userId, metadata: r })
      return ok(r)
    }))

  router.post('/api/v1/incentives/periods/:id/sales',
    { summary: 'Record sales for a period (idempotent by externalRef); only while open', tag: 'incentives',
      permission: 'incentive.write', requestExample: { source: 'crm', sales: [{ employeeId: '…', occurredOn: '2026-11-05', valuePaise: 250000000, externalRef: 'INV-1041' }] } },
    authed('incentive.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ sales: SaleInput[]; source?: string }>(ctx.req, ['sales'])
      if (!Array.isArray(b.sales) || !b.sales.length || b.sales.length > 5000) throw new HttpError(422, 'VALIDATION_FAILED', 'sales is a list of 1–5000')
      for (const s of b.sales) { asUuid(s.employeeId, 'employeeId'); asDate(s.occurredOn, 'occurredOn'); assertScope(ctx.auth, s.employeeId) }
      const source = (b.source ?? 'manual').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24) || 'manual'
      return ok(await recordSales(ctx.tx, id, b.sales, source))
    }))
}
