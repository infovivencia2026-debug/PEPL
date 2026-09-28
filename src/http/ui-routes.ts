import { Router, HttpError } from './router.ts'
import {
  authed,
  requireRecentMfa,
  ok,
  created,
  requireBody,
  asUuid,
  requireModule,
  type Ctx,
} from './context.ts'
import { completeCompanyChoice, revokeSession } from '../auth/index.ts'
import { unifiedLogin } from '../auth/unified-login.ts'
import { assertPermission, assertScope, can } from '../authz/permissions.ts'
import { changeAssignment } from '../people/history.ts'
import { applyCorrection, type CorrectionAction } from '../attendance/index.ts'
import { taskInbox, completeTask } from '../work/tasks.ts'
import { acknowledge } from '../comms/index.ts'
import {
  approve,
  lock,
  revise,
  createRun,
  calculate,
  validate,
  freezeInputs,
  unfreezeInputs,
  type FreezeRow,
} from '../payroll/run.ts'
import { loadStatutory, ptFor } from '../payroll/statutory.ts'
import { REGISTRY } from '../config-registry/index.ts'
import { setSetting } from '../config/write.ts'
import { emit } from '../audit/index.ts'
import { workspaceData } from './ui-data.ts'
import { registerUiLeave } from './ui-leave.ts'

export function textField(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max)
    throw new HttpError(
      422,
      'VALIDATION_FAILED',
      `${name} is required (up to ${max} characters)`,
    )
  return v.trim()
}
export function dateField(v: unknown, name: string): string {
  const s = textField(v, name, 10)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(s) ||
    !Number.isFinite(Date.parse(s)) ||
    new Date(s).toISOString().slice(0, 10) !== s
  )
    throw new HttpError(
      422,
      'VALIDATION_FAILED',
      `${name} must be a valid date`,
    )
  return s
}
export function orgScope(c: Ctx) {
  if (c.auth.scope !== 'all')
    throw new HttpError(
      403,
      'PERMISSION_DENIED',
      'This action requires company-wide access',
    )
}
const cookie = (token: string, maxAge = 2592000) =>
  `pepl_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`
const audit = (
  c: Ctx,
  action: string,
  entityType: string,
  entityId: string,
  reason?: string,
  subjectEmployeeId?: string,
) =>
  emit(c.tx, {
    action,
    entityType,
    entityId,
    reason,
    subjectEmployeeId,
    actorUserId: c.auth.userId,
  })
export function buildUiRouter() {
  const r = new Router(),
    prefix = '/api/ui'
  r.post(
    prefix + '/auth/login',
    { summary: 'Browser sign in', tag: 'auth', public: true },
    async (req) => {
      const b = requireBody(req, ['email', 'password'])
      // THE one front door: this is the route the browser actually posts to.
      // An employee, their HR admin and a PEPL operator all arrive here, and
      // `kind` says which -- derived from WHICH IDENTITY STORE held the
      // address, never from anything the caller sent.
      const s = await unifiedLogin({
        email: textField(b.email, 'Email').toLowerCase(),
        password: textField(b.password, 'Password', 1024),
        ip: req.ip,
      })
      // An operator. Deliberately NOT a cookie: the console is a separate
      // bundle that sends the token as a bearer header out of sessionStorage,
      // and putting an operator credential in the cookie the product sends on
      // every request is exactly the confusion the separate stores exist to
      // prevent.
      if (s.kind === 'platform') {
        return {
          status: 200,
          body: { kind: 'platform', token: s.token, expiresAt: s.expiresAt, mfaPending: s.mfaPending },
        }
      }
      // The password opened more than one company: no cookie yet, because a
      // session belongs to exactly one of them. The browser asks, then posts
      // the answer to /auth/login/company.
      if (s.kind === 'choose') {
        return { status: 200, body: { kind: 'tenant', chooseCompany: true, choiceToken: s.choiceToken, companies: s.companies } }
      }
      return {
        status: 200,
        body: { kind: 'tenant', expiresAt: s.expiresAt },
        headers: { 'set-cookie': cookie(s.token) },
      }
    },
  )

  r.post(
    prefix + '/auth/login/company',
    { summary: 'Browser: finish a login that opened more than one company', tag: 'auth' },
    async (req) => {
      const b = requireBody(req, ['choiceToken', 'tenantId'])
      const s = await completeCompanyChoice({
        choiceToken: textField(b.choiceToken, 'Choice token', 512),
        tenantId: asUuid(b.tenantId, 'Company'),
        ip: req.ip,
      })
      return {
        status: 200,
        body: { expiresAt: s.expiresAt },
        headers: { 'set-cookie': cookie(s.token) },
      }
    },
  )
  r.post(
    prefix + '/auth/logout',
    { summary: 'Browser sign out', tag: 'auth' },
    authed(null, async (c) => {
      await revokeSession(c.tx, c.session.sessionId)
      return {
        status: 200,
        body: { signedOut: true },
        headers: { 'set-cookie': cookie('', 0) },
      }
    }),
  )
  r.get(
    prefix + '/workspace',
    { summary: 'Permitted workspace data', tag: 'workspace' },
    authed(null, async (c) =>
      ok(
        await workspaceData(
          c,
          c.req.query.has('date')
            ? dateField(c.req.query.get('date'), 'Date')
            : undefined,
        ),
      ),
    ),
  )
  r.post(
    prefix + '/employees',
    { summary: 'Add employee and initial assignment', tag: 'people' },
    authed('employee.write', async (c) => {
      orgScope(c)
      const b = requireBody(c.req, [
        'firstName',
        'employeeNumber',
        'dateOfJoining',
        'department',
        'designation',
      ])
      await c.tx.query('SELECT id FROM tenants WHERE id=$1 FOR UPDATE', [
        c.auth.tenantId,
      ])
      const count = (
        await c.tx.query(
          "SELECT count(*)::int AS n FROM employees WHERE status<>'exited'",
        )
      ).rows[0]!.n as number
      if (count >= c.config.limit('employees'))
        throw new HttpError(
          403,
          'EMPLOYEE_LIMIT_REACHED',
          'Your employee limit has been reached. Contact your administrator to update your plan.',
        )
      const joining = dateField(b.dateOfJoining, 'Joining date'),
        first = textField(b.firstName, 'First name')
      const { rows } = await c.tx.query(
        'INSERT INTO employees(tenant_id,employee_number,first_name,last_name,date_of_joining) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [
          c.auth.tenantId,
          textField(b.employeeNumber, 'Employee number'),
          first,
          typeof b.lastName === 'string'
            ? b.lastName.trim().slice(0, 200)
            : null,
          joining,
        ],
      )
      const id = rows[0]!.id as string
      await changeAssignment(c.tx, {
        employeeId: id,
        department: textField(b.department, 'Department'),
        designation: textField(b.designation, 'Job title'),
        effectiveFrom: joining,
        reason: 'Initial employment assignment',
        actorUserId: c.auth.userId,
      })
      await audit(c, 'people.employee.created', 'employee', id, undefined, id)
      return created({ id })
    }),
  )
  r.get(
    prefix + '/employees/:id',
    { summary: 'Profile and employment history', tag: 'people' },
    authed('employee.read', async (c) => {
      const id = asUuid(c.req.params.id, 'Employee')
      assertScope(c.auth, id)
      const { rows } = await c.tx.query(
        'SELECT id,employee_number,first_name,last_name,status,date_of_joining::text,date_of_exit::text,erased_at::text FROM employees WHERE id=$1',
        [id],
      )
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Employee not found')
      const assignments = (
        await c.tx.query(
          'SELECT id,department,designation,effective_from::text,effective_to::text,change_reason,superseded_at FROM employee_assignments WHERE employee_id=$1 ORDER BY effective_from DESC',
          [id],
        )
      ).rows
      const compensation = can(c.auth, 'compensation.read')
        ? (
            await c.tx.query(
              'SELECT id,annual_ctc_paise::text,effective_from::text,effective_to::text,change_reason FROM compensation_records WHERE employee_id=$1 AND superseded_at IS NULL ORDER BY effective_from DESC',
              [id],
            )
          ).rows
        : []
      return ok({ employee: rows[0], assignments, compensation })
    }),
  )
  r.post(
    prefix + '/employees/:id/assignments',
    { summary: 'Change employment assignment', tag: 'people' },
    authed('employee.write', async (c) => {
      const id = asUuid(c.req.params.id, 'Employee')
      assertScope(c.auth, id)
      const b = requireBody(c.req, [
          'department',
          'designation',
          'effectiveFrom',
          'reason',
        ]),
        reason = textField(b.reason, 'Reason', 2000)
      await c.tx.query('SELECT id FROM employees WHERE id=$1 FOR UPDATE', [id])
      await changeAssignment(c.tx, {
        employeeId: id,
        department: textField(b.department, 'Department'),
        designation: textField(b.designation, 'Job title'),
        effectiveFrom: dateField(b.effectiveFrom, 'Effective date'),
        reason,
        actorUserId: c.auth.userId,
      })
      await audit(c, 'people.assignment.changed', 'employee', id, reason, id)
      return ok({ saved: true })
    }),
  )
  r.post(
    prefix + '/attendance/corrections',
    { summary: 'Correct a recorded day', tag: 'attendance' },
    authed('attendance.correct', async (c) => {
      requireModule(c, 'attendance.enabled')
      const b = requireBody(c.req, [
          'employeeId',
          'workDate',
          'action',
          'reason',
        ]),
        id = asUuid(b.employeeId, 'Employee')
      assertScope(c.auth, id)
      if (
        ![
          'mark_present',
          'mark_absent',
          'mark_half_day',
          'mark_full_day',
          'mark_remote',
          'revoke_remote',
          'mark_field_duty',
        ].includes(String(b.action))
      )
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Choose a supported correction',
        )
      const reason = textField(b.reason, 'Reason', 2000),
        result = await applyCorrection(c.tx, {
          employeeId: id,
          workDate: dateField(b.workDate, 'Date'),
          action: b.action as CorrectionAction,
          reason,
          actorUserId: c.auth.userId,
        })
      await audit(c, 'attendance.day.corrected', 'employee', id, reason, id)
      return ok(result)
    }),
  )
  r.post(
    prefix + '/tasks/:id/complete',
    { summary: 'Complete assigned task', tag: 'tasks' },
    authed('task.read', async (c) => {
      const id = asUuid(c.req.params.id, 'Task')
      const { rows } = await c.tx.query(
        'SELECT id FROM tasks WHERE id=$1 AND assignee_user_id=$2',
        [id, c.auth.userId],
      )
      if (!rows[0]) throw new HttpError(404, 'NOT_FOUND', 'Task not found')
      await completeTask(c.tx, id, c.auth.userId)
      return ok({ completed: true })
    }),
  )
  r.post(
    prefix + '/announcements/:id/acknowledge',
    { summary: 'Acknowledge announcement', tag: 'announcements' },
    authed('announcement.read', async (c) => {
      await acknowledge(
        c.tx,
        asUuid(c.req.params.id, 'Announcement'),
        c.auth.userId,
      )
      return ok({ acknowledged: true })
    }),
  )
  r.post(
    prefix + '/notifications/read',
    { summary: 'Mark notifications read', tag: 'notifications' },
    authed(null, async (c) => {
      await c.tx.query(
        'UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL',
        [c.auth.userId],
      )
      return ok({ read: true })
    }),
  )
  r.post(
    prefix + '/settings',
    { summary: 'Save effective-dated policy', tag: 'settings' },
    authed('settings.write', async (c) => {
      orgScope(c)
      const b = requireBody(c.req, ['key', 'value', 'reason']),
        key = textField(b.key, 'Setting')
      if (!REGISTRY[key])
        throw new HttpError(422, 'VALIDATION_FAILED', 'Unknown setting')
      if (!['string', 'number', 'boolean'].includes(typeof b.value))
        throw new HttpError(422, 'VALIDATION_FAILED', 'Invalid setting value')
      const { rows } = await c.tx.query(
        "SELECT max(p.period_end)::text AS through FROM payroll_runs r JOIN payroll_periods p ON p.id=r.period_id AND p.tenant_id=r.tenant_id WHERE r.status NOT IN ('draft','cancelled')",
      )
      await setSetting(c.tx, {
        key,
        value: b.value as string | number | boolean,
        reason: textField(b.reason, 'Reason', 2000),
        effectiveFrom: b.effectiveFrom
          ? dateField(b.effectiveFrom, 'Effective date')
          : null,
        frozenThrough: rows[0]?.through,
        actorUserId: c.auth.userId,
      })
      return ok({ saved: true })
    }),
  )
  registerUiLeave(r)
  registerPayroll(r)
  return r
}

function registerPayroll(r: Router) {
  r.get(
    '/api/ui/payroll/:id/candidates',
    { summary: 'Review payroll input candidates', tag: 'payroll' },
    authed('payroll.process', async (c) => {
      orgScope(c)
      requireModule(c, 'payroll.enabled')
      assertPermission(c.auth, 'compensation.read')
      const id = asUuid(c.req.params.id, 'Run')
      const run = (
        await c.tx.query(
          'SELECT p.period_start::text,p.period_end::text FROM payroll_runs r JOIN payroll_periods p ON p.id=r.period_id AND p.tenant_id=r.tenant_id WHERE r.id=$1',
          [id],
        )
      ).rows[0]
      if (!run) throw new HttpError(404, 'NOT_FOUND', 'Run not found')
      const { rows } = await c.tx.query(
        `SELECT e.id,e.first_name,e.last_name,e.date_of_joining::text,c.annual_ctc_paise::text,c.components FROM employees e
   LEFT JOIN compensation_records c ON c.employee_id=e.id AND c.tenant_id=e.tenant_id AND c.superseded_at IS NULL AND c.effective_from<=$1 AND (c.effective_to IS NULL OR c.effective_to>$1)
   WHERE e.status='active' AND e.date_of_joining<=$1 AND NOT EXISTS (SELECT 1 FROM contractor_terms t WHERE t.tenant_id=e.tenant_id AND t.employee_id=e.id) ORDER BY e.first_name`,
        [run.period_end],
      )
      return ok({ period: run, employees: rows })
    }),
  )
  r.post(
    '/api/ui/payroll/runs',
    { summary: 'Start payroll run', tag: 'payroll' },
    authed('payroll.process', async (c) => {
      orgScope(c)
      requireModule(c, 'payroll.enabled')
      const b = requireBody(c.req, ['periodId'])
      return created({
        id: await createRun(c.tx, {
          periodId: asUuid(b.periodId, 'Period'),
          processedByUserId: c.auth.userId,
        }),
      })
    }),
  )
  r.get(
    '/api/ui/payroll/:id/inputs',
    { summary: 'Frozen payroll inputs', tag: 'payroll' },
    authed('payroll.read', async (c) => {
      orgScope(c)
      requireModule(c, 'payroll.enabled')
      const id = asUuid(c.req.params.id, 'Run')
      return ok(
        (
          await c.tx.query(
            `SELECT i.employee_id,e.first_name,e.last_name,i.calendar_days,i.payable_days,i.lop_days,i.monthly_components,i.state_code FROM payroll_inputs i JOIN employees e ON e.id=i.employee_id AND e.tenant_id=i.tenant_id WHERE i.run_id=$1`,
            [id],
          )
        ).rows,
      )
    }),
  )
  r.post(
    '/api/ui/payroll/:id/actions',
    { summary: 'Payroll cycle action', tag: 'payroll' },
    authed(null, async (c) => {
      orgScope(c)
      requireModule(c, 'payroll.enabled')
      const id = asUuid(c.req.params.id, 'Run'),
        b = requireBody(c.req, ['action'])
      const { rows } = await c.tx.query(
        'SELECT r.*,p.period_end::text FROM payroll_runs r JOIN payroll_periods p ON p.id=r.period_id AND p.tenant_id=r.tenant_id WHERE r.id=$1 FOR UPDATE OF r',
        [id],
      )
      const run = rows[0]
      if (!run) throw new HttpError(404, 'NOT_FOUND', 'Payroll run not found')
      const separate = {
        requireSeparateApprover: c.config.get<boolean>(
          'payroll.require_separate_approver',
        ),
      }
      if (b.action === 'approve') {
        assertPermission(c.auth, 'payroll.approve')
        await approve(c.tx, id, c.auth.userId, separate)
      } else if (b.action === 'lock') {
        // the same fresh-code rule as /api/v1/payroll/runs/:id/lock — the browser path must not be the soft one
        await requireRecentMfa(c)
        assertPermission(c.auth, 'payroll.lock')
        await lock(c.tx, id, c.auth.userId, separate)
        await audit(c, 'payroll.run.locked', 'payroll_run', id)
      } else if (b.action === 'revise') {
        assertPermission(c.auth, 'payroll.revise')
        const reason = textField(b.reason, 'Reason', 2000),
          newId = await revise(c.tx, id, {
            reason,
            processedByUserId: c.auth.userId,
          })
        await audit(c, 'payroll.run.revised', 'payroll_run', newId, reason)
        return created({ id: newId })
      } else if (b.action === 'calculate' || b.action === 'validate') {
        assertPermission(c.auth, 'payroll.process')
        const statutory = await loadStatutory(c.tx, run.period_end)
        if (statutory.id !== run.statutory_config_id)
          throw new HttpError(
            409,
            'STATUTORY_CHANGED',
            'The reference rates differ from the frozen run. Review this run before calculating.',
          )
        const options = {
          statutory: statutory.config,
          ptAmountPaise: (state: string, gross: bigint) =>
            ptFor(
              statutory.ptSlabs,
              state,
              gross,
              Number(run.period_end.slice(5, 7)),
            ),
          pfOnFullWage: Boolean(run.config_snapshot.pf_on_full_wage),
          lwfRates: statutory.lwfRates,
          lopBasis: run.config_snapshot.lop_basis as
            'calendar_days' | 'fixed_30' | 'working_days',
        }
        if (b.action === 'calculate') {
          const t = await calculate(c.tx, id, options)
          return ok({
            gross: String(t.gross),
            deductions: String(t.deductions),
            net: String(t.net),
          })
        }
        const result = await validate(c.tx, id, {
          ...options,
          variancePct: c.config.get<number>('payroll.variance_warning_pct'),
        })
        if (result.blockers.length)
          throw new HttpError(
            422,
            'VALIDATION_FAILED',
            result.blockers.map((x) => x.message).join('; '),
            result,
          )
        if (result.warnings.length && !b.acknowledgeWarnings)
          throw new HttpError(
            422,
            'VALIDATION_WARNINGS',
            result.warnings.map((x) => x.message).join('; ') +
              '. Review the register and acknowledge these warnings to continue.',
            result,
          )
        return ok(result)
      } else if (b.action === 'unfreeze') {
        assertPermission(c.auth, 'payroll.process')
        await unfreezeInputs(c.tx, id)
      } else if (b.action === 'freeze') {
        assertPermission(c.auth, 'payroll.process')
        if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 2000)
          throw new HttpError(
            422,
            'VALIDATION_FAILED',
            'Provide 1–2000 input rows',
          )
        const inputs: FreezeRow[] = b.rows.map((value: unknown) => {
          if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new HttpError(
              422,
              'VALIDATION_FAILED',
              'Each input must be a record',
            )
          const row = value as Record<string, unknown>
          const num = (key: string) => {
            const n = Number(row[key])
            if (!Number.isFinite(n) || n < 0)
              throw new HttpError(422, 'VALIDATION_FAILED', `Invalid ${key}`)
            return n
          }
          const components = row.monthlyComponents as Record<string, number>
          if (
            !components ||
            typeof components !== 'object' ||
            !Object.keys(components).length ||
            Object.values(components).some(
              (v) => typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0,
            )
          )
            throw new HttpError(
              422,
              'VALIDATION_FAILED',
              'Monthly components must be non-negative integer paise',
            )
          const calendar = num('calendarDays'),
            payable = num('payableDays'),
            lop = num('lopDays')
          if (calendar < 1 || calendar > 31 || payable + lop > calendar)
            throw new HttpError(
              422,
              'VALIDATION_FAILED',
              'Payable days plus loss of pay cannot exceed calendar days',
            )
          return {
            employeeId: asUuid(row.employeeId, 'Employee'),
            calendarDays: calendar,
            payableDays: payable,
            lopDays: lop,
            monthlyComponents: components,
            annualCtcPaise: num('annualCtcPaise'),
            stateCode: textField(row.stateCode, 'State code', 3),
            pfApplicable: row.pfApplicable !== false,
            esiApplicable: row.esiApplicable === true,
            joinedMidPeriod: row.joinedMidPeriod === true,
          }
        })
        const statutory = await loadStatutory(c.tx, run.period_end)
        return ok({
          frozen: await freezeInputs(
            c.tx,
            id,
            inputs,
            {
              lop_basis: c.config.get('payroll.lop_basis'),
              pf_on_full_wage: c.config.get('payroll.pf_on_full_wage'),
              exit_day_divisor: c.config.get('payroll.exit_day_divisor'),
            },
            statutory.id,
            { settlement: {
              encashmentDivisor: c.config.get<number>('payroll.exit_day_divisor'),
              noticeDivisor: c.config.get<number>('payroll.exit_day_divisor'),
            } },
          ),
        })
      } else
        throw new HttpError(
          422,
          'VALIDATION_FAILED',
          'Choose a supported payroll action',
        )
      return ok({ saved: true })
    }),
  )
}
