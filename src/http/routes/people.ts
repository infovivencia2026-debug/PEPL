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
import { normaliseComponents, resolveForEmployee, structureByCode } from '../../payroll/structures.ts'
import { loadStatutory } from '../../payroll/statutory.ts'
import { hold } from '../../approvals/pending.ts'
import { listBankAccounts, setBankAccount, loginFor, inviteEmployee } from '../../people/onboard.ts'
import { updateEmployee, listFieldDefinitions, defineField, retireField, SELF_EDITABLE, type EmployeePatch } from '../../people/profile.ts'
import { notify } from '../../comms/index.ts'

function publicUrl(req: { headers: Record<string, string | string[] | undefined> }): string {
  return process.env.PEPL_PUBLIC_URL
    ?? `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${String(req.headers.host ?? 'localhost')}`
}

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
      assertScope(ctx.auth, id, 'employee.read')
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
      assertScope(ctx.auth, id, 'employee.read')
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
      assertScope(ctx.auth, id, 'employee.write')
      const b = requireBody<{ department: string; designation: string; managerEmployeeId?: string | null; locationCode?: string | null; gradeCode?: string | null; effectiveFrom: string; reason?: string }>(
        ctx.req, ['department', 'designation', 'effectiveFrom'])
      const recordId = await changeAssignment(ctx.tx, {
        employeeId: id, department: b.department, designation: b.designation,
        managerEmployeeId: b.managerEmployeeId === undefined ? undefined : (b.managerEmployeeId ? asUuid(b.managerEmployeeId, 'managerEmployeeId') : null),
        locationCode: b.locationCode, gradeCode: b.gradeCode,
        effectiveFrom: asDate(b.effectiveFrom, 'effectiveFrom'),
        reason: b.reason, actorUserId: ctx.auth.userId,
      })
      await emit(ctx.tx, {
        action: 'people.assignment.changed', entityType: 'employee', entityId: id,
        subjectEmployeeId: id, actorUserId: ctx.auth.userId,
        after: { department: b.department, designation: b.designation, managerEmployeeId: b.managerEmployeeId ?? null, effectiveFrom: b.effectiveFrom },
        reason: b.reason,
      })
      return created({ id: recordId })
    }))

  router.patch('/api/v1/employees/:id',
    { summary: 'Correct or complete the employee record (personal, employment, statutory flags, custom fields)', tag: 'people',
      permission: 'employee.read',
      requestExample: { dateOfBirth: '1994-06-12', workEmail: 'priya@acme.com', phone: '+91 98765 43210', employmentType: 'permanent', pfApplicable: true, customFields: { tshirt_size: 'M' } } },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id, 'employee.read')
      const b = requireBody<Record<string, unknown>>(ctx.req, []) as EmployeePatch
      // An employee may fix their own contact details; everything else is HR (employee.write).
      if (!can(ctx.auth, 'employee.write')) {
        const disallowed = Object.keys(b).filter((k) => !SELF_EDITABLE.includes(k as keyof EmployeePatch))
        if (disallowed.length) throw new HttpError(403, 'PERMISSION_DENIED', `only HR can change: ${disallowed.join(', ')}`)
        if (ctx.auth.employeeId !== id) throw new HttpError(403, 'PERMISSION_DENIED', 'you can only edit your own contact details')
      }
      const { changed } = await updateEmployee(ctx.tx, id, b)
      if (Object.keys(changed).length) {
        await emit(ctx.tx, { action: 'people.employee.updated', entityType: 'employee', entityId: id, subjectEmployeeId: id,
          actorUserId: ctx.auth.userId, before: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.before])),
          after: Object.fromEntries(Object.entries(changed).map(([k, v]) => [k, v.after])) })
      }
      return ok({ changed: Object.keys(changed) })
    }))

  router.get('/api/v1/employee-fields',
    { summary: 'The company\'s custom employee fields', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => ok({ fields: await listFieldDefinitions(ctx.tx, ctx.req.query.get('includeRetired') === 'true') })))

  router.post('/api/v1/employee-fields',
    { summary: 'Define (or redefine) a custom employee field', tag: 'people', permission: 'settings.write',
      requestExample: { key: 'tshirt_size', label: 'T-shirt size', kind: 'select', options: ['S', 'M', 'L', 'XL'], selfEditable: true } },
    authed('settings.write', async (ctx) => {
      const b = requireBody<{ key: string; label: string; kind: 'text' | 'number' | 'date' | 'boolean' | 'select'; options?: string[]; required?: boolean; selfEditable?: boolean; sortOrder?: number }>(
        ctx.req, ['key', 'label', 'kind'])
      const f = await defineField(ctx.tx, b)
      await emit(ctx.tx, { action: 'people.field.defined', entityType: 'employee_field', entityId: f.id, actorUserId: ctx.auth.userId, after: { key: f.key, kind: f.kind } })
      return created(f)
    }))

  router.post('/api/v1/employee-fields/:key/retire',
    { summary: 'Retire a custom field; stored values are kept', tag: 'people', permission: 'settings.write' },
    authed('settings.write', async (ctx) => {
      await retireField(ctx.tx, String(ctx.req.params.key))
      await emit(ctx.tx, { action: 'people.field.retired', entityType: 'employee_field', actorUserId: ctx.auth.userId, metadata: { key: ctx.req.params.key } })
      return ok({ retired: true })
    }))

  router.get('/api/v1/employees/:id/bank-accounts',
    { summary: 'Bank accounts on file (masked); ?history=true includes superseded ones', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id, 'employee.read')
      const accounts = await listBankAccounts(ctx.tx, id, ctx.req.query.get('history') === 'true')
      // The full account number is for the person and for an audited reveal; everyone else gets the masked form.
      const own = ctx.auth.employeeId === id
      if (!own && ctx.req.query.get('reveal') === 'true' && can(ctx.auth, 'bank.export')) {
        await emit(ctx.tx, { action: 'access.tier3.revealed', entityType: 'employee', entityId: id, subjectEmployeeId: id, actorUserId: ctx.auth.userId, metadata: { document: 'bank_accounts' } })
        return ok({ accounts, masked: false })
      }
      if (own) return ok({ accounts, masked: false })
      return ok({ accounts: accounts.map((a) => ({ ...a, account_number: a.account_masked })), masked: true })
    }))

  router.post('/api/v1/employees/:id/bank-accounts',
    { summary: 'Record the account salary is paid into; the previous one is superseded, never edited', tag: 'people',
      permission: 'compensation.write',
      requestExample: { beneficiaryName: 'Priya Sharma', accountNumber: '50100123456789', ifsc: 'HDFC0001234', bankName: 'HDFC Bank' } },
    // Where a salary is paid is a payroll decision: compensation.write, which hr_admin deliberately does
    // NOT hold. It was employee.write, so general HR could redirect anyone's pay to an account of their
    // choosing -- while payroll, who own the bank file, were refused.
    authed('compensation.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id, 'compensation.write')
      const b = requireBody<{ beneficiaryName: string; accountNumber: string; ifsc: string; bankName?: string; effectiveFrom?: string }>(
        ctx.req, ['beneficiaryName', 'accountNumber', 'ifsc'])
      const account = await setBankAccount(ctx.tx, {
        employeeId: id, beneficiaryName: b.beneficiaryName, accountNumber: b.accountNumber, ifsc: b.ifsc,
        bankName: b.bankName, effectiveFrom: b.effectiveFrom ? asDate(b.effectiveFrom, 'effectiveFrom') : undefined,
      })
      await emit(ctx.tx, {
        action: 'people.bank_account.changed', entityType: 'employee', entityId: id, subjectEmployeeId: id,
        actorUserId: ctx.auth.userId, after: { account: account.account_masked, ifsc: account.ifsc },
      })
      return created(account)
    }))

  router.get('/api/v1/employees/:id/login',
    { summary: 'Whether this person has a login, and its roles', tag: 'people', permission: 'employee.read' },
    authed('employee.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id, 'employee.read')
      return ok(await loginFor(ctx.tx, id))
    }))

  router.post('/api/v1/employees/:id/invite',
    { summary: 'Create the person\'s login (or re-issue their link) and send them a set-password link', tag: 'people',
      permission: 'employee.write', requestExample: { email: 'priya@acme.com', roles: ['employee'] } },
    authed('employee.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id, 'employee.write')
      const b = requireBody<{ email: string; roles?: string[] }>(ctx.req, ['email'])
      if (b.roles?.length && !can(ctx.auth, 'roles.write')) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'assigning roles other than employee needs roles.write')
      }
      const r = await inviteEmployee(ctx.tx, {
        employeeId: id, email: b.email, roles: b.roles, issuedByUserId: ctx.auth.userId, ip: ctx.req.ip,
        allowPrivilegedReissue: can(ctx.auth, 'roles.write'),
      })
      const link = `${publicUrl(ctx.req)}/reset-password?token=${r.token}`
      // Email it when the company has a sender mailbox; the link is returned either way
      // so HR can hand it over in person when mail is not set up.
      await notify(ctx.tx, {
        userId: r.userId, eventType: 'security.login.invited', title: 'Your PEPL login',
        body: `Set your password here (link valid for 30 minutes): ${link}`, channels: ['email'],
        dedupeKey: `invite:${r.userId}:${r.token.slice(0, 8)}`,
      })
      await emit(ctx.tx, {
        action: 'people.login.invited', entityType: 'user', entityId: r.userId, subjectEmployeeId: id,
        actorUserId: ctx.auth.userId, metadata: { email: r.email, created: r.created, roles: r.created ? (b.roles?.length ? b.roles : ['employee']) : undefined },
      })
      // The link is in the response only for a login that has just been created, when nobody
      // else can be locked out by it. For an existing login it goes to that person's mailbox
      // alone: returning it here would let the caller sign in as them.
      return (r.created ? created : ok)({
        userId: r.userId, email: r.email, created: r.created, ...(r.created ? { link } : {}), expiresAt: r.expiresAt.toISOString(),
      })
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
        const statutory = await loadStatutory(ctx.tx, b.effectiveFrom)
        components = await resolveForEmployee(ctx.tx, structure, b.annualCtcPaise, statutory.config, ctx.config.get<boolean>('payroll.pf_on_full_wage'))
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
      assertScope(ctx.auth, id, 'employee.read')
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
