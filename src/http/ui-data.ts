import type { Ctx } from './context.ts'
import { can } from '../authz/permissions.ts'
import { inbox } from '../approvals/index.ts'
import { balance } from '../leave/ledger.ts'
import { taskInbox } from '../work/tasks.ts'
import { REGISTRY } from '../config-registry/index.ts'
export function scopeIds(c: Ctx): string[] | null {
  return c.auth.scope === 'all'
    ? null
    : ([
        ...new Set(
          [
            c.auth.employeeId,
            ...(c.auth.scope === 'reports' ? c.auth.reportIds : []),
          ].filter(Boolean),
        ),
      ] as string[])
}
export async function workspaceData(c: Ctx, date?: string) {
  const ids = scopeIds(c),
    read = async (sql: string, params: unknown[] = []) =>
      (await c.tx.query(sql, params)).rows
  // Driven by the registry, not a hand-written list: a module added to the
  // registry appears in the UI without a second edit here.
  const modules = Object.fromEntries(
    Object.keys(REGISTRY)
      .filter((k) => k.endsWith('.enabled'))
      .map((k) => [k.split('.')[0]!, c.config.isEnabled(k)]),
  )
  const [user] = await read(
    'SELECT full_name,email FROM app_users WHERE id=$1',
    [c.auth.userId],
  )
  const [company] = await read('SELECT display_name FROM tenants WHERE id=$1', [
    c.auth.tenantId,
  ])
  const today = (await read('SELECT CURRENT_DATE::text AS date'))[0]!
    .date as string
  const workDate = date ?? today
  const employees = can(c.auth, 'employee.read')
    ? await read(
        `SELECT e.id,e.employee_number,e.first_name,e.last_name,e.status,e.date_of_joining::text,a.department,a.designation
 FROM employees e LEFT JOIN employee_assignments a ON a.employee_id=e.id AND a.tenant_id=e.tenant_id AND a.superseded_at IS NULL AND a.effective_from<=CURRENT_DATE AND (a.effective_to IS NULL OR a.effective_to>CURRENT_DATE)
 WHERE ($1::uuid[] IS NULL OR e.id=ANY($1)) ORDER BY e.first_name,e.last_name`,
        [ids],
      )
    : []
  const attendance =
    modules.attendance && can(c.auth, 'attendance.read')
      ? await read(
          `SELECT d.employee_id,d.work_date::text,d.first_in,d.last_out,d.worked_minutes,d.status,d.day_fraction,d.is_remote,d.is_field_duty,d.is_regularized,e.first_name,e.last_name,e.employee_number
 FROM daily_attendance d JOIN employees e ON e.id=d.employee_id AND e.tenant_id=d.tenant_id WHERE d.work_date=$2 AND ($1::uuid[] IS NULL OR d.employee_id=ANY($1)) ORDER BY e.first_name`,
          [ids, workDate],
        )
      : []
  const leaveTypes =
    modules.leave && can(c.auth, 'leave.read')
      ? await read(
          "SELECT id,code,name,is_paid FROM leave_types WHERE status='active' ORDER BY name",
        )
      : []
  const leaves =
    modules.leave && can(c.auth, 'leave.read')
      ? await read(
          `SELECT l.id,l.employee_id,l.leave_type_id,l.start_date::text,l.end_date::text,l.total_days,l.reason,l.status,l.applied_at,e.first_name,e.last_name,t.name AS leave_name
 FROM leave_requests l JOIN employees e ON e.id=l.employee_id AND e.tenant_id=l.tenant_id JOIN leave_types t ON t.id=l.leave_type_id AND t.tenant_id=l.tenant_id
 WHERE ($1::uuid[] IS NULL OR l.employee_id=ANY($1)) ORDER BY l.applied_at DESC`,
          [ids],
        )
      : []
  const cycle =
    Number(today.slice(0, 4)) -
    (Number(today.slice(5, 7)) < c.config.get<number>('leave.cycle_start_month')
      ? 1
      : 0)
  const balances =
    c.auth.employeeId && leaveTypes.length
      ? await Promise.all(
          leaveTypes.map(async (t) => ({
            ...t,
            ...(await balance(c.tx, c.auth.employeeId!, t.id, cycle, today)),
          })),
        )
      : []
  const approvals = can(c.auth, 'approval.act')
    ? (await inbox(c.tx, c.auth.userId)).filter((a) =>
        a.entity_type === 'leave'
          ? modules.leave && can(c.auth, 'leave.approve')
          : true,
      )
    : []
  const payroll =
    modules.payroll && can(c.auth, 'payroll.read') && c.auth.scope === 'all'
      ? await read(`SELECT r.id,r.status,r.revision,r.employee_count,r.gross_paise::text,r.deductions_paise::text,r.net_paise::text,r.processed_by_user_id,p.label,p.period_start::text,p.period_end::text,p.pay_date::text
 FROM payroll_runs r JOIN payroll_periods p ON p.id=r.period_id AND p.tenant_id=r.tenant_id ORDER BY p.period_start DESC,r.revision DESC`)
      : []
  const periods =
    modules.payroll && can(c.auth, 'payroll.process') && c.auth.scope === 'all'
      ? await read(
          'SELECT id,label,period_start::text,period_end::text,pay_date::text FROM payroll_periods ORDER BY period_start DESC',
        )
      : []
  const payslips =
    modules.payroll && can(c.auth, 'payroll.read')
      ? await read(
          `SELECT s.id,s.run_id,s.employee_id,s.gross_paise::text,s.deductions_paise::text,s.net_paise::text,s.distributed_at,p.label,e.first_name,e.last_name
 FROM payslips s JOIN payroll_runs r ON r.id=s.run_id AND r.tenant_id=s.tenant_id JOIN payroll_periods p ON p.id=r.period_id AND p.tenant_id=r.tenant_id JOIN employees e ON e.id=s.employee_id AND e.tenant_id=s.tenant_id
 WHERE ($1::uuid[] IS NULL OR s.employee_id=ANY($1)) AND ($1::uuid[] IS NULL OR (s.published_at IS NOT NULL AND r.status='locked')) ORDER BY p.period_start DESC`,
          [ids],
        )
      : []
  const tasks = can(c.auth, 'task.read')
    ? await taskInbox(c.tx, c.auth.userId)
    : []
  const announcements = can(c.auth, 'announcement.read')
    ? await read(
        `SELECT a.id,a.title,a.body_html,a.publish_at,a.requires_acknowledgement,ar.acknowledged_at FROM announcements a
 JOIN announcement_receipts ar ON ar.announcement_id=a.id AND ar.tenant_id=a.tenant_id AND ar.user_id=$1
 WHERE a.status='published' AND a.publish_at<=now() AND (a.expires_at IS NULL OR a.expires_at>now()) ORDER BY a.publish_at DESC`,
        [c.auth.userId],
      )
    : []
  const notifications = await read(
    'SELECT id::text,title,body,read_at,created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 50',
    [c.auth.userId],
  )
  const activity = can(c.auth, 'audit.read')
    ? await read(
        'SELECT id::text,action,entity_type,entity_label,actor_label,occurred_at AS created_at,severity FROM audit_events WHERE ($1::uuid[] IS NULL OR subject_employee_id=ANY($1)) ORDER BY occurred_at DESC LIMIT 30',
        [ids],
      )
    : []
  const settings =
    can(c.auth, 'settings.write') && c.auth.scope === 'all'
      ? Object.entries(REGISTRY).map(([key, d]) => ({
          key,
          label: d.label,
          help: d.help,
          kind: d.kind,
          risk: d.risk,
          affects: d.affects,
          value: c.config.get(key),
        }))
      : []
  return {
    user: {
      ...user,
      id: c.auth.userId,
      employeeId: c.auth.employeeId,
      scope: c.auth.scope,
      roles: c.auth.roles,
    },
    company: company?.display_name ?? 'PEPL',
    today,
    date: workDate,
    permissions: [...c.auth.permissions],
    modules,
    employees,
    attendance,
    leaveTypes,
    leaves,
    balances,
    approvals,
    payroll,
    periods,
    payslips,
    tasks,
    announcements,
    notifications,
    activity,
    settings,
  }
}
