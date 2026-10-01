/**
 * Tax declarations (Chapter VI-A, HRA, regime).
 *
 * An employee edits and submits their OWN declaration under `payroll.read`,
 * which every employee holds with scope self — the scope check is what keeps
 * one person out of another's investments. Payroll verifies or rejects under
 * `payroll.process`, because the verified figure is what freeze deducts.
 */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, requireBody, requireModule, asUuid, assertScope, emit,
} from './deps.ts'
import {
  getDeclaration, listDeclarations, rejectDeclaration, saveDeclaration,
  submitDeclaration, verifyDeclaration, type TaxDeclaration,
} from '../../payroll/declarations.ts'
import { allowableDeductions } from '../../payroll/chapter-via.ts'

const FY = /^\d{4}-\d{2}$/

function fiscalYear(ctx: { req: { query: URLSearchParams } }): string {
  const fy = ctx.req.query.get('fy') ?? ''
  if (!FY.test(fy)) throw new HttpError(422, 'VALIDATION_FAILED', 'fy must look like 2026-27')
  return fy
}

function ownEmployee(ctx: { auth: { employeeId?: string } }): string {
  if (!ctx.auth.employeeId) {
    throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this login is not linked to an employee record')
  }
  return ctx.auth.employeeId
}

const STATUSES: TaxDeclaration['status'][] = ['draft', 'submitted', 'verified', 'rejected']

export function register(router: Router): void {
  router.get('/api/v1/tax-declarations/me',
    { summary: 'My tax declaration for a fiscal year, with what it would be worth',
      tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const fy = fiscalYear(ctx)
      const employeeId = ownEmployee(ctx)
      const declaration = await getDeclaration(ctx.tx, employeeId, fy)
      // A preview against the declared figures, so the employee sees the caps
      // bite before payroll does. Salary facts are zero here: HRA exemption needs
      // the structure and is shown once payroll freezes.
      const preview = declaration
        ? allowableDeductions(declaration.declared, { basicAnnualPaise: 0, hraAnnualPaise: 0 },
            fy, declaration.regime)
        : null
      return ok({ declaration, preview })
    }))

  router.patch('/api/v1/tax-declarations/me',
    { summary: 'Save my declaration (returns it to draft)', tag: 'payroll', permission: 'payroll.read',
      requestExample: { fiscalYear: '2026-27', regime: 'old',
        declared: { section80cPaise: 15000000, rentPaidAnnualPaise: 24000000, metro: true } } },
    authed('payroll.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{
        fiscalYear: string; regime: 'old' | 'new'; declared: Record<string, unknown>
        proofDocumentIds?: string[]
      }>(ctx.req, ['fiscalYear', 'regime', 'declared'])
      if (typeof b.declared !== 'object' || b.declared === null || Array.isArray(b.declared)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'declared must be an object')
      }
      const proofs = (b.proofDocumentIds ?? []).map((d) => asUuid(d, 'proofDocumentIds'))
      const declaration = await saveDeclaration(ctx.tx, {
        employeeId: ownEmployee(ctx), fiscalYear: b.fiscalYear, regime: b.regime,
        declared: b.declared, proofDocumentIds: proofs,
      })
      return ok({ declaration })
    }))

  router.post('/api/v1/tax-declarations/me/submit',
    { summary: 'Submit my declaration for payroll to verify', tag: 'payroll',
      permission: 'payroll.read', requestExample: { fiscalYear: '2026-27' } },
    authed('payroll.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ fiscalYear: string }>(ctx.req, ['fiscalYear'])
      const declaration = await submitDeclaration(ctx.tx, ownEmployee(ctx), b.fiscalYear)
      return ok({ declaration })
    }))

  router.get('/api/v1/tax-declarations',
    { summary: 'Payroll queue of declarations for a fiscal year', tag: 'payroll',
      permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const fy = fiscalYear(ctx)
      const status = ctx.req.query.get('status') ?? undefined
      if (status !== undefined && !STATUSES.includes(status as TaxDeclaration['status'])) {
        throw new HttpError(422, 'VALIDATION_FAILED', `status must be one of ${STATUSES.join(', ')}`)
      }
      const declarations = await listDeclarations(ctx.tx, fy, status as TaxDeclaration['status'] | undefined)
      return ok({ declarations })
    }))

  router.post('/api/v1/tax-declarations/:id/verify',
    { summary: 'Verify a submitted declaration — freeze will use it', tag: 'payroll',
      permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const declaration = await verifyDeclaration(ctx.tx, { id, verifiedByUserId: ctx.auth.userId, verifierEmployeeId: ctx.auth.employeeId })
      assertScope(ctx.auth, declaration.employee_id)
      await emit(ctx.tx, {
        action: 'tax_declaration.verified', entityType: 'tax_declaration', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: declaration.employee_id,
        metadata: { fiscalYear: declaration.fiscal_year, regime: declaration.regime },
      })
      return ok({ declaration })
    }))

  router.post('/api/v1/tax-declarations/:id/reject',
    { summary: 'Reject a submitted declaration with a reason the employee can act on',
      tag: 'payroll', permission: 'payroll.process',
      requestExample: { reason: 'rent receipts missing for Oct–Mar' } },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      const declaration = await rejectDeclaration(ctx.tx, { id, reason: b.reason })
      assertScope(ctx.auth, declaration.employee_id)
      await emit(ctx.tx, {
        action: 'tax_declaration.rejected', entityType: 'tax_declaration', entityId: id,
        actorUserId: ctx.auth.userId, subjectEmployeeId: declaration.employee_id,
        reason: b.reason, metadata: { fiscalYear: declaration.fiscal_year },
      })
      return ok({ declaration })
    }))
}
