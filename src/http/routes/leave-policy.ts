/**
 * Leave administration — types and policies.
 *
 * Reading is `leave.read`: an employee choosing a leave type needs the list.
 * Writing is `leave.policy.write`, and every write is audited with a reason,
 * because a policy decides what leave people accrue and what unpaid leave costs
 * them — it is money, and it is history.
 */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid, emit,
} from './deps.ts'
import {
  createLeaveType, listLeaveTypes, policyHistory, publishPolicy, reinstateLeaveType,
  retireLeaveType, updateLeaveType, type PolicyInput,
} from '../../leave/policy.ts'

export function register(router: Router): void {
  router.get('/api/v1/leave/types',
    { summary: 'Leave types with the policy currently in force', tag: 'leave',
      permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      return ok({
        types: await listLeaveTypes(ctx.tx, {
          includeRetired: ctx.req.query.get('includeRetired') === 'true',
          asOf: ctx.req.query.get('asOf') ?? undefined,
        }),
      })
    }))

  router.post('/api/v1/leave/types',
    { summary: 'Add a leave type', tag: 'leave', permission: 'leave.policy.write',
      requestExample: { code: 'PL', name: 'Paternity Leave', isPaid: true, reason: 'policy update' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const b = requireBody<{
        code: string; name: string; isPaid?: boolean; affectsLop?: boolean; reason: string
      }>(ctx.req, ['code', 'name', 'reason'])
      const type = await createLeaveType(ctx.tx, b)
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'leave_type', entityId: type.id,
        actorUserId: ctx.session.userId, reason: b.reason,
        metadata: { code: type.code, name: type.name, isPaid: type.is_paid },
      })
      return created(type)
    }))

  router.patch('/api/v1/leave/types/:id',
    { summary: 'Rename a leave type or change whether it is paid', tag: 'leave',
      permission: 'leave.policy.write',
      requestExample: { name: 'Earned Leave (EL)', reason: 'clearer name on payslips' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ name?: string; isPaid?: boolean; affectsLop?: boolean; reason: string }>(
        ctx.req, ['reason'])
      const type = await updateLeaveType(ctx.tx, id, b)
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'leave_type', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason,
        metadata: { name: type.name, isPaid: type.is_paid, affectsLop: type.affects_lop },
      })
      return ok(type)
    }))

  router.post('/api/v1/leave/types/:id/retire',
    { summary: 'Retire a leave type: no new requests, history untouched', tag: 'leave',
      permission: 'leave.policy.write', requestExample: { reason: 'merged into EL' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      await retireLeaveType(ctx.tx, id)
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'leave_type', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason, metadata: { status: 'retired' },
      })
      return noContent()
    }))

  router.post('/api/v1/leave/types/:id/reinstate',
    { summary: 'Bring a retired leave type back', tag: 'leave',
      permission: 'leave.policy.write', requestExample: { reason: 'reinstated for FY27' } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      await reinstateLeaveType(ctx.tx, id)
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'leave_type', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason, metadata: { status: 'active' },
      })
      return noContent()
    }))

  router.get('/api/v1/leave/types/:id/policies',
    { summary: 'Every policy version this type has had', tag: 'leave', permission: 'leave.read' },
    authed('leave.read', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      return ok({ policies: await policyHistory(ctx.tx, asUuid(ctx.req.params.id, 'id')) })
    }))

  router.post('/api/v1/leave/types/:id/policies',
    { summary: 'Publish a new policy version, effective from a future date', tag: 'leave',
      permission: 'leave.policy.write',
      requestExample: {
        accrualMethod: 'monthly', accrualUnitsPerPeriod: 1.75, carryForwardLimit: 30,
        encashable: true, effectiveFrom: '2027-04-01', reason: 'FY27 leave policy',
      } },
    authed('leave.policy.write', async (ctx) => {
      requireModule(ctx, 'leave.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const b = requireBody<Record<string, unknown> & PolicyInput & { reason: string }>(
        ctx.req, ['accrualMethod', 'accrualUnitsPerPeriod', 'effectiveFrom', 'reason'])
      if (!b.reason.trim()) {
        throw new HttpError(422, 'REASON_REQUIRED', 'a policy change needs a reason')
      }
      const policy = await publishPolicy(ctx.tx, id, b)
      await emit(ctx.tx, {
        action: 'config.setting.changed', entityType: 'leave_policy', entityId: policy.id,
        actorUserId: ctx.session.userId, reason: b.reason,
        metadata: {
          leaveTypeId: id, version: policy.version, effectiveFrom: policy.effective_from,
          accrualMethod: policy.accrual_method, unitsPerPeriod: policy.accrual_units_per_period,
          carryForwardLimit: policy.carry_forward_limit,
        },
      })
      return created(policy)
    }))
}
