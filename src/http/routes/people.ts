/** People. */
import type { Router } from '../router.ts'
import {
  HttpError,
  authed,
  ok,
  created,
  requireBody,
  asDate,
  asInt,
  asUuid,
  assertScope,
  can,
  changeAssignment,
  changeCompensation,
  correctAssignment,
  correctCompensation,
  profileAt,
  emit,
} from './deps.ts'
import { normaliseComponents, resolveStructure, structureByCode } from '../../payroll/structures.ts'
import { hold } from '../../approvals/pending.ts'

export function register(router: Router): void {
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
        `SELECT p.employee_id, p.employee_number, p.first_name, p.last_name, p.status,
                p.date_of_joining, p.department, p.designation,
                (SELECT u.id FROM app_users u WHERE u.employee_id = p.employee_id LIMIT 1) AS user_id
           FROM current_employee_profile p
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
      const b = requireBody<{ annualCtcPaise: number; components?: Record<string, number>; structureCode?: string; effectiveFrom: string; reason: string }>(
        ctx.req, ['annualCtcPaise', 'effectiveFrom', 'reason'])
      if (!Number.isSafeInteger(b.annualCtcPaise) || b.annualCtcPaise <= 0) {
        throw new HttpError(422, 'VALIDATION_FAILED', 'annualCtcPaise must be a positive integer')
      }
      // A structure turns the annual figure into the breakdown; hand-entered
      // components are checked against the master once one exists.
      let components: Record<string, number> | undefined
      let structureCode: string | undefined
      if (b.structureCode) {
        const structure = await structureByCode(ctx.tx, String(b.structureCode))
        components = resolveStructure(structure.lines, b.annualCtcPaise)
        structureCode = structure.code
      } else if (b.components) {
        components = await normaliseComponents(ctx.tx, b.components)
      }
      // Held for approval when the company says so; the magnitude is the hike
      // against the current CTC, so a policy can route big ones further.
      const chain = ctx.config.get<string>('payroll.compensation_approval')
      if (chain !== 'none') {
        const { rows: cur } = await ctx.tx.query<{ annual_ctc_paise: string }>(
          `SELECT annual_ctc_paise::text FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL
            AND (effective_to IS NULL OR effective_to > CURRENT_DATE) ORDER BY effective_from DESC LIMIT 1`, [id])
        const delta = b.annualCtcPaise - Number(cur[0]?.annual_ctc_paise ?? 0)
        const held = await hold(ctx.tx, {
          kind: 'compensation', subjectEmployeeId: id, requestedByUserId: ctx.auth.userId,
          payload: { annualCtcPaise: b.annualCtcPaise, components, structureCode, effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'), reason: b.reason },
          magnitude: Math.max(0, delta), fallback: chain as never,
          title: `Salary revision · ₹${Math.round(b.annualCtcPaise / 100).toLocaleString('en-IN')} from ${b.effectiveFrom}`,
        })
        await emit(ctx.tx, {
          action: 'people.compensation.requested', entityType: 'employee', entityId: id,
          subjectEmployeeId: id, actorUserId: ctx.auth.userId, reason: b.reason,
          metadata: { annualCtcPaise: b.annualCtcPaise, effectiveFrom: b.effectiveFrom, approvalRequestId: held.requestId, chain: held.chainCode },
        })
        return { status: 202, body: { held: true, pendingId: held.pendingId, approvalRequestId: held.requestId, chain: held.chainCode } }
      }
      const recordId = await changeCompensation(ctx.tx, {
        employeeId: id, annualCtcPaise: b.annualCtcPaise, components, structureCode,
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
      const limit = asInt(ctx.req.query.get('limit') ?? 100, 'limit', { min: 1, max: 500 })
      const offset = asInt(ctx.req.query.get('offset') ?? 0, 'offset', { min: 0 })
      const { rows } = await ctx.tx.query(
        `SELECT 'assignment' AS kind, effective_from::text AS effective_on,
                department || ' · ' || designation AS detail, change_reason AS reason, recorded_at
           FROM employee_assignments WHERE employee_id = $1 AND superseded_at IS NULL
         UNION ALL
         SELECT 'compensation', effective_from::text,
                CASE WHEN $2 THEN 'CTC ' || (annual_ctc_paise / 100)::text ELSE 'compensation changed' END,
                change_reason, recorded_at
           FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL
         ORDER BY effective_on DESC, recorded_at DESC
         LIMIT $3 OFFSET $4`,
        [id, can(ctx.auth, 'compensation.read'), limit + 1, offset])
      return ok({ timeline: rows.slice(0, limit), hasMore: rows.length > limit, offset })
    }))
}
