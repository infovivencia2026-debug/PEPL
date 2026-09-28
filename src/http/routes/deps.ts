/**
 * Everything a route module is allowed to reach for, in one place.
 *
 * Route files import only from here, so the dependency surface of the HTTP
 * layer is a single reviewable list rather than 12 drifting import blocks.
 */
export { HttpError, type Req, type Router } from '../router.ts'
export {
  authed, open, ok, created, noContent, requireBody, requireModule, requireRecentMfa,
  asDate, asInt, asUuid, type Ctx,
} from '../context.ts'
export { login, completeCompanyChoice, resolveSession, revokeAllSessions, revokeSession } from '../../auth/index.ts'
export { assertScope, can, PERMISSIONS, ROLE_PERMISSIONS } from '../../authz/permissions.ts'
export { withTenant } from '../../db/tenant-tx.ts'
export { setSetting } from '../../config/write.ts'
export { REGISTRY } from '../../config-registry/index.ts'
export {
  changeAssignment, changeCompensation, correctAssignment, correctCompensation, profileAt,
} from '../../people/history.ts'
export { balance, appendEntry, consume, reverse, rollover } from '../../leave/ledger.ts'
export {
  applyBulkCorrection, applyCorrection, recomputeDay, recordPunch, setPeriodStatus,
} from '../../attendance/index.ts'
export { act, inbox, raise } from '../../approvals/index.ts'
export {
  approve, calculate, createRun, delta, freezeInputs, getRun, lock, revise,
  unfreezeInputs, validate,
} from '../../payroll/run.ts'
export { blockingTasksOpen, completeTask, instantiateTemplate, taskInbox } from '../../work/tasks.ts'
export { evaluateBreaches, raiseTicket, respond, setStatus } from '../../work/helpdesk.ts'
export {
  approvePeriod, calculatePeriod, clawback, closePeriod, pushToPayroll,
} from '../../work/incentives.ts'
export {
  acknowledge, acknowledgementStats, notify, publishAnnouncement, unreadCount,
} from '../../comms/index.ts'
export { activity, emit, myRecordAccess, verifyChain } from '../../audit/index.ts'
export { loadStatutory, ptFor } from '../../payroll/statutory.ts'
export { computeTds, monthsRemainingInFY } from '../../payroll/tds.ts'
