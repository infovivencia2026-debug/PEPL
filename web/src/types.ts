export interface Employee {
  id: string
  employee_number: string
  first_name: string
  last_name: string | null
  status: string
  date_of_joining: string
  department: string | null
  designation: string | null
}
export interface Attendance {
  employee_id: string
  first_name: string
  last_name: string
  employee_number: string
  work_date: string
  first_in: string | null
  last_out: string | null
  worked_minutes: number
  status: string
  is_remote: boolean
  is_field_duty: boolean
  is_regularized: boolean
  day_fraction: string
}
export interface Leave {
  id: string
  employee_id: string
  first_name: string
  last_name: string
  leave_name: string
  leave_type_id: string
  start_date: string
  end_date: string
  total_days: string
  reason: string
  status: string
  applied_at: string
}
export interface Approval {
  request_id: string
  entity_type: string
  entity_id: string
  title: string
  step_no: number
  created_at: string
  age_hours: number
}
export interface Payroll {
  id: string
  label: string
  status: string
  revision: number
  employee_count: number | null
  gross_paise: string | null
  deductions_paise: string | null
  net_paise: string | null
  processed_by_user_id: string
  period_start: string
  period_end: string
  pay_date: string
}
export interface Setting {
  key: string
  label: string
  help: string
  kind: string
  risk: string
  affects: string[]
  value: string | number | boolean
}
export interface Workspace {
  user: {
    id: string
    full_name: string
    email: string
    employeeId?: string
    scope: string
    roles: string[]
  }
  company: string
  today: string
  date: string
  permissions: string[]
  modules: Record<string, boolean>
  employees: Employee[]
  attendance: Attendance[]
  leaves: Leave[]
  approvals: Approval[]
  payroll: Payroll[]
  periods: {
    id: string
    label: string
    period_start: string
    period_end: string
    pay_date: string
  }[]
  leaveTypes: { id: string; name: string; code: string; is_paid: boolean }[]
  balances: {
    id: string
    name: string
    available: number
    consumed: number
    accrued: number
    opening: number
  }[]
  payslips: {
    id: string
    run_id: string
    employee_id: string
    first_name: string
    last_name: string
    label: string
    gross_paise: string
    deductions_paise: string
    net_paise: string
  }[]
  tasks: {
    id: string
    title: string
    due_date: string | null
    status: string
    overdue: boolean
  }[]
  announcements: {
    id: string
    title: string
    body_html: string
    publish_at: string
    requires_acknowledgement: boolean
    acknowledged_at: string | null
  }[]
  notifications: {
    id: string
    title: string
    body: string
    read_at: string | null
    created_at: string
  }[]
  activity: {
    id: string
    action: string
    entity_type: string
    entity_label: string | null
    actor_label: string | null
    created_at: string
    severity: string
  }[]
  settings: Setting[]
}
export interface Profile {
  employee: Employee
  assignments: {
    id: string
    department: string
    designation: string
    effective_from: string
    effective_to: string | null
    change_reason: string | null
    superseded_at: string | null
  }[]
  compensation: {
    id: string
    annual_ctc_paise: string
    effective_from: string
    change_reason: string
  }[]
}
