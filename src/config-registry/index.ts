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
    core: true,
    default: true,
    label: 'Leave management',
    help: 'Leave types, policies, balances and approvals.',
    disableEffect: 'soft',
  }),
  optional_holidays_allowed: int({
    default: 0,
    min: 0,
    max: 10,
    label: 'Optional (restricted) holidays a person may pick per year',
    help: 'Holidays marked optional in the calendar are off only for people who pick them, up to this many a year. 0 turns the feature off.',
    scopable: ['location', 'grade'],
  }),
  comp_off_enabled: bool({
    default: true,
    label: 'Compensatory off for work on off days',
    help: 'A present day on a weekly off or holiday credits the CO leave type: a full day at or above the half-day hours, half a day below. Granted nightly from the muster; HR can grant a missed one.',
  }),
  comp_off_expiry_days: int({
    default: 90,
    min: 7,
    max: 365,
    label: 'Comp-off expires after (days)',
    help: 'An unused comp-off lapses this many days after the day it was earned.',
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
    core: true,
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
  correction_approval: enumOf(['none', 'manager', 'manager_then_hr', 'hr_only'] as const, {
    default: 'none',
    label: 'Attendance corrections need approval',
    help: 'none: a person with the permission corrects a day directly. Otherwise the correction is held and applied when the chain approves it (an approval policy for attendance_correction overrides the chain here).',
  }),
  timezone: text({
    default: 'Asia/Kolkata',
    label: 'Company timezone',
    help: 'An IANA name, e.g. Asia/Kolkata or Asia/Dubai. Decides which calendar day a punch belongs to, when "today" ends for a correction, and how a shift\'s clock times are read. Change it only between payroll periods.',
    risk: 'high',
    affects: ['payroll'],
  }),
  regularisation_chain: enumOf(['manager', 'manager_then_hr', 'hr_only'] as const, {
    default: 'manager',
    label: 'Who approves an employee\'s own attendance request',
    help: 'A person who forgot to punch, or worked from home without marking it, asks; this chain decides. Always an approval — an employee never edits their own attendance directly. An approval policy for attendance_correction overrides it.',
  }),
  wfh_requires_approval: bool({
    default: true,
    label: 'Work-from-home needs approval',
    help: 'Off: a WFH request is approved on the spot and the person can punch from anywhere on those days. Field duty always needs approval.',
    scopable: ['department', 'grade'],
  }),
  wfh_max_days_per_month: int({
    default: 0,
    min: 0,
    max: 31,
    label: 'Work-from-home days allowed per month',
    help: '0 = no cap. Counted across pending and approved requests in the month.',
    scopable: ['department', 'grade', 'location'],
  }),
  remote_approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance', 'manager_dept_head', 'dept_head_hr'] as const, {
    default: 'manager',
    label: 'WFH / field duty approval chain',
    help: 'Who approves remote and field-duty requests when no approval policy matches.',
  }),
  swap_requires_approval: bool({
    default: true,
    label: 'Shift swaps need manager approval',
    help: 'Off: once the colleague accepts, both rosters change on the spot.',
    scopable: ['department', 'location'],
  }),
  roster_shortage_alert_days: int({
    default: 7,
    min: 0,
    max: 30,
    label: 'Warn about under-strength shifts this many days ahead',
    help: 'Shifts with a minimum headcount that the roster does not meet are reported to HR and managers nightly. 0 turns it off.',
  }),
  breaks_deducted: bool({
    default: true,
    label: 'Recorded breaks reduce worked time',
    help: 'When a person records a break, its minutes come off the day. Off: breaks are noted but the day is punch-in to punch-out.',
    scopable: ['department', 'location'],
  }),
  late_reason_required: bool({
    default: false,
    label: 'Ask for a reason on a late punch',
    help: 'The punch is always accepted; the app then asks why, and the reason shows next to the late mark in the control room and the muster.',
    scopable: ['department', 'location', 'grade'],
  }),
  max_daily_hours: int({
    default: 14,
    min: 8,
    max: 24,
    label: 'Guard: maximum hours in a day',
    help: 'The nightly attendance guard flags a day worked longer than this — usually a missed punch-out, sometimes a safety issue.',
  }),
  regularisation_rate_alert_pct: int({
    default: 25,
    min: 1,
    max: 100,
    label: 'Guard: regularisation rate alert (%)',
    help: 'Flag a manager whose team had more than this share of days regularised over 30 days.',
  }),
  auto_checkout_after_minutes: int({
    default: 0,
    min: 0,
    max: 720,
    label: 'Close a forgotten punch-out after (minutes past shift end)',
    help: 'A day with a punch-in and no punch-out is closed at the shift end once this long has passed (12 hours after punch-in for people with no shift), and flagged. 0 turns it off.',
    scopable: ['department', 'location'],
  }),
  qr_punch_enabled: bool({
    default: false,
    label: 'QR / kiosk punch',
    help: 'A manager\'s phone or a wall tablet shows a code that changes every minute; scanning it is a punch at that site with no location fix needed.',
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
  unmarked_day_is_lop: bool({
    default: false,
    label: 'A day with no attendance record is loss of pay',
    help: 'Off: a working day nobody recorded is presumed worked and paid (right for companies without a punch system). On: it is unpaid unless corrected. Either way the payroll summary lists such days.',
    risk: 'high',
    affects: ['payroll'],
  }),
  late_marks_per_half_day: int({
    default: 0,
    min: 0,
    max: 31,
    label: 'Late marks that cost half a day',
    help: 'Every this-many late arrivals in a month (after the shift\'s grace) deduct half a day of pay. 0 turns the rule off. Applies only to people on a shift.',
    risk: 'high',
    affects: ['payroll'],
  }),
  geofence_enforce: bool({
    default: false,
    label: 'Reject punches outside the geofence',
    help: 'Off: a punch from outside an allowed site is recorded and flagged for the manager. On: it is refused. Applies only to people who have a site; exempt people are never refused.',
    scopable: ['location', 'department'],
  }),
})

const expenses = defineConfig('expenses', {
  enabled: flag({
    entitlement: 'expenses',
    default: true,
    label: 'Expenses & travel',
    help: 'Expense claims against categories with limits, travel requests with advances, reimbursed through payroll.',
    dependsOn: ['payroll.enabled'],
    disableEffect: 'soft',
  }),
  approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance', 'manager_dept_head', 'dept_head_hr'] as const, {
    default: 'manager_hr_finance',
    label: 'Expense approval chain',
    help: 'Who approves claims and trips when no approval policy matches. Finance last is the usual shape: the manager confirms the spend happened, finance confirms it is payable.',
  }),
})

const timesheets = defineConfig('timesheets', {
  enabled: flag({
    entitlement: 'timesheets',
    default: true,
    label: 'Projects & timesheets',
    help: 'Projects people are allocated to, weekly hours booked against them with manager approval, a daily work log, and the approved-hours report.',
    dependsOn: ['attendance.enabled'],
    disableEffect: 'soft',
  }),
  approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance', 'manager_dept_head', 'dept_head_hr'] as const, {
    default: 'manager',
    label: 'Timesheet approval chain',
    help: 'Who approves a submitted week when no approval policy matches.',
  }),
})

const recruitment = defineConfig('recruitment', {
  enabled: flag({
    entitlement: 'recruitment',
    default: true,
    label: 'Recruitment',
    help: 'Requisitions, candidate pipeline, interviews, offers, and conversion of an accepted candidate into an employee with the onboarding checklist.',
    disableEffect: 'soft',
  }),
  approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance', 'manager_dept_head', 'dept_head_hr'] as const, {
    default: 'manager_hr_finance',
    label: 'Requisition and offer approval chain',
    help: 'Who approves a hiring requisition and an offer when no approval policy matches. Routed by the hiring manager.',
  }),
})

const performance = defineConfig('performance', {
  enabled: flag({
    entitlement: 'performance',
    default: true,
    label: 'Performance',
    help: 'Goals with weights and check-ins, review cycles (self review, manager review, HR calibration, acknowledgement) and performance improvement plans.',
    disableEffect: 'soft',
  }),
  recommendation_approval_chain: enumOf(['manager_then_hr', 'hr_only', 'manager_hr_finance', 'dept_head_hr'] as const, {
    default: 'manager_hr_finance',
    label: 'Promotion / increment approval chain',
    help: 'Who approves a promotion or increment recommendation when no approval policy matches. On approval the designation and compensation change on the effective date, citing the appraisal.',
  }),
  feedback_min_group: int({
    default: 3,
    min: 2,
    max: 10,
    label: '360° minimum group size',
    help: 'Feedback from a relationship group (peers, reports, stakeholders) is shown only when at least this many have answered. Below it the group is withheld, never shown one by one.',
  }),
})

const people = defineConfig('people', {
  transfer_approval_chain: enumOf(['manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance', 'manager_dept_head', 'dept_head_hr'] as const, {
    default: 'manager_then_hr',
    label: 'Transfer approval chain',
    help: 'Who approves a department / location / manager change when no approval policy matches. Applied on the effective date.',
  }),
  probation_review_days_ahead: int({
    default: 14,
    min: 0,
    max: 90,
    label: 'Open a probation review this many days before it ends',
    help: 'The nightly job opens a review and tells the manager and HR. Confirming issues the confirmation letter and makes the employment permanent; extending moves the end date.',
  }),
})

const assets = defineConfig('assets', {
  enabled: flag({
    entitlement: 'assets',
    default: true,
    label: 'Assets',
    help: 'Laptops, phones, SIMs, ID cards, uniforms, PPE, tools, licence seats: a register with issue and return, maintenance, and an exit clearance that will not sign while a leaver still holds an item.',
    disableEffect: 'soft',
  }),
})

const surveys = defineConfig('surveys', {
  enabled: flag({
    entitlement: 'surveys',
    default: true,
    label: 'Surveys & pulse',
    help: 'Pulse surveys, eNPS and a suggestion box. Anonymous by construction: individual answers are never readable; results are aggregates that withhold small groups.',
    disableEffect: 'soft',
  }),
})

const learning = defineConfig('learning', {
  enabled: flag({
    entitlement: 'learning',
    default: true,
    label: 'Learning & recognition',
    help: 'A course catalogue with nominations, completion and expiring certifications; mandatory training reaches its whole audience and new joiners automatically. Peer recognition with badges, a company wall and a points balance that can be redeemed or paid out.',
    disableEffect: 'soft',
  }),
})

const branding = defineConfig('branding', {
  enabled: flag({
    entitlement: 'branding',
    default: true,
    label: 'Branding & custom domain',
    help: 'Your product name, colours and logo on the app, payslips and emails; a custom domain such as people.yourcompany.in. Colours and headers work on every plan; the custom domain is Enterprise.',
    disableEffect: 'soft',
  }),
})

const integrations = defineConfig('integrations', {
  enabled: flag({
    entitlement: 'integrations',
    default: true,
    label: 'Integrations, API keys & webhooks',
    help: 'API keys that act as a service user with a role; webhooks signed with HMAC on the audit vocabulary; connections to Tally, RazorpayX, Google/Microsoft, SMS, biometric devices and e-sign.',
    disableEffect: 'soft',
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
  guard_headcount_change_pct: int({
    default: 20,
    min: 1,
    max: 100,
    label: 'Guard: headcount change against last month (%)',
    help: 'The anomaly guard warns when the number of people paid moves more than this against the previous locked run.',
  }),
  guard_total_change_pct: int({
    default: 15,
    min: 1,
    max: 100,
    label: 'Guard: total net pay change against last month (%)',
    help: 'The anomaly guard BLOCKS approval when total net pay moves more than this against the previous locked run, until someone dismisses the finding with a reason.',
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
  ot_requires_approval: bool({
    default: false,
    label: 'Overtime must be approved in advance',
    help: 'Only pre-approved overtime minutes reach the payroll freeze; unapproved extra hours are recorded but not paid.',
    risk: 'high',
    affects: ['payroll'],
    scopable: ['department', 'location', 'grade'],
  }),
  ot_pay: enumOf(['none', 'single', 'double'] as const, {
    default: 'none',
    label: 'Overtime pay',
    help: 'none: overtime minutes are recorded on the muster and not paid. single: paid at the ordinary hourly rate (basic ÷ 208 hours). double: at twice the ordinary rate, as the Factories Act requires for covered establishments. Frozen as an OT line on the payslip.',
    risk: 'high',
    affects: ['payroll'],
    scopable: ['location', 'department', 'grade'],
  }),
  pay_day: int({
    default: 1,
    min: 0,
    max: 28,
    label: 'Salary pay date (day of the following month)',
    help: 'The day salaries are paid for a month: 1 = 1st of the next month, 7 = 7th. 0 = last working day of the month itself. Used when a period is created automatically; a period\'s own pay date can still be edited.',
  }),
  email_payslips: bool({
    default: true,
    label: 'Email payslips when a run is locked',
    help: 'Sends each person their payslip as a PDF from the company notification mailbox, and keeps a copy on their documents. Needs a sender mailbox under Notifications; without one the payslip is still on their pay history.',
  }),
  compensation_approval: enumOf(['none', 'manager', 'manager_then_hr', 'hr_only', 'manager_hr_finance'] as const, {
    default: 'none',
    label: 'Salary revisions need approval',
    help: 'none: compensation.write applies a revision directly. Otherwise the revision is held and lands on the record when the chain approves it (an approval policy for compensation — e.g. above a size — overrides the chain here).',
    risk: 'high',
  }),
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
    core: true,
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
  whatsapp_enabled: bool({
    default: false,
    label: 'Send on WhatsApp',
    help: 'Approvals, payslips, leave decisions and reminders go to people who opted in with a number, through the provider configured under Company → WhatsApp. Off: nothing leaves.',
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
    core: true,
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

const approvals = defineConfig('approvals', {
  no_approver_fallback: enumOf(['route_to_hr', 'auto_approve'] as const, {
    default: 'route_to_hr',
    label: 'When a step has nobody to approve it',
    help: 'A person with no manager on record, or a requester who is their own approver, leaves a step empty. Route to HR sends that step to an HR admin instead; auto-approve lets it through. Field duty, expenses and leave are all affected.',
    risk: 'high',
  }),
  remind_after_days: int({
    default: 2,
    min: 0,
    max: 30,
    label: 'Remind an approver after (days)',
    help: 'A pending step older than this gets a daily nudge to the approver; when it is the last step, HR is copied. 0 turns reminders off.',
  }),
  escalate_after_days: int({
    default: 0,
    min: 0,
    max: 30,
    label: 'Escalate a pending approval after (days)',
    help: 'A step nobody has acted on for this many days is skipped and the request moves to the next approver. 0 turns it off. The last approver is never skipped — an approval by neglect is worse than a wait.',
  }),
})

const benchmarks = defineConfig('benchmarks', {
  share_enabled: bool({
    default: false,
    label: 'Contribute to network benchmarks',
    help: 'Share six anonymised operational ratios (attrition, attendance, lateness, leave, overtime, approval turnaround — never pay) under a one-way hash, and see your company against companies of the same type and size. Nothing is shown for a segment with fewer than 10 contributors. Opting out deletes what you contributed.',
    risk: 'high',
  }),
})

const security = defineConfig('security', {
  mfa_required_for_admins: bool({
    default: false,
    label: 'Administrators must use two-factor authentication',
    help: 'Org admins, HR admins, payroll admins and finance users are asked to enrol an authenticator app before they can do anything else. Anyone may enrol voluntarily regardless.',
    risk: 'high',
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
  ...expenses,
  ...timesheets,
  ...recruitment,
  ...performance,
  ...people,
  ...assets,
  ...surveys,
  ...learning,
  ...branding,
  ...integrations,
  ...security,
  ...benchmarks,
  ...helpdesk,
  ...chat,
  ...mail,
  ...documents,
  ...notifications,
  ...privacy,
  ...approvals,
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
