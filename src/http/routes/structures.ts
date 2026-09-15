/**
 * Salary components and structures. Company structure: `settings.write`. The
 * preview is `compensation.read` so payroll can see what a CTC becomes before
 * offering it.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, asUuid, emit } from './deps.ts'
import {
  createComponent, createStructure, listComponents, listStructures, resolveStructure, retireComponent,
  retireStructure, structureByCode, updateComponent,
} from '../../payroll/structures.ts'

export function register(router: Router): void {
  router.get('/api/v1/salary/components',
    { summary: 'The salary component master; ?includeRetired=true', tag: 'payroll' },
    authed(null, async (ctx) => ok({ components: await listComponents(ctx.tx, { includeRetired: ctx.req.query.get('includeRetired') === 'true' }) })))

  router.post('/api/v1/salary/components',
    { summary: 'Define a component with its tax, PF and ESI treatment (flags are permanent)', tag: 'payroll',
      permission: 'settings.write',
      requestExample: { code: 'HRA', name: 'House rent allowance', kind: 'earning', taxable: true, pfWage: false, esiWage: true } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ code: string; name: string; kind: 'earning' | 'deduction'; taxable?: boolean; pfWage?: boolean; esiWage?: boolean; billRequired?: boolean; sortOrder?: number }>(
        ctx.req, ['code', 'name', 'kind'])
      const component = await createComponent(ctx.tx, b)
      await emit(ctx.tx, { action: 'payroll.structure.changed', entityType: 'salary_component', entityId: component.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', code: component.code, taxable: component.taxable, pfWage: component.pf_wage } })
      return created({ component })
    }))

  router.patch('/api/v1/salary/components/:id',
    { summary: 'Rename a component or change its bill requirement (never its tax/PF/ESI flags)', tag: 'payroll', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ name?: string; billRequired?: boolean; sortOrder?: number }>(ctx.req, [])
      return ok({ component: await updateComponent(ctx.tx, asUuid(ctx.req.params.id, 'id'), b) })
    }))

  router.post('/api/v1/salary/components/:id/retire',
    { summary: 'Retire a component no active structure uses', tag: 'payroll', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const r = await retireComponent(ctx.tx, id)
      await emit(ctx.tx, { action: 'payroll.structure.changed', entityType: 'salary_component', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', code: r.component.code } })
      return ok(r)
    }))

  router.get('/api/v1/salary/structures',
    { summary: 'Structures (templates); ?includeRetired=true', tag: 'payroll' },
    authed(null, async (ctx) => ok({ structures: await listStructures(ctx.tx, { includeRetired: ctx.req.query.get('includeRetired') === 'true' }) })))

  router.post('/api/v1/salary/structures',
    { summary: 'Define a structure: ordered lines of percent_of / fixed / balance (lines are immutable afterwards)',
      tag: 'payroll', permission: 'settings.write',
      requestExample: { code: 'STD', name: 'Standard', lines: [
        { component: 'BASIC', formula: { type: 'percent_of', of: 'CTC', pct: 50 } },
        { component: 'HRA', formula: { type: 'percent_of', of: 'BASIC', pct: 40 } },
        { component: 'SPECIAL', formula: { type: 'balance' } } ], gradeCodes: [] } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ code: string; name: string; lines: unknown; gradeCodes?: string[] }>(ctx.req, ['code', 'name', 'lines'])
      const structure = await createStructure(ctx.tx, b)
      await emit(ctx.tx, { action: 'payroll.structure.changed', entityType: 'salary_structure', entityId: structure.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', code: structure.code, lines: structure.lines.length } })
      return created({ structure })
    }))

  router.post('/api/v1/salary/structures/:id/retire',
    { summary: 'Retire a structure (existing compensation records keep their breakdown)', tag: 'payroll', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const structure = await retireStructure(ctx.tx, id)
      await emit(ctx.tx, { action: 'payroll.structure.changed', entityType: 'salary_structure', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', code: structure.code } })
      return ok({ structure })
    }))

  router.get('/api/v1/salary/structures/:code/preview',
    { summary: 'What an annual figure becomes under a structure (?annualPaise=)', tag: 'payroll', permission: 'compensation.read' },
    authed('compensation.read', async (ctx) => {
      const annual = Number(ctx.req.query.get('annualPaise'))
      if (!Number.isSafeInteger(annual) || annual <= 0) throw new HttpError(422, 'VALIDATION_FAILED', 'annualPaise must be a positive integer')
      const structure = await structureByCode(ctx.tx, ctx.req.params.code!)
      const monthly = resolveStructure(structure.lines, annual)
      return ok({ structure: structure.code, annualPaise: annual, monthlyComponents: monthly,
        monthlyTotalPaise: Object.values(monthly).reduce((n, v) => n + v, 0) })
    }))
}
