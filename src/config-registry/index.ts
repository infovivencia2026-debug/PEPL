/**
 * The registry: every behaviour PEPL exposes, with a default that is correct for
 * a standard Indian company (docs/architecture/standard-company-model.md).
 *
 * A tenant that configures nothing must still run correct payroll. Configurability
 * is about letting customers change things, not forcing them to.
 *
 * The admin UI is generated from this, so a setting cannot ship without a label,
 * a default, a risk class and help text. That friction is deliberate.
 */
import { bool, defineConfig, enumOf, flag, int, type Definition } from './types.ts'

const leave = defineConfig('leave', {
  enabled: flag({
    default: true,
    label: 'Leave management',
    help: 'Leave types, policies, balances and approvals.',
    disableEffect: 'soft',
  }),
  cycle_start_month: int({
    default: 4,
    min: 1,
    max: 12,
    label: 'Leave year starts in',
    help: 'Month the leave year begins. 4 = April (financial year), 1 = January (calendar year).',
    risk: 'high',
    affects: ['payroll'],
  }),
  min_unit: enumOf(['full_day', 'half_day', 'hourly'] as const, {
    default: 'half_day',
    label: 'Smallest leave unit',
    help: 'The smallest amount of leave an employee may apply for.',
    scopable: ['department', 'grade'],
  }),
  sandwich_holidays: bool({
    default: false,
    label: 'Count holidays inside a leave as leave',
    help: 'When on, a weekly off or holiday falling between two leave days is itself deducted.',
    risk: 'high',
    affects: ['payroll'],
    scopable: ['department', 'location', 'grade'],
  }),
  allow_negative_balance: bool({
    default: false,
    label: 'Allow negative leave balance',
    help: 'Let employees apply beyond their balance, going negative instead of unpaid.',
    risk: 'high',
    affects: ['payroll'],
  }),
  backdating_limit_days: int({
    default: 30,
    min: 0,
    max: 365,
    label: 'Backdated application limit (days)',
    help: 'How far into the past a leave application may be dated.',
  }),
  encashment_enabled: bool({
    default: false,
    label: 'Leave encashment',
    help: 'Pay out unused leave. Requires payroll.',
    risk: 'high',
    entitlement: 'payroll',
    affects: ['payroll'],
    dependsOn: ['payroll.enabled'],
  }),
  approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only'] as const, {
    default: 'manager',
    label: 'Leave approval chain',
    help: 'Who approves a leave request, in order.',
    risk: 'high',
    scopable: ['department', 'location', 'grade'],
  }),
})

const attendance = defineConfig('attendance', {
  enabled: flag({
    default: true,
    label: 'Attendance',
    help: 'Capture, daily computation, periods and corrections.',
    disableEffect: 'blocked_if_data',
  }),
  week_pattern: enumOf(['five_day', 'six_day', 'alternate_saturday', 'roster'] as const, {
    default: 'six_day',
    label: 'Working week',
    help: 'Default weekly-off pattern. Override per location or team.',
    risk: 'high',
    affects: ['payroll'],
    scopable: ['location', 'department'],
  }),
  half_day_mode: enumOf(['explicit', 'hours_derived'] as const, {
    default: 'explicit',
    label: 'How a half day is decided',
    help: 'Explicit: a manager marks it. Hours-derived: worked hours below the threshold auto-mark it.',
    risk: 'high',
    affects: ['payroll'],
  }),
  half_day_hours: int({
    default: 4,
    min: 1,
    max: 12,
    label: 'Half-day threshold (hours)',
    help: 'Only used when half days are hours-derived.',
    risk: 'high',
    affects: ['payroll'],
  }),
  grace_minutes: int({
    default: 10,
    min: 0,
    max: 120,
    label: 'Late grace period (minutes)',
    help: 'Arrival within this window of shift start is not marked late.',
    scopable: ['location', 'department', 'grade'],
  }),
  remote_enabled: bool({
    default: true,
    label: 'Work from home',
    help: 'Allow employees to be marked as working remotely.',
    scopable: ['department', 'grade', 'location'],
  }),
  remote_is_paid: bool({
    default: true,
    label: 'Remote days are paid',
    help: 'Whether a work-from-home day counts as a paid working day.',
    risk: 'high',
    affects: ['payroll'],
  }),
  correction_window_days: int({
    default: 30,
    min: 0,
    max: 180,
    label: 'Correction window (days)',
    help: 'How far back HR may correct attendance, within an open period.',
  }),
  geofence_required: bool({
    default: true,
    label: 'Require location for mobile punch',
    help: 'Reject a mobile punch without a location fix.',
    scopable: ['location', 'department'],
  }),
})

const payroll = defineConfig('payroll', {
  enabled: flag({
    default: true,
    label: 'Payroll',
    help: 'Salary structures, statutory deductions, runs and payslips.',
    entitlement: 'payroll',
    dependsOn: ['attendance.enabled', 'leave.enabled'],
    disableEffect: 'blocked_if_data',
  }),
  lop_basis: enumOf(['calendar_days', 'fixed_30', 'working_days'] as const, {
    default: 'calendar_days',
    label: 'Loss-of-pay basis',
    help: 'Denominator used to prorate a day of unpaid leave.',
    risk: 'high',
    affects: ['payroll'],
  }),
  employer_pf_in_ctc: bool({
    default: true,
    label: 'Employer PF is part of CTC',
    help: 'Whether the employer provident fund contribution sits inside the stated CTC.',
    risk: 'high',
    affects: ['payroll'],
  }),
  pf_on_full_wage: bool({
    default: false,
    label: 'Contribute PF on full wages',
    help: 'Contribute above the statutory wage ceiling rather than capping at it.',
    risk: 'high',
    affects: ['payroll'],
  }),
  variance_warning_pct: int({
    default: 25,
    min: 1,
    max: 100,
    label: 'Net pay variance warning (%)',
    help: 'Flag an employee whose net pay moves more than this against the previous period.',
  }),
  require_separate_approver: bool({
    default: true,
    label: 'Separate approver for payroll',
    help: 'The person who runs payroll cannot approve or lock the same run.',
    risk: 'high',
  }),
})

const helpdesk = defineConfig('helpdesk', {
  enabled: flag({
    default: false,
    label: 'Employee helpdesk',
    help: 'Ticketing for payroll, leave, IT and HR queries.',
    entitlement: 'helpdesk',
    disableEffect: 'soft',
  }),
  default_response_sla_minutes: int({
    default: 480,
    min: 15,
    max: 20_160,
    label: 'Default first-response SLA (minutes)',
    help: 'Measured in working hours, not wall clock.',
  }),
})

export const REGISTRY: Readonly<Record<string, Definition>> = Object.freeze({
  ...leave,
  ...attendance,
  ...payroll,
  ...helpdesk,
})

/** A typed error so the transport can classify it, rather than returning a 500. */
export class UnknownConfigKeyError extends Error {
  readonly code = 'UNKNOWN_CONFIG_KEY'
  readonly key: string
  constructor(key: string) {
    super(`unknown config key "${key}" — every key must be declared in the registry`)
    this.key = key
    this.name = 'UnknownConfigKeyError'
  }
}

export function getDefinition(key: string): Definition {
  const def = REGISTRY[key]
  if (!def) throw new UnknownConfigKeyError(key)
  return def
}

export const REGISTRY_KEYS: readonly string[] = Object.freeze(Object.keys(REGISTRY))
