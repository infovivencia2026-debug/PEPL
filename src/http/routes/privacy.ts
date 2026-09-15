/**
 * Data-subject rights.
 *
 * A person gets their own export with no permission beyond being signed in.
 * Anyone else needs `compensation.read` at company scope — the bundle holds
 * pay, bank and tax — and the access is a tier-3 reveal in the activity log.
 * Erasure is `employee.write` at company scope, with a reason, and only once
 * the retention clock has run.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, asUuid, can, emit } from './deps.ts'
import { eligibleForErasure, erasePersonalData, exportPersonalData } from '../../people/privacy.ts'

export function register(router: Router): void {
  router.get('/api/v1/employees/:id/data-export',
    { summary: 'Everything held about one person, as JSON (own record, or compensation.read at company scope)',
      tag: 'people' },
    authed(null, async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const own = ctx.auth.employeeId === id
      if (!own && !(can(ctx.auth, 'compensation.read') && ctx.auth.scope === 'all')) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'only the person, or payroll at company scope, may export this')
      }
      const bundle = await exportPersonalData(ctx.tx, id)
      await emit(ctx.tx, {
        action: 'data.export.completed', entityType: 'employee', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: id,
        metadata: { tables: Object.keys(bundle.tables).length, documents: bundle.documents.length, self: own },
      })
      return ok({ export: bundle })
    }))

  router.get('/api/v1/employees/:id/erasure-eligibility',
    { summary: 'Whether the person can be erased yet, and if not why', tag: 'people', permission: 'employee.write' },
    authed('employee.write', async (ctx) => {
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'erasure is a company-scope action')
      const id = asUuid(ctx.req.params.id, 'id')
      return ok(await eligibleForErasure(ctx.tx, id, ctx.config.get<number>('privacy.erasure_after_days')))
    }))

  router.post('/api/v1/employees/:id/erase',
    { summary: 'Anonymise a former employee (reason required; payroll ledger is kept)', tag: 'people',
      permission: 'employee.write', requestExample: { reason: 'DPDP erasure request #41' } },
    authed('employee.write', async (ctx) => {
      if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'erasure is a company-scope action')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      const result = await erasePersonalData(ctx.tx, {
        employeeId: id, reason: String(b.reason), actorUserId: ctx.auth.userId,
        afterDays: ctx.config.get<number>('privacy.erasure_after_days'),
      })
      await emit(ctx.tx, {
        action: 'data.erasure.completed', entityType: 'employee', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: id, reason: String(b.reason),
        metadata: result.anonymised,
      })
      return ok(result)
    }))
}
