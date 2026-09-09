/**
 * The PEPL HTTP API.
 *
 * Conventions, applied everywhere:
 *   - the tenant comes from the session, never from the path, a header or the body
 *   - a record outside the caller's scope returns 404, never 403
 *   - errors carry a stable machine code, not just a status
 *   - every mutating route takes an optional `reason`, required where the domain
 *     demands one
 */
import { Router, HttpError, type Req } from './router.ts'
import {
  authed, open, ok, created, noContent, requireBody, requireModule,
  asDate, asInt, asUuid,
} from './context.ts'
import { login, resolveSession, revokeAllSessions, revokeSession } from '../auth/index.ts'
import { assertScope, can, PERMISSIONS, ROLE_PERMISSIONS } from '../authz/permissions.ts'
import { withTenant } from '../db/tenant-tx.ts'
import { setSetting } from '../config/write.ts'
import { REGISTRY } from '../config-registry/index.ts'
import {
  changeAssignment, changeCompensation, correctAssignment, correctCompensation, profileAt,
} from '../people/history.ts'
import { balance, appendEntry, consume, reverse, rollover } from '../leave/ledger.ts'
import {
  applyBulkCorrection, applyCorrection, recomputeDay, recordPunch, setPeriodStatus,
} from '../attendance/index.ts'
import { act, inbox, raise } from '../approvals/index.ts'
import {
  approve, calculate, createRun, delta, freezeInputs, getRun, lock, revise, unfreezeInputs, validate,
} from '../payroll/run.ts'
import { blockingTasksOpen, completeTask, instantiateTemplate, taskInbox } from '../work/tasks.ts'
import { evaluateBreaches, raiseTicket, respond, setStatus } from '../work/helpdesk.ts'
import {
  approvePeriod, calculatePeriod, clawback, closePeriod, pushToPayroll,
} from '../work/incentives.ts'
import {
  acknowledge, acknowledgementStats, notify, publishAnnouncement, unreadCount,
} from '../comms/index.ts'
import { activity, emit, myRecordAccess, verifyChain } from '../audit/index.ts'
import { loadStatutory, ptFor } from '../payroll/statutory.ts'
import { computeTds, monthsRemainingInFY } from '../payroll/tds.ts'

export const router = new Router()

/**
 * Binds the run's snapshotted slab data to the engine's TDS hook. Returns
 * undefined when no slabs are configured, so payroll runs without a tax line
 * rather than silently deducting a wrong figure.
 */
function tdsFor(statutory: Awaited<ReturnType<typeof loadStatutory>>) {
  return (args: { monthlyTaxableGrossPaise: bigint; regime: 'old' | 'new' }) => {
    const rules = statutory.taxRules[args.regime]
    const slabs = statutory.taxSlabs[args.regime]
    if (!rules || slabs.length === 0) {
      return { monthlyTdsPaise: 0n, trace: { reason: 'no tax slabs configured' } }
    }
    const r = computeTds(
      {
        monthlyTaxableGrossPaise: args.monthlyTaxableGrossPaise,
        monthsRemaining: monthsRemainingInFY(new Date()),
        regime: args.regime,
      },
      slabs,
      rules,
    )
    return { monthlyTdsPaise: r.monthlyTdsPaise, trace: r.trace }
  }
}

// ---------------------------------------------------------------------------
// Health and identity
// ---------------------------------------------------------------------------

router.get('/health', { summary: 'Liveness probe', tag: 'system', public: true },
  open(() => ok({ status: 'ok', time: new Date().toISOString() })))

router.post('/api/v1/auth/login',
  { summary: 'Exchange email and password for a session token', tag: 'auth', public: true,
    requestExample: { email: 'admin@acme.com', password: 'correct-horse-battery' } },
  open(async (req: Req) => {
    const body = requireBody<{ email: string; password: string }>(req, ['email', 'password'])
    const result = await login({
      email: body.email, password: body.password,
      ip: req.ip, userAgent: String(req.headers['user-agent'] ?? ''),
    })
    return ok({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      user: { id: result.userId, roles: result.roles },
    })
  }))

router.post('/api/v1/auth/logout', { summary: 'Revoke the current session', tag: 'auth' },
  authed(null, async (ctx) => {
    await revokeSession(ctx.tx, ctx.session.sessionId)
    return noContent()
  }))

router.post('/api/v1/auth/logout-everywhere',
  { summary: 'Revoke every session for the current user', tag: 'auth' },
  authed(null, async (ctx) => {
    const n = await revokeAllSessions(ctx.tx, ctx.auth.userId)
    return ok({ revoked: n })
  }))

router.get('/api/v1/me',
  { summary: 'Current user, permissions, data scope and enabled modules', tag: 'auth' },
  authed(null, async (ctx) => ok({
    userId: ctx.auth.userId,
    employeeId: ctx.auth.employeeId ?? null,
    roles: ctx.auth.roles,
    permissions: [...ctx.auth.permissions].sort(),
    scope: ctx.auth.scope,
    modules: Object.keys(REGISTRY)
      .filter((k) => k.endsWith('.enabled'))
      .reduce<Record<string, boolean>>((acc, k) => {
        acc[k.split('.')[0]!] = ctx.config.isEnabled(k)
        return acc
      }, {}),
    limits: { employees: ctx.config.limit('employees') },
    configVersion: String(ctx.config.version),
  })))

// ---------------------------------------------------------------------------
// Configuration — the tenant's own control surface
// ---------------------------------------------------------------------------

router.get('/api/v1/config',
  { summary: 'Every setting with its definition, current value and default', tag: 'config',
    permission: 'settings.write' },
  authed('settings.write', async (ctx) => {
    const changed = new Set(ctx.config.changedKeys())
    return ok({
      version: String(ctx.config.version),
      settings: Object.entries(REGISTRY).map(([key, def]) => ({
        key,
        module: key.split('.')[0],
        label: def.label,
        help: def.help,
        type: def.kind,
        risk: def.risk,
        default: def.default,
        value: ctx.config.get(key),
        changedFromDefault: changed.has(key),
        affectsPayroll: def.affects.includes('payroll'),
        requiresEffectiveDate: def.affects.includes('payroll'),
        scopableBy: def.scopable,
        entitlement: def.entitlement ?? null,
        dependsOn: def.dependsOn,
      })),
    })
  }))

router.patch('/api/v1/config/:key',
  { summary: 'Change one setting for this company only', tag: 'config', permission: 'settings.write',
    requestExample: { value: 25, reason: 'board decision', effectiveFrom: '2026-11-01' } },
  authed('settings.write', async (ctx) => {
    const body = requireBody<{ value: unknown; reason?: string; effectiveFrom?: string; scope?: { type: string; id: string } }>(
      ctx.req, ['value'])
    await setSetting(ctx.tx, {
      key: ctx.req.params.key!,
      value: body.value as never,
      reason: body.reason,
      effectiveFrom: body.effectiveFrom ?? null,
      actorUserId: ctx.auth.userId,
      scope: body.scope as never,
    })
    await emit(ctx.tx, {
      action: 'config.setting.changed', entityType: 'config', entityLabel: ctx.req.params.key,
      actorUserId: ctx.auth.userId, after: { value: body.value }, reason: body.reason,
    })
    return ok({ key: ctx.req.params.key, applied: true })
  }))

router.get('/api/v1/config/changes',
  { summary: 'Every configuration change, forever', tag: 'config', permission: 'audit.read' },
  authed('audit.read', async (ctx) => {
    const { rows } = await ctx.tx.query(
      `SELECT key, scope_type, old_value, new_value, effective_from, actor_user_id, reason, changed_at
         FROM config_change_log ORDER BY id DESC LIMIT 200`)
    return ok({ changes: rows })
  }))

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

router.get('/api/v1/employees',
  { summary: 'List employees, scoped to what the caller may see', tag: 'people',
    permission: 'employee.read' },
  authed('employee.read', async (ctx) => {
    const search = ctx.req.query.get('search')
    const limit = Math.min(Number(ctx.req.query.get('limit') ?? 50), 200)
    const scopeIds = ctx.auth.scope === 'all'
      ? null
      : [...ctx.auth.reportIds, ctx.auth.employeeId].filter(Boolean)

    const { rows } = await ctx.tx.query(
      `SELECT employee_id, employee_number, first_name, last_name, status,
              date_of_joining, department, designation
         FROM current_employee_profile
        WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1))
          AND ($2::text IS NULL OR (first_name || ' ' || coalesce(last_name,'')) ILIKE '%' || $2 || '%'
               OR employee_number ILIKE '%' || $2 || '%')
        ORDER BY employee_number
        LIMIT $3`,
      [scopeIds, search, limit])
    return ok({ employees: rows })
  }))

router.post('/api/v1/employees',
  { summary: 'Create an employee', tag: 'people', permission: 'employee.write',
    requestExample: { employeeNumber: 'A-001', firstName: 'Rahul', lastName: 'Sharma', dateOfJoining: '2026-02-01' } },
  authed('employee.write', async (ctx) => {
    const b = requireBody<{ employeeNumber: string; firstName: string; lastName?: string; dateOfJoining: string }>(
      ctx.req, ['employeeNumber', 'firstName', 'dateOfJoining'])

    const headcount = await ctx.tx.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM employees WHERE status <> 'exited'`)
    if ((headcount.rows[0]?.n ?? 0) >= ctx.config.limit('employees')) {
      throw new HttpError(403, 'EMPLOYEE_LIMIT_REACHED',
        `this plan allows ${ctx.config.limit('employees')} employees. Existing employees keep working; upgrade to add more.`)
    }

    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.auth.tenantId, b.employeeNumber, b.firstName, b.lastName ?? null, asDate(b.dateOfJoining, 'dateOfJoining')])

    await emit(ctx.tx, {
      action: 'people.employee.created', entityType: 'employee', entityId: rows[0]!.id,
      entityLabel: `${b.employeeNumber} · ${b.firstName}`, subjectEmployeeId: rows[0]!.id,
      actorUserId: ctx.auth.userId, after: { employeeNumber: b.employeeNumber },
    })
    return created({ id: rows[0]!.id })
  }))

router.get('/api/v1/employees/:id',
  { summary: 'One employee, with compensation only if permitted', tag: 'people',
    permission: 'employee.read' },
  authed('employee.read', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    assertScope(ctx.auth, id)
    const { rows } = await ctx.tx.query(
      `SELECT * FROM current_employee_profile WHERE employee_id = $1`, [id])
    const row = rows[0]
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'no such employee')

    // A "view employee" screen must not quietly include salary because the
    // record happens to contain it.
    if (!can(ctx.auth, 'compensation.read')) {
      delete row.annual_ctc_paise
      delete row.components
    }
    return ok({ employee: row })
  }))

router.get('/api/v1/employees/:id/profile-at',
  { summary: 'What was true, and what we believed, on a given date', tag: 'people',
    permission: 'employee.read' },
  authed('employee.read', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    assertScope(ctx.auth, id)
    const asOf = asDate(ctx.req.query.get('date'), 'date')
    const knownAt = ctx.req.query.get('knownAt') ?? undefined
    const profile = await profileAt(ctx.tx, id, asOf, knownAt)
    if (!profile) throw new HttpError(404, 'NOT_FOUND', 'no such employee')
    if (!can(ctx.auth, 'compensation.read')) {
      profile.annual_ctc_paise = null
      profile.components = null
    }
    return ok({ profile })
  }))

router.post('/api/v1/employees/:id/assignments',
  { summary: 'Effective-dated assignment change (a promotion or transfer)', tag: 'people',
    permission: 'employee.write',
    requestExample: { department: 'Engineering', designation: 'Lead Developer', effectiveFrom: '2026-10-01', reason: 'promotion' } },
  authed('employee.write', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    assertScope(ctx.auth, id)
    const b = requireBody<{ department: string; designation: string; effectiveFrom: string; reason?: string }>(
      ctx.req, ['department', 'designation', 'effectiveFrom'])
    const recordId = await changeAssignment(ctx.tx, {
      employeeId: id, department: b.department, designation: b.designation,
      effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'),
      reason: b.reason, actorUserId: ctx.auth.userId,
    })
    await emit(ctx.tx, {
      action: 'people.assignment.changed', entityType: 'employee', entityId: id,
      subjectEmployeeId: id, actorUserId: ctx.auth.userId,
      after: { department: b.department, designation: b.designation, effectiveFrom: b.effectiveFrom },
      reason: b.reason,
    })
    return created({ id: recordId })
  }))

router.post('/api/v1/employees/:id/assignments/:recordId/correct',
  { summary: 'Correct a mis-recorded assignment (belief, not timeline)', tag: 'people',
    permission: 'employee.write', requestExample: { designation: 'Senior Engineer', reason: 'mis-keyed at onboarding' } },
  authed('employee.write', async (ctx) => {
    const b = requireBody<{ department?: string; designation?: string; reason: string }>(ctx.req, ['reason'])
    const id = await correctAssignment(ctx.tx, asUuid(ctx.req.params.recordId, 'recordId'), {
      department: b.department, designation: b.designation, reason: b.reason, actorUserId: ctx.auth.userId,
    })
    return created({ id })
  }))

router.post('/api/v1/employees/:id/compensation',
  { summary: 'Effective-dated compensation revision', tag: 'people', permission: 'compensation.write',
    requestExample: { annualCtcPaise: 120000000, components: { basic: 5000000, hra: 2000000 }, effectiveFrom: '2026-10-01', reason: 'annual revision' } },
  authed('compensation.write', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    const b = requireBody<{ annualCtcPaise: number; components?: Record<string, number>; effectiveFrom: string; reason: string }>(
      ctx.req, ['annualCtcPaise', 'effectiveFrom', 'reason'])
    const recordId = await changeCompensation(ctx.tx, {
      employeeId: id, annualCtcPaise: b.annualCtcPaise, components: b.components,
      effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'),
      reason: b.reason, actorUserId: ctx.auth.userId,
    })
    await emit(ctx.tx, {
      action: 'people.compensation.changed', entityType: 'employee', entityId: id,
      subjectEmployeeId: id, actorUserId: ctx.auth.userId,
      after: { annual_ctc_paise: b.annualCtcPaise, effectiveFrom: b.effectiveFrom }, reason: b.reason,
    })
    return created({ id: recordId })
  }))

router.post('/api/v1/employees/:id/compensation/:recordId/correct',
  { summary: 'Correct a mis-recorded compensation figure', tag: 'people', permission: 'compensation.write' },
  authed('compensation.write', async (ctx) => {
    const b = requireBody<{ annualCtcPaise?: number; reason: string }>(ctx.req, ['reason'])
    const id = await correctCompensation(ctx.tx, asUuid(ctx.req.params.recordId, 'recordId'), {
      annualCtcPaise: b.annualCtcPaise, reason: b.reason, actorUserId: ctx.auth.userId,
    })
    await emit(ctx.tx, {
      action: 'people.compensation.corrected', entityType: 'employee',
      entityId: ctx.req.params.id, subjectEmployeeId: ctx.req.params.id,
      actorUserId: ctx.auth.userId, reason: b.reason,
    })
    return created({ id })
  }))

router.get('/api/v1/employees/:id/timeline',
  { summary: 'Merged history across every record for one employee', tag: 'people',
    permission: 'employee.read' },
  authed('employee.read', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    assertScope(ctx.auth, id)
    const { rows } = await ctx.tx.query(
      `SELECT 'assignment' AS kind, effective_from::text AS effective_on,
              department || ' · ' || designation AS detail, change_reason AS reason, recorded_at
         FROM employee_assignments WHERE employee_id = $1 AND superseded_at IS NULL
       UNION ALL
       SELECT 'compensation', effective_from::text,
              CASE WHEN $2 THEN 'CTC ' || (annual_ctc_paise / 100)::text ELSE 'compensation changed' END,
              change_reason, recorded_at
         FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL
       ORDER BY effective_on DESC, recorded_at DESC`,
      [id, can(ctx.auth, 'compensation.read')])
    return ok({ timeline: rows })
  }))

// ---------------------------------------------------------------------------
// Attendance
// ---------------------------------------------------------------------------

router.post('/api/v1/attendance/punch',
  { summary: 'Record a punch (idempotent by clientPunchId)', tag: 'attendance',
    permission: 'attendance.read',
    requestExample: { direction: 'in', localDate: '2026-09-14', clientPunchId: 'offline-1', geo: { lat: 17.4, lng: 78.4 } } },
  authed('attendance.read', async (ctx) => {
    requireModule(ctx, 'attendance.enabled')
    const b = requireBody<{ direction: 'in' | 'out'; localDate: string; clientPunchId?: string; geo?: { lat: number; lng: number }; withinGeofence?: boolean; employeeId?: string }>(
      ctx.req, ['direction', 'localDate'])
    const employeeId = b.employeeId ?? ctx.auth.employeeId
    if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
    assertScope(ctx.auth, employeeId)

    if (ctx.config.get<boolean>('attendance.geofence_required') && !b.geo) {
      throw new HttpError(422, 'LOCATION_REQUIRED',
        'this company requires a location fix on every mobile punch')
    }

    const createdPunch = await recordPunch(ctx.tx, {
      employeeId, punchedAt: new Date().toISOString(),
      localDate: asDate(b.localDate, 'localDate'), direction: b.direction, source: 'mobile',
      clientPunchId: b.clientPunchId, geo: b.geo, withinGeofence: b.withinGeofence,
    })
    await recomputeDay(ctx.tx, employeeId, b.localDate)
    return ok({ recorded: createdPunch, duplicate: !createdPunch })
  }))

router.get('/api/v1/attendance',
  { summary: 'Daily attendance for a date range', tag: 'attendance', permission: 'attendance.read' },
  authed('attendance.read', async (ctx) => {
    const from = asDate(ctx.req.query.get('from'), 'from')
    const to = asDate(ctx.req.query.get('to'), 'to')
    const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
    if (employeeId) assertScope(ctx.auth, employeeId)
    const scopeIds = ctx.auth.scope === 'all' && !employeeId
      ? null : [employeeId].filter(Boolean)

    const { rows } = await ctx.tx.query(
      `SELECT employee_id, work_date::text, status, day_fraction::float8 AS day_fraction,
              is_remote, is_field_duty, is_regularized, worked_minutes, marked_reason
         FROM daily_attendance
        WHERE work_date BETWEEN $1 AND $2
          AND ($3::uuid[] IS NULL OR employee_id = ANY($3))
        ORDER BY work_date, employee_id`,
      [from, to, scopeIds])
    return ok({ days: rows })
  }))

router.post('/api/v1/attendance/corrections',
  { summary: 'Correct a day. Instant while the period is open; never rewrites a frozen one',
    tag: 'attendance', permission: 'attendance.correct',
    requestExample: { employeeId: '…', workDate: '2026-09-14', action: 'mark_present', reason: 'biometric device offline' } },
  authed('attendance.correct', async (ctx) => {
    const b = requireBody<{ employeeId?: string; employeeIds?: string[]; workDate: string; action: string; reason: string; after?: Record<string, unknown> }>(
      ctx.req, ['workDate', 'action', 'reason'])
    const targets = b.employeeIds ?? (b.employeeId ? [b.employeeId] : [])
    if (targets.length === 0) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'employeeId or employeeIds is required')
    }
    for (const id of targets) assertScope(ctx.auth, id)

    const allowClosed = can(ctx.auth, 'attendance.reopen_period')
    const results = await applyBulkCorrection(ctx.tx, targets, {
      workDate: asDate(b.workDate, 'workDate'),
      action: b.action as never, after: b.after, reason: b.reason,
      actorUserId: ctx.auth.userId, allowClosedPeriod: allowClosed,
    })
    await emit(ctx.tx, {
      action: 'attendance.day.corrected', entityType: 'attendance', actorUserId: ctx.auth.userId,
      metadata: { workDate: b.workDate, action: b.action, employees: targets.length }, reason: b.reason,
    })
    return ok({ results })
  }))

router.post('/api/v1/attendance/periods/:id/status',
  { summary: 'Close, reopen or freeze an attendance period', tag: 'attendance',
    permission: 'attendance.close_period', requestExample: { status: 'closed' } },
  authed('attendance.close_period', async (ctx) => {
    const b = requireBody<{ status: 'open' | 'closed' | 'frozen' }>(ctx.req, ['status'])
    if (b.status === 'open' && !can(ctx.auth, 'attendance.reopen_period')) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'reopening a period requires attendance.reopen_period')
    }
    await setPeriodStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status, ctx.auth.userId)
    await emit(ctx.tx, {
      action: b.status === 'open' ? 'attendance.period.reopened' : 'attendance.period.closed',
      entityType: 'attendance_period', entityId: ctx.req.params.id,
      actorUserId: ctx.auth.userId, after: { status: b.status },
      reason: b.status === 'open' ? 'period reopened by HR' : undefined,
    })
    return ok({ status: b.status })
  }))

// ---------------------------------------------------------------------------
// Leave
// ---------------------------------------------------------------------------

router.get('/api/v1/leave/balances',
  { summary: 'Leave balances, explained', tag: 'leave', permission: 'leave.read' },
  authed('leave.read', async (ctx) => {
    requireModule(ctx, 'leave.enabled')
    const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
    if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
    assertScope(ctx.auth, employeeId)
    const cycle = Number(ctx.req.query.get('cycle') ?? new Date().getFullYear())

    const { rows: types } = await ctx.tx.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM leave_types WHERE status = 'active' ORDER BY code`)

    const balances = []
    for (const t of types) {
      const b = await balance(ctx.tx, employeeId, t.id, cycle)
      balances.push({ leaveTypeId: t.id, code: t.code, name: t.name, ...b })
    }
    return ok({ cycle, balances })
  }))

router.get('/api/v1/leave/balances/:leaveTypeId/ledger',
  { summary: 'Every movement behind a balance', tag: 'leave', permission: 'leave.read' },
  authed('leave.read', async (ctx) => {
    const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
    assertScope(ctx.auth, employeeId ?? undefined)
    const { rows } = await ctx.tx.query(
      `SELECT entry_type, delta_days::float8 AS delta_days, effective_date::text, cycle_year, note, created_at
         FROM leave_ledger WHERE employee_id = $1 AND leave_type_id = $2
        ORDER BY id`,
      [employeeId, asUuid(ctx.req.params.leaveTypeId, 'leaveTypeId')])
    return ok({ entries: rows })
  }))

router.post('/api/v1/leave/requests',
  { summary: 'Apply for leave', tag: 'leave', permission: 'leave.apply',
    requestExample: { leaveTypeId: '…', startDate: '2026-09-14', endDate: '2026-09-16', totalDays: 3, reason: 'family event' } },
  authed('leave.apply', async (ctx) => {
    requireModule(ctx, 'leave.enabled')
    const b = requireBody<{ leaveTypeId: string; startDate: string; endDate: string; totalDays: number; reason?: string; dayParts?: Record<string, string>; employeeId?: string }>(
      ctx.req, ['leaveTypeId', 'startDate', 'endDate', 'totalDays'])
    const employeeId = b.employeeId ?? ctx.auth.employeeId
    if (!employeeId) throw new HttpError(422, 'NO_EMPLOYEE_RECORD', 'this user has no employee record')
    assertScope(ctx.auth, employeeId)

    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO leave_requests
         (tenant_id, employee_id, leave_type_id, start_date, end_date, day_parts, total_days, reason)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
      [ctx.auth.tenantId, employeeId, asUuid(b.leaveTypeId, 'leaveTypeId'),
       asDate(b.startDate, 'startDate'), asDate(b.endDate, 'endDate'),
       JSON.stringify(b.dayParts ?? {}), b.totalDays, b.reason ?? null])

    const requestId = rows[0]!.id

    // The approver is resolved from the employee's CURRENT manager assignment,
    // never accepted from the request: a client that names its own approver can
    // route around the chain entirely.
    const { rows: mgr } = await ctx.tx.query<{ user_id: string }>(
      `SELECT u.id AS user_id
         FROM employee_assignments a
         JOIN app_users u ON (u.tenant_id, u.employee_id) = (a.tenant_id, a.manager_employee_id)
        WHERE a.employee_id = $1 AND a.superseded_at IS NULL
          AND (a.effective_to IS NULL OR a.effective_to > CURRENT_DATE)
        LIMIT 1`,
      [employeeId])

    const { rows: hr } = await ctx.tx.query<{ user_id: string }>(
      `SELECT user_id FROM user_roles WHERE role = 'hr_admin' LIMIT 1`)

    const approvalId = await raise(ctx.tx, {
      entityType: 'leave', entityId: requestId, requestedByUserId: ctx.auth.userId,
      subjectEmployeeId: employeeId,
      chainCode: ctx.config.get<string>('leave.approval_chain') as never,
      title: `Leave · ${b.totalDays} day(s) from ${b.startDate}`,
      approvers: { manager: mgr[0]?.user_id, hr: hr[0]?.user_id },
    })
    return created({ id: requestId, approvalRequestId: approvalId })
  }))

router.post('/api/v1/leave/requests/:id/cancel',
  { summary: 'Cancel leave — writes a reversal, never deletes the consumption', tag: 'leave',
    permission: 'leave.apply' },
  authed('leave.apply', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    const { rows } = await ctx.tx.query<{ employee_id: string; leave_type_id: string; total_days: string; start_date: string; status: string }>(
      `SELECT employee_id, leave_type_id, total_days::text, start_date::text, status
         FROM leave_requests WHERE id = $1`, [id])
    const r = rows[0]
    if (!r) throw new HttpError(404, 'NOT_FOUND', 'no such leave request')
    assertScope(ctx.auth, r.employee_id)

    if (r.status === 'approved') {
      await reverse(ctx.tx, {
        employeeId: r.employee_id, leaveTypeId: r.leave_type_id,
        cycleYear: new Date(r.start_date).getFullYear(),
        days: Number(r.total_days), effectiveDate: new Date().toISOString().slice(0, 10),
        requestId: id,
      })
    }
    await ctx.tx.query(`UPDATE leave_requests SET status = 'cancelled' WHERE id = $1`, [id])
    return ok({ cancelled: true })
  }))

router.post('/api/v1/leave/balances/adjust',
  { summary: 'Adjust a balance directly (HR only, reason required)', tag: 'leave',
    permission: 'leave.balance.adjust',
    requestExample: { employeeId: '…', leaveTypeId: '…', days: 2, reason: 'opening balance correction' } },
  authed('leave.balance.adjust', async (ctx) => {
    const b = requireBody<{ employeeId: string; leaveTypeId: string; days: number; reason: string; cycle?: number }>(
      ctx.req, ['employeeId', 'leaveTypeId', 'days', 'reason'])
    await appendEntry(ctx.tx, {
      employeeId: asUuid(b.employeeId, 'employeeId'), leaveTypeId: asUuid(b.leaveTypeId, 'leaveTypeId'),
      entryType: 'adjustment', deltaDays: b.days,
      effectiveDate: new Date().toISOString().slice(0, 10),
      cycleYear: b.cycle ?? new Date().getFullYear(),
      note: b.reason, actorUserId: ctx.auth.userId,
    })
    await emit(ctx.tx, {
      action: 'leave.balance.adjusted', entityType: 'employee', entityId: b.employeeId,
      subjectEmployeeId: b.employeeId, actorUserId: ctx.auth.userId,
      after: { days: b.days }, reason: b.reason,
    })
    return ok({ adjusted: true })
  }))

// ---------------------------------------------------------------------------
// Approvals and tasks — the unified inbox
// ---------------------------------------------------------------------------

router.get('/api/v1/inbox',
  { summary: 'One queue: approvals and tasks across every module', tag: 'inbox',
    permission: 'approval.act' },
  authed(null, async (ctx) => {
    const [approvals, tasks] = await Promise.all([
      can(ctx.auth, 'approval.act') ? inbox(ctx.tx, ctx.auth.userId) : Promise.resolve([]),
      taskInbox(ctx.tx, ctx.auth.userId),
    ])
    return ok({
      items: [
        ...approvals.map((a) => ({ kind: 'approval' as const, ...a })),
        ...tasks.map((t) => ({ kind: 'task' as const, ...t })),
      ],
      counts: { approvals: approvals.length, tasks: tasks.length },
    })
  }))

router.post('/api/v1/approvals/:id/act',
  { summary: 'Approve, reject, send back, comment, delegate or withdraw', tag: 'inbox',
    permission: 'approval.act', requestExample: { action: 'approve', comment: 'ok' } },
  authed('approval.act', async (ctx) => {
    const b = requireBody<{ action: string; comment?: string }>(ctx.req, ['action'])
    const result = await act(ctx.tx, {
      requestId: asUuid(ctx.req.params.id, 'id'), actorUserId: ctx.auth.userId,
      action: b.action as never, comment: b.comment,
    })

    if (result.status === 'approved') {
      const { rows } = await ctx.tx.query<{ entity_type: string; entity_id: string; subject_employee_id: string }>(
        `SELECT entity_type, entity_id, subject_employee_id FROM approval_requests WHERE id = $1`,
        [ctx.req.params.id])
      const r = rows[0]
      if (r?.entity_type === 'leave') {
        const { rows: lr } = await ctx.tx.query<{ leave_type_id: string; total_days: string; start_date: string }>(
          `SELECT leave_type_id, total_days::text, start_date::text FROM leave_requests WHERE id = $1`,
          [r.entity_id])
        const leave = lr[0]
        if (leave) {
          await consume(ctx.tx, {
            employeeId: r.subject_employee_id, leaveTypeId: leave.leave_type_id,
            cycleYear: new Date(leave.start_date).getFullYear(),
            days: Number(leave.total_days), effectiveDate: leave.start_date, requestId: r.entity_id,
            allowNegative: ctx.config.get<boolean>('leave.allow_negative_balance'),
          })
          await ctx.tx.query(
            `UPDATE leave_requests SET status = 'approved', decided_at = now() WHERE id = $1`, [r.entity_id])
          await notify(ctx.tx, {
            userId: ctx.auth.userId, eventType: 'leave.approved',
            title: 'Leave approved', entityType: 'leave', entityId: r.entity_id,
            dedupeKey: `leave-approved:${r.entity_id}`,
          })
          await emit(ctx.tx, {
            action: 'leave.request.approved', entityType: 'leave_request', entityId: r.entity_id,
            subjectEmployeeId: r.subject_employee_id, actorUserId: ctx.auth.userId,
          })
        }
      }
    }
    return ok(result)
  }))

router.post('/api/v1/tasks/:id/complete',
  { summary: 'Complete a task', tag: 'inbox', permission: 'task.write' },
  authed('task.write', async (ctx) => {
    await completeTask(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
    return ok({ completed: true })
  }))

router.post('/api/v1/tasks/instantiate',
  { summary: 'Run a task template for an employee (onboarding or offboarding)', tag: 'inbox',
    permission: 'task.assign',
    requestExample: { templateId: '…', employeeId: '…', anchorDate: '2026-02-01', sourceType: 'onboarding' } },
  authed('task.assign', async (ctx) => {
    const b = requireBody<{ templateId: string; employeeId: string; anchorDate: string; sourceType: string; assignees?: Record<string, string> }>(
      ctx.req, ['templateId', 'employeeId', 'anchorDate', 'sourceType'])
    const ids = await instantiateTemplate(ctx.tx, {
      templateId: asUuid(b.templateId, 'templateId'),
      subjectEmployeeId: asUuid(b.employeeId, 'employeeId'),
      anchorDate: asDate(b.anchorDate, 'anchorDate'),
      sourceType: b.sourceType,
      resolveAssignee: (rule) => b.assignees?.[rule],
    })
    return created({ taskIds: ids })
  }))

router.get('/api/v1/employees/:id/offboarding-blockers',
  { summary: 'Open blocking tasks preventing exit sign-off', tag: 'inbox', permission: 'task.read' },
  authed('task.read', async (ctx) =>
    ok({ blockers: await blockingTasksOpen(ctx.tx, asUuid(ctx.req.params.id, 'id'), 'offboarding') })))

// ---------------------------------------------------------------------------
// Payroll
// ---------------------------------------------------------------------------

router.post('/api/v1/payroll/runs',
  { summary: 'Start a payroll run for a period', tag: 'payroll', permission: 'payroll.process',
    requestExample: { periodId: '…' } },
  authed('payroll.process', async (ctx) => {
    requireModule(ctx, 'payroll.enabled')
    const b = requireBody<{ periodId: string }>(ctx.req, ['periodId'])
    const id = await createRun(ctx.tx, {
      periodId: asUuid(b.periodId, 'periodId'), processedByUserId: ctx.auth.userId,
    })
    return created({ id })
  }))

router.post('/api/v1/payroll/runs/:id/freeze',
  { summary: 'Freeze inputs — the boundary after which payroll reads only itself',
    tag: 'payroll', permission: 'payroll.process' },
  authed('payroll.process', async (ctx) => {
    const b = requireBody<{ rows: unknown[] }>(ctx.req, ['rows'])
    const statutory = await loadStatutory(ctx.tx)
    const n = await freezeInputs(
      ctx.tx, asUuid(ctx.req.params.id, 'id'), b.rows as never,
      { lop_basis: ctx.config.get('payroll.lop_basis'),
        pf_on_full_wage: ctx.config.get('payroll.pf_on_full_wage') },
      statutory.id)
    return ok({ frozen: n })
  }))

router.post('/api/v1/payroll/runs/:id/unfreeze',
  { summary: 'Unfreeze — available only before calculation, and audited', tag: 'payroll',
    permission: 'payroll.process' },
  authed('payroll.process', async (ctx) => {
    await unfreezeInputs(ctx.tx, asUuid(ctx.req.params.id, 'id'))
    return ok({ unfrozen: true })
  }))

router.post('/api/v1/payroll/runs/:id/calculate',
  { summary: 'Calculate the run', tag: 'payroll', permission: 'payroll.process' },
  authed('payroll.process', async (ctx) => {
    const statutory = await loadStatutory(ctx.tx)
    const totals = await calculate(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
      statutory: statutory.config,
      ptAmountPaise: (state, gross) => ptFor(statutory.ptSlabs, state, gross),
      pfOnFullWage: ctx.config.get<boolean>('payroll.pf_on_full_wage'),
      lopBasis: ctx.config.get<'calendar_days' | 'fixed_30' | 'working_days'>('payroll.lop_basis'),
      computeTds: tdsFor(statutory),
    })
    return ok({
      grossPaise: String(totals.gross),
      deductionsPaise: String(totals.deductions),
      netPaise: String(totals.net),
    })
  }))

router.get('/api/v1/payroll/runs/:id/validation',
  { summary: 'Blockers and warnings for a calculated run', tag: 'payroll', permission: 'payroll.read' },
  authed('payroll.read', async (ctx) => {
    const statutory = await loadStatutory(ctx.tx)
    const result = await validate(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
      statutory: statutory.config,
      ptAmountPaise: (state, gross) => ptFor(statutory.ptSlabs, state, gross),
      pfOnFullWage: ctx.config.get<boolean>('payroll.pf_on_full_wage'),
      lopBasis: ctx.config.get<'calendar_days' | 'fixed_30' | 'working_days'>('payroll.lop_basis'),
      computeTds: tdsFor(statutory),
      variancePct: ctx.config.get<number>('payroll.variance_warning_pct'),
    })
    return ok(result)
  }))

router.post('/api/v1/payroll/runs/:id/approve',
  { summary: 'Approve a validated run (never the person who ran it)', tag: 'payroll',
    permission: 'payroll.approve' },
  authed('payroll.approve', async (ctx) => {
    await approve(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId, {
      requireSeparateApprover: ctx.config.get<boolean>('payroll.require_separate_approver'),
    })
    return ok({ approved: true })
  }))

router.post('/api/v1/payroll/runs/:id/lock',
  { summary: 'Lock the run. Irreversible; corrections become revisions', tag: 'payroll',
    permission: 'payroll.lock' },
  authed('payroll.lock', async (ctx) => {
    const id = asUuid(ctx.req.params.id, 'id')
    await lock(ctx.tx, id, ctx.auth.userId, {
      requireSeparateApprover: ctx.config.get<boolean>('payroll.require_separate_approver'),
    })
    await emit(ctx.tx, {
      action: 'payroll.run.locked', entityType: 'payroll_run', entityId: id,
      actorUserId: ctx.auth.userId,
    })
    return ok({ locked: true })
  }))

router.post('/api/v1/payroll/runs/:id/revise',
  { summary: 'Create the next revision of a locked run', tag: 'payroll', permission: 'payroll.revise',
    requestExample: { reason: 'regularization approved late for 3 employees' } },
  authed('payroll.revise', async (ctx) => {
    const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
    const id = asUuid(ctx.req.params.id, 'id')
    const newId = await revise(ctx.tx, id, { reason: b.reason, processedByUserId: ctx.auth.userId })
    await emit(ctx.tx, {
      action: 'payroll.run.revised', entityType: 'payroll_run', entityId: newId,
      actorUserId: ctx.auth.userId, reason: b.reason, metadata: { supersedes: id },
    })
    return created({ id: newId })
  }))

router.get('/api/v1/payroll/runs/:id',
  { summary: 'Run status and totals', tag: 'payroll', permission: 'payroll.read' },
  authed('payroll.read', async (ctx) => ok({ run: await getRun(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

router.get('/api/v1/payroll/runs/:id/delta',
  { summary: 'What changed against the run this one supersedes', tag: 'payroll',
    permission: 'payroll.read' },
  authed('payroll.read', async (ctx) =>
    ok({ delta: await delta(ctx.tx, asUuid(ctx.req.params.id, 'id')) })))

router.get('/api/v1/payslips',
  { summary: 'Payslips, own by default', tag: 'payroll', permission: 'payroll.read' },
  authed('payroll.read', async (ctx) => {
    const employeeId = ctx.req.query.get('employeeId') ?? ctx.auth.employeeId
    assertScope(ctx.auth, employeeId ?? undefined)
    const { rows } = await ctx.tx.query(
      `SELECT p.id, p.run_id, p.gross_paise::text, p.deductions_paise::text, p.net_paise::text,
              pp.label AS period
         FROM payslips p
         JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
         JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
        WHERE p.employee_id = $1 AND r.status = 'locked'
        ORDER BY pp.period_start DESC`,
      [employeeId])
    return ok({ payslips: rows })
  }))

router.get('/api/v1/payslips/:id/lines',
  { summary: 'The full component breakdown behind a payslip', tag: 'payroll',
    permission: 'payroll.read' },
  authed('payroll.read', async (ctx) => {
    const { rows: slip } = await ctx.tx.query<{ employee_id: string; run_id: string }>(
      `SELECT employee_id, run_id FROM payslips WHERE id = $1`, [asUuid(ctx.req.params.id, 'id')])
    if (!slip[0]) throw new HttpError(404, 'NOT_FOUND', 'no such payslip')
    assertScope(ctx.auth, slip[0].employee_id)

    const { rows } = await ctx.tx.query(
      `SELECT component_code, component_type, amount_paise::text, calc_note
         FROM payroll_lines WHERE run_id = $1 AND employee_id = $2
        ORDER BY component_type, component_code`,
      [slip[0].run_id, slip[0].employee_id])
    return ok({ lines: rows })
  }))

// ---------------------------------------------------------------------------
// Helpdesk
// ---------------------------------------------------------------------------

router.get('/api/v1/tickets',
  { summary: 'Tickets visible to the caller (confidential ones are filtered by policy)',
    tag: 'helpdesk', permission: 'ticket.read' },
  authed('ticket.read', async (ctx) => {
    requireModule(ctx, 'helpdesk.enabled')
    const { rows } = await ctx.tx.query(
      `SELECT id, ticket_number, title, status, priority, is_confidential,
              sla_resolution_due_at, sla_resolution_breached, created_at
         FROM tickets ORDER BY created_at DESC LIMIT 200`)
    return ok({ tickets: rows })
  }))

router.post('/api/v1/tickets',
  { summary: 'Raise a ticket', tag: 'helpdesk', permission: 'ticket.write',
    requestExample: { categoryId: '…', title: 'Salary is short', description: 'August net looks wrong' } },
  authed('ticket.write', async (ctx) => {
    requireModule(ctx, 'helpdesk.enabled')
    const b = requireBody<{ categoryId: string; title: string; description: string; priority?: string }>(
      ctx.req, ['categoryId', 'title', 'description'])
    const id = await raiseTicket(ctx.tx, {
      categoryId: asUuid(b.categoryId, 'categoryId'), raisedByUserId: ctx.auth.userId,
      subjectEmployeeId: ctx.auth.employeeId, title: b.title, description: b.description,
      priority: b.priority as never,
    })
    return created({ id })
  }))

router.post('/api/v1/tickets/:id/messages',
  { summary: 'Reply on a ticket', tag: 'helpdesk', permission: 'ticket.write' },
  authed('ticket.write', async (ctx) => {
    const b = requireBody<{ body: string; internal?: boolean }>(ctx.req, ['body'])
    await respond(ctx.tx, asUuid(ctx.req.params.id, 'id'), {
      authorUserId: ctx.auth.userId, body: b.body, internal: b.internal,
    })
    return created({ posted: true })
  }))

router.post('/api/v1/tickets/:id/status',
  { summary: 'Change ticket status (pauses the SLA clock when waiting on the employee)',
    tag: 'helpdesk', permission: 'ticket.assign' },
  authed('ticket.assign', async (ctx) => {
    const b = requireBody<{ status: string }>(ctx.req, ['status'])
    await setStatus(ctx.tx, asUuid(ctx.req.params.id, 'id'), b.status, { actorUserId: ctx.auth.userId })
    return ok({ status: b.status })
  }))

// ---------------------------------------------------------------------------
// Incentives
// ---------------------------------------------------------------------------

router.post('/api/v1/incentives/periods/:id/close',
  { summary: 'Close an incentive period before calculating', tag: 'incentives',
    permission: 'incentive.write' },
  authed('incentive.write', async (ctx) => {
    await closePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'))
    return ok({ closed: true })
  }))

router.post('/api/v1/incentives/periods/:id/calculate',
  { summary: 'Calculate incentives for a closed period', tag: 'incentives',
    permission: 'incentive.write' },
  authed('incentive.write', async (ctx) => {
    const n = await calculatePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'))
    return ok({ calculated: n })
  }))

router.post('/api/v1/incentives/periods/:id/approve',
  { summary: 'Approve calculated incentives', tag: 'incentives', permission: 'incentive.approve' },
  authed('incentive.approve', async (ctx) => {
    await approvePeriod(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
    return ok({ approved: true })
  }))

router.post('/api/v1/incentives/periods/:id/push',
  { summary: 'Push approved incentives into a draft payroll run', tag: 'incentives',
    permission: 'incentive.approve', requestExample: { payrollRunId: '…' } },
  authed('incentive.approve', async (ctx) => {
    const b = requireBody<{ payrollRunId: string }>(ctx.req, ['payrollRunId'])
    return ok(await pushToPayroll(ctx.tx, asUuid(ctx.req.params.id, 'id'), asUuid(b.payrollRunId, 'payrollRunId')))
  }))

router.post('/api/v1/incentives/clawback',
  { summary: 'Claw back a paid incentive as a next-period adjustment', tag: 'incentives',
    permission: 'incentive.write' },
  authed('incentive.write', async (ctx) => {
    const b = requireBody<{ employeeId: string; planId: string; nextPeriodId: string; amountPaise: number; note: string }>(
      ctx.req, ['employeeId', 'planId', 'nextPeriodId', 'amountPaise', 'note'])
    await clawback(ctx.tx, {
      employeeId: asUuid(b.employeeId, 'employeeId'), planId: asUuid(b.planId, 'planId'),
      nextPeriodId: asUuid(b.nextPeriodId, 'nextPeriodId'),
      amountPaise: asInt(b.amountPaise, 'amountPaise', { min: 1 }), note: b.note,
    })
    return ok({ applied: true })
  }))

// ---------------------------------------------------------------------------
// Announcements and notifications
// ---------------------------------------------------------------------------

router.post('/api/v1/announcements/:id/publish',
  { summary: 'Publish to an audience and start tracking acknowledgement', tag: 'comms',
    permission: 'announcement.create', requestExample: { audienceUserIds: ['…'] } },
  authed('announcement.create', async (ctx) => {
    const b = requireBody<{ audienceUserIds: string[] }>(ctx.req, ['audienceUserIds'])
    const n = await publishAnnouncement(ctx.tx, {
      announcementId: asUuid(ctx.req.params.id, 'id'), audienceUserIds: b.audienceUserIds,
    })
    return ok({ delivered: n })
  }))

router.post('/api/v1/announcements/:id/acknowledge',
  { summary: 'Acknowledge an announcement', tag: 'comms', permission: 'announcement.read' },
  authed('announcement.read', async (ctx) => {
    await acknowledge(ctx.tx, asUuid(ctx.req.params.id, 'id'), ctx.auth.userId)
    return ok({ acknowledged: true })
  }))

router.get('/api/v1/announcements/:id/acknowledgements',
  { summary: 'Who has acknowledged, and who has not', tag: 'comms', permission: 'announcement.create' },
  authed('announcement.create', async (ctx) =>
    ok(await acknowledgementStats(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

router.get('/api/v1/notifications',
  { summary: 'In-app notifications for the current user', tag: 'comms' },
  authed(null, async (ctx) => {
    const { rows } = await ctx.tx.query(
      `SELECT id, event_type, title, body, entity_type, entity_id, read_at, created_at
         FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 100`,
      [ctx.auth.userId])
    return ok({ notifications: rows, unread: await unreadCount(ctx.tx, ctx.auth.userId) })
  }))

// ---------------------------------------------------------------------------
// Activity log
// ---------------------------------------------------------------------------

router.get('/api/v1/activity',
  { summary: 'The company activity log', tag: 'audit', permission: 'audit.read' },
  authed('audit.read', async (ctx) => ok({
    events: await activity(ctx.tx, {
      category: ctx.req.query.get('category') ?? undefined,
      severity: (ctx.req.query.get('severity') ?? undefined) as never,
      limit: Number(ctx.req.query.get('limit') ?? 100),
    }),
  })))

router.get('/api/v1/activity/verify',
  { summary: 'Re-walk the audit hash chain and report any break', tag: 'audit',
    permission: 'audit.read' },
  authed('audit.read', async (ctx) => ok(await verifyChain(ctx.tx))))

router.get('/api/v1/me/record-access',
  { summary: 'Who has accessed my record, including my salary', tag: 'audit' },
  authed(null, async (ctx) => {
    if (!ctx.auth.employeeId) return ok({ access: [] })
    return ok({ access: await myRecordAccess(ctx.tx, ctx.auth.employeeId) })
  }))

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

router.get('/api/v1/roles',
  { summary: 'Seeded roles, custom roles and the full permission vocabulary',
    tag: 'config', permission: 'roles.write' },
  authed('roles.write', async (ctx) => {
    const { rows: custom } = await ctx.tx.query(
      `SELECT id, name, description, permissions, data_scope FROM custom_roles ORDER BY name`)
    return ok({
      seededRoles: Object.entries(ROLE_PERMISSIONS).map(([name, d]) => ({
        name, scope: d.scope, permissions: d.permissions,
      })),
      customRoles: custom,
      allPermissions: PERMISSIONS,
    })
  }))

router.post('/api/v1/roles',
  { summary: 'Create a custom role for this company', tag: 'config', permission: 'roles.write',
    requestExample: { name: 'Regional HR', permissions: ['employee.read', 'leave.approve'], dataScope: 'reports' } },
  authed('roles.write', async (ctx) => {
    const b = requireBody<{ name: string; permissions: string[]; dataScope?: string; description?: string }>(
      ctx.req, ['name', 'permissions'])
    const unknown = b.permissions.filter((p) => !(PERMISSIONS as readonly string[]).includes(p))
    if (unknown.length) {
      throw new HttpError(422, 'UNKNOWN_PERMISSION', `not a permission: ${unknown.join(', ')}`, { unknown })
    }
    const { rows } = await ctx.tx.query<{ id: string }>(
      `INSERT INTO custom_roles (tenant_id, name, description, permissions, data_scope)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [ctx.auth.tenantId, b.name, b.description ?? null, b.permissions, b.dataScope ?? 'self'])
    return created({ id: rows[0]!.id })
  }))

export { resolveSession }
