/**
 * Approval policies (`settings.write`) and delegations (anyone, for their own
 * steps; `employee.write` at company scope to set one for someone else).
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, created, noContent, requireBody, asUuid, asDate, emit } from './deps.ts'
import {
  POLICY_CHAINS, chooseChain, createDelegation, createPolicy, endDelegation, listDelegations, listPolicies,
  resolveApprovers, retirePolicy,
} from '../../approvals/policy.ts'
import { CHAINS, type ChainCode } from '../../approvals/index.ts'

export function register(router: Router): void {
  router.get('/api/v1/approvals/chains',
    { summary: 'The chain vocabulary: code → ordered step roles', tag: 'approvals' },
    authed(null, async () => ok({ chains: CHAINS })))

  router.get('/api/v1/approvals/policies',
    { summary: 'Policies (?entityType=, ?includeRetired=true)', tag: 'approvals' },
    authed(null, async (ctx) => ok({
      policies: await listPolicies(ctx.tx, ctx.req.query.get('entityType') ?? undefined, ctx.req.query.get('includeRetired') === 'true'),
    })))

  router.post('/api/v1/approvals/policies',
    { summary: 'Add a policy: which chain applies to an entity, optionally above a size and for one department',
      tag: 'approvals', permission: 'settings.write',
      requestExample: { entityType: 'leave', chainCode: 'manager_then_hr', minMagnitude: 5, departmentCode: null } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ entityType: string; chainCode: ChainCode; minMagnitude?: number | null; departmentCode?: string | null }>(ctx.req, ['entityType', 'chainCode'])
      if (!POLICY_CHAINS.includes(b.chainCode)) throw new HttpError(422, 'UNKNOWN_CHAIN', `chainCode must be one of ${POLICY_CHAINS.join(', ')}`)
      const policy = await createPolicy(ctx.tx, { ...b, actorUserId: ctx.auth.userId })
      await emit(ctx.tx, { action: 'approval.policy.changed', entityType: 'approval_policy', entityId: policy.id,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', ...b } })
      return created({ policy })
    }))

  router.post('/api/v1/approvals/policies/:id/retire',
    { summary: 'Retire a policy', tag: 'approvals', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const policy = await retirePolicy(ctx.tx, id)
      await emit(ctx.tx, { action: 'approval.policy.changed', entityType: 'approval_policy', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { op: 'retire', entityType: policy.entity_type } })
      return ok({ policy })
    }))

  router.get('/api/v1/approvals/preview',
    { summary: 'Who would approve: ?entityType=&employeeId=&magnitude= → chain and resolved approvers', tag: 'approvals',
      permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const entityType = ctx.req.query.get('entityType') ?? 'leave'
      const employeeId = asUuid(ctx.req.query.get('employeeId'), 'employeeId')
      const magnitude = Number(ctx.req.query.get('magnitude') ?? 0)
      const resolved = await resolveApprovers(ctx.tx, employeeId)
      const chain = await chooseChain(ctx.tx, { entityType, departmentCode: resolved.departmentCode, magnitude, fallback: 'manager' })
      return ok({ ...chain, steps: CHAINS[chain.chainCode], approvers: resolved.approvers, delegatedFrom: resolved.delegatedFrom, departmentCode: resolved.departmentCode })
    }))

  router.get('/api/v1/approvals/delegations',
    { summary: 'My delegations, given and received', tag: 'approvals' },
    authed(null, async (ctx) => ok({ delegations: await listDelegations(ctx.tx, ctx.auth.userId) })))

  router.post('/api/v1/approvals/delegations',
    { summary: 'Delegate my approvals to someone for a period (up to 90 days)', tag: 'approvals',
      requestExample: { toUserId: '…', fromDate: '2026-12-20', toDate: '2027-01-03', reason: 'on leave' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ toUserId: string; fromDate: string; toDate: string; reason?: string; fromUserId?: string }>(ctx.req, ['toUserId', 'fromDate', 'toDate'])
      // Setting one for someone else is an admin act at company scope.
      const fromUserId = b.fromUserId ? asUuid(b.fromUserId, 'fromUserId') : ctx.auth.userId
      if (fromUserId !== ctx.auth.userId && !(ctx.auth.permissions.has('employee.write') && ctx.auth.scope === 'all')) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'only company-scope HR can delegate on someone\'s behalf')
      }
      const delegation = await createDelegation(ctx.tx, {
        fromUserId, toUserId: asUuid(b.toUserId, 'toUserId'), fromDate: asDate(b.fromDate, 'fromDate'), toDate: asDate(b.toDate, 'toDate'),
        reason: b.reason, actorUserId: ctx.auth.userId,
      })
      await emit(ctx.tx, { action: 'approval.delegation.changed', entityType: 'user', entityId: fromUserId,
        actorUserId: ctx.auth.userId, metadata: { op: 'create', toUserId: b.toUserId, fromDate: b.fromDate, toDate: b.toDate } })
      return created({ delegation })
    }))

  router.del('/api/v1/approvals/delegations/:id',
    { summary: 'End a delegation early (mine, or anyone\'s for company-scope HR)', tag: 'approvals' },
    authed(null, async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const admin = ctx.auth.permissions.has('employee.write') && ctx.auth.scope === 'all'
      if (!(await endDelegation(ctx.tx, id, admin ? undefined : ctx.auth.userId))) throw new HttpError(404, 'NOT_FOUND', 'no such delegation of yours')
      await emit(ctx.tx, { action: 'approval.delegation.changed', entityType: 'approval_delegation', entityId: id, actorUserId: ctx.auth.userId, metadata: { op: 'end' } })
      return noContent()
    }))
}
