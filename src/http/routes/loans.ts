/**
 * Loans and advances. Granting is `compensation.write` (it changes take-home
 * for months); a person reads their own under `payroll.read`.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, requireBody, asUuid, asDate, assertScope, emit } from './deps.ts'
import { closeLoan, grantLoan, listLoans, loanView, repayManually, schedule } from '../../payroll/loans.ts'

export function register(router: Router): void {
  router.get('/api/v1/employees/:id/loans',
    { summary: 'Loans and advances with live balances (?includeClosed=true)', tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      return ok({ loans: await listLoans(ctx.tx, id, ctx.req.query.get('includeClosed') === 'true') })
    }))

  router.get('/api/v1/loans/schedule-preview',
    { summary: 'Instalment for a principal, rate and term (?principalPaise=&annualInterestPct=&instalments=)', tag: 'payroll',
      permission: 'compensation.read' },
    authed('compensation.read', async (ctx) => {
      const p = Number(ctx.req.query.get('principalPaise')), r = Number(ctx.req.query.get('annualInterestPct') ?? 0), n = Number(ctx.req.query.get('instalments'))
      if (!Number.isSafeInteger(p) || p <= 0 || !Number.isInteger(n) || n < 1 || n > 120 || !(r >= 0 && r <= 36)) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'principalPaise > 0, instalments 1–120, annualInterestPct 0–36')
      }
      return ok(schedule(p, r, n))
    }))

  router.post('/api/v1/employees/:id/loans',
    { summary: 'Grant a loan or salary advance; recovery starts with the period containing startsOn', tag: 'payroll',
      permission: 'compensation.write',
      requestExample: { kind: 'advance', principalPaise: 5000000, instalments: 5, startsOn: '2026-12-01', reason: 'medical' } },
    authed('compensation.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const b = requireBody<{ kind: 'loan' | 'advance'; principalPaise: number; annualInterestPct?: number; instalments: number; startsOn: string; disbursedOn?: string; reason?: string }>(
        ctx.req, ['kind', 'principalPaise', 'instalments', 'startsOn'])
      if (b.kind !== 'loan' && b.kind !== 'advance') throw new HttpError(422, 'VALIDATION_FAILED', 'kind is loan or advance')
      const loan = await grantLoan(ctx.tx, { ...b, employeeId: id, startsOn: asDate(b.startsOn, 'startsOn'),
        disbursedOn: b.disbursedOn ? asDate(b.disbursedOn, 'disbursedOn') : undefined, approvedByUserId: ctx.auth.userId, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'payroll.loan.changed', entityType: 'employee', entityId: id, subjectEmployeeId: id, actorUserId: ctx.auth.userId,
        metadata: { op: 'grant', kind: loan.kind, principalPaise: Number(loan.principal_paise), instalments: loan.instalments, startsOn: loan.starts_on } })
      return created({ loan: await loanView(ctx.tx, loan) })
    }))

  router.post('/api/v1/loans/:id/repay',
    { summary: 'Record a repayment made outside payroll', tag: 'payroll', permission: 'compensation.write',
      requestExample: { amountPaise: 1000000, note: 'NEFT ref 4471' } },
    authed('compensation.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ amountPaise: number; note?: string }>(ctx.req, ['amountPaise'])
      const loan = await repayManually(ctx.tx, id, Number(b.amountPaise), b.note)
      assertScope(ctx.auth, loan.employee_id)
      await emit(ctx.tx, { action: 'payroll.loan.changed', entityType: 'employee', entityId: loan.employee_id, subjectEmployeeId: loan.employee_id,
        actorUserId: ctx.auth.userId, metadata: { op: 'repay', loanId: id, amountPaise: Number(b.amountPaise), balancePaise: loan.balance_paise } })
      return ok({ loan })
    }))

  router.post('/api/v1/loans/:id/close',
    { summary: 'Write off or cancel a loan (reason required)', tag: 'payroll', permission: 'compensation.write',
      requestExample: { status: 'written_off', reason: 'approved by MD, hardship' } },
    authed('compensation.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ status: 'written_off' | 'cancelled'; reason: string }>(ctx.req, ['status', 'reason'])
      if (b.status !== 'written_off' && b.status !== 'cancelled') throw new HttpError(422, 'VALIDATION_FAILED', 'status is written_off or cancelled')
      const loan = await closeLoan(ctx.tx, id, b.status, String(b.reason))
      assertScope(ctx.auth, loan.employee_id)
      await emit(ctx.tx, { action: 'payroll.loan.changed', entityType: 'employee', entityId: loan.employee_id, subjectEmployeeId: loan.employee_id,
        actorUserId: ctx.auth.userId, reason: b.reason, metadata: { op: b.status, loanId: id } })
      return ok({ loan })
    }))
}
