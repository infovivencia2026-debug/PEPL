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
import { bool, defineConfig, enumOf, flag, int, text, type Definition } from './types.ts'

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
    help: 'When on, a weekly off or company holiday falling BETWEEN two leave days is itself deducted. A non-working day at the start or end of a leave is never charged under either setting.',
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
    scopable: ['location', 'department', 'grade'],
  }),
  geofence_required: bool({
    default: true,
    label: 'Require location for mobile punch',
    help: 'Reject a mobile punch without a location fix.',
    scopable: ['location', 'department'],
  }),
  geofence_enforce: bool({
    default: false,
    label: 'Reject punches outside the geofence',
    help: 'Off: a punch from outside an allowed site is recorded and flagged for the manager. On: it is refused. Applies only to people who have a site; exempt people are never refused.',
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
  // The employer's own registration numbers. Not behaviour — identity on a
  // return — but they belong with the company's other payroll settings rather
  // than in a table of four strings.
  exit_day_divisor: int({
    default: 30,
    min: 26,
    max: 31,
    label: 'Days in a month for exit settlement',
    help: 'Leave encashment and notice recovery are paid or recovered per day at monthly pay divided by this. 30 is the convention; some contracts say 26.',
    risk: 'high',
    affects: ['payroll'],
  }),
  pf_establishment_code: text({
    default: '',
    label: 'PF establishment code',
    help: 'From your EPFO registration, for example TNMAS0012345. It names the file the ECR is uploaded against.',
  }),
  esi_employer_code: text({
    default: '',
    label: 'ESI employer code',
    help: '17 digits from your ESIC registration. Needed on the monthly contribution file.',
  }),
  tan: text({
    default: '',
    label: 'TAN',
    help: 'Tax deduction account number, for example CHEA12345B. Every 24Q return is filed against it.',
  }),
  pt_state_code: text({
    default: '',
    label: 'Professional tax state',
    help: 'The state whose PT registration you file under, for example TS. Leave blank to use each employee\'s work state.',
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

const chat = defineConfig('chat', {
  enabled: flag({
    default: false,
    label: 'Internal chat',
    help: 'Direct messages and group conversations between colleagues.',
    entitlement: 'chat',
    disableEffect: 'soft',
  }),
  allow_groups: bool({
    default: true,
    label: 'Group conversations',
    help: 'When off, people may only exchange direct messages.',
  }),
  allow_attachments: bool({
    default: true,
    label: 'File sharing in chat',
    help: 'Let people attach documents and images to a message.',
  }),
  history_retention_days: int({
    default: 0,
    min: 0,
    max: 3650,
    label: 'Delete chat history after (days)',
    help: '0 keeps messages indefinitely. A retention job removes older messages.',
    risk: 'high',
  }),
})

const mail = defineConfig('mail', {
  enabled: flag({
    default: false,
    label: 'Mailbox',
    help: 'Read and send company email inside PEPL. Each person connects their own mailbox.',
    entitlement: 'mail',
    disableEffect: 'soft',
  }),
  store_bodies: bool({
    default: false,
    label: 'Cache message bodies',
    help: 'Off by default: PEPL keeps envelopes for the list view and fetches a body on open, so message content is not duplicated into this database.',
    risk: 'high',
  }),
  allow_external_recipients: bool({
    default: true,
    label: 'Allow sending outside the company',
    help: 'When off, mail may only be addressed to colleagues.',
  }),
})

const notifications = defineConfig('notifications', {
  enabled: flag({
    default: true,
    label: 'Notifications',
    help: 'In-app notifications for approvals, leave decisions and announcements.',
    disableEffect: 'soft',
  }),
  email_enabled: bool({
    default: false,
    label: 'Send notifications by email',
    help: 'Requires a sender mailbox below. Without one, notifications stay in the app.',
  }),
  push_enabled: bool({
    default: true,
    label: 'Send notifications to devices',
    help: 'Browser and phone push for people who allowed it on a device. Nothing is sent to a device that did not opt in.',
  }),
  sender_email: text({
    default: '',
    label: 'Send notification email from',
    help: 'A mailbox already connected in PEPL, for example hr@yourcompany.com. Mail sent from your own domain and server reaches people; mail from an unrelated sender is filtered as spam.',
  }),
})

const documents = defineConfig('documents', {
  enabled: flag({
    default: true,
    label: 'Documents',
    help: 'Offer letters, ID proofs, policies and attachments.',
    disableEffect: 'soft',
  }),
  max_upload_mb: int({
    default: 10,
    min: 1,
    max: 10,
    label: 'Largest file (MB)',
    help: 'Uploads above this size are refused.',
  }),
})

const privacy = defineConfig('privacy', {
  erasure_after_days: int({
    default: 2922,
    min: 365,
    max: 3653,
    label: 'Keep a former employee\'s identity for (days)',
    help: 'How long after the last working day before their personal data may be erased. The default is eight years, the income-tax record retention period; payroll ledger rows are kept regardless — erasure removes the person, not the numbers.',
    risk: 'high',
  }),
})

export const REGISTRY: Readonly<Record<string, Definition>> = Object.freeze({
  ...leave,
  ...attendance,
  ...payroll,
  ...helpdesk,
  ...chat,
  ...mail,
  ...documents,
  ...notifications,
  ...privacy,
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
