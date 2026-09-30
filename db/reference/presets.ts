/**
 * Organisation-type presets (blueprint §6).
 *
 * A preset is DATA: which modules are on, which settings differ from the
 * Indian-SME default, which shifts to seed. Applied once at signup (or on
 * demand by an admin), after which it is ordinary configuration the company
 * can change. Nothing in the code path knows the organisation type — that is
 * what keeps PEPL one platform rather than six products.
 */
export interface ShiftSeed {
  code: string; name: string; startTime: string; endTime: string
  graceInMin?: number; breakMin?: number; fullDayMin: number; halfDayMin: number; otAfterMin?: number; otEligible?: boolean; weeklyOffDays: number[]
}
export interface Preset {
  code: string
  label: string
  description: string
  /** Who it fits, for the signup picker. */
  examples: string
  /** Settings that differ from the registry defaults. Keys must exist in the registry. */
  settings: Record<string, unknown>
  shifts: ShiftSeed[]
  /** Extra leave types beyond the standard EL/CL/SL/ML/CO/LOP. */
  leaveTypes: Array<{ code: string; name: string; isPaid: boolean }>
}

export const PRESETS: readonly Preset[] = [
  {
    code: 'office', label: 'Office / IT / services', description: 'Desk-based teams with flexible hours and optional remote work.',
    examples: 'software, consulting, accounting, back offices',
    settings: {
      'attendance.week_pattern': 'five_day', 'attendance.geofence_required': false, 'attendance.geofence_enforce': false,
      'attendance.wfh_requires_approval': false, 'attendance.remote_enabled': true, 'payroll.ot_pay': 'none',
      'expenses.enabled': true, 'timesheets.enabled': true, 'performance.enabled': true,
    },
    shifts: [{ code: 'GEN', name: 'General (9–6)', startTime: '09:00', endTime: '18:00', graceInMin: 15, breakMin: 60, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0, 6] }],
    leaveTypes: [],
  },
  {
    code: 'field_sales', label: 'Field sales / service', description: 'People on the road: visits, geo-tagged punches, travel and incentives.',
    examples: 'sales teams, service engineers, delivery, collections',
    settings: {
      'attendance.week_pattern': 'six_day', 'attendance.geofence_required': true, 'attendance.geofence_enforce': false,
      'attendance.remote_enabled': true, 'attendance.wfh_requires_approval': true, 'attendance.late_reason_required': true,
      'expenses.enabled': true, 'payroll.ot_pay': 'none',
    },
    shifts: [{ code: 'FIELD', name: 'Field day', startTime: '09:30', endTime: '18:30', graceInMin: 30, breakMin: 60, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0] }],
    leaveTypes: [],
  },
  {
    code: 'education', label: 'Education / school / coaching', description: 'Academic year, vacation leave, period-based days, substitute cover.',
    examples: 'schools, colleges, coaching centres, ed-tech with campuses',
    settings: {
      'leave.cycle_start_month': 6, 'attendance.week_pattern': 'six_day', 'attendance.geofence_required': false,
      'attendance.half_day_mode': 'hours_derived', 'attendance.half_day_hours': 4, 'attendance.qr_punch_enabled': true,
      'attendance.wfh_requires_approval': true, 'payroll.ot_pay': 'none', 'performance.enabled': true,
    },
    shifts: [
      { code: 'TEACH', name: 'Teaching day', startTime: '08:00', endTime: '15:30', graceInMin: 10, breakMin: 45, fullDayMin: 390, halfDayMin: 200, weeklyOffDays: [0] },
      { code: 'ADMIN', name: 'Office day', startTime: '09:00', endTime: '17:30', graceInMin: 15, breakMin: 45, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0] },
    ],
    leaveTypes: [{ code: 'VL', name: 'Vacation Leave', isPaid: true }],
  },
  {
    code: 'manufacturing', label: 'Manufacturing / construction / sites', description: 'Three-shift rosters, strict grace, statutory overtime, site fences, muster.',
    examples: 'factories, plants, construction sites, warehouses',
    settings: {
      'attendance.week_pattern': 'roster', 'attendance.geofence_required': true, 'attendance.geofence_enforce': true,
      'attendance.late_marks_per_half_day': 3, 'attendance.unmarked_day_is_lop': true, 'attendance.auto_checkout_after_minutes': 120,
      'attendance.breaks_deducted': true, 'attendance.qr_punch_enabled': true, 'attendance.remote_enabled': false,
      'payroll.ot_pay': 'double', 'approvals.no_approver_fallback': 'route_to_hr',
    },
    shifts: [
      { code: 'A', name: 'A shift (6–2)', startTime: '06:00', endTime: '14:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'B', name: 'B shift (2–10)', startTime: '14:00', endTime: '22:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'C', name: 'C shift (10–6)', startTime: '22:00', endTime: '06:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'GEN', name: 'General (9–6)', startTime: '09:00', endTime: '18:00', graceInMin: 10, breakMin: 60, fullDayMin: 420, halfDayMin: 210, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
    ],
    leaveTypes: [],
  },
  {
    code: 'retail', label: 'Retail / hospitality / clinics', description: 'Store hours, split shifts, any-day weekly off, kiosk punch, overtime.',
    examples: 'stores, restaurants, hotels, clinics, salons',
    settings: {
      'attendance.week_pattern': 'roster', 'attendance.geofence_required': true, 'attendance.geofence_enforce': true,
      'attendance.qr_punch_enabled': true, 'attendance.auto_checkout_after_minutes': 90, 'attendance.remote_enabled': false,
      'payroll.ot_pay': 'single', 'attendance.late_marks_per_half_day': 3,
    },
    shifts: [
      { code: 'OPEN', name: 'Opening (9–6)', startTime: '09:00', endTime: '18:00', graceInMin: 10, breakMin: 45, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [2] },
      { code: 'CLOSE', name: 'Closing (1–10)', startTime: '13:00', endTime: '22:00', graceInMin: 10, breakMin: 45, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [2] },
    ],
    leaveTypes: [],
  },
  {
    code: 'agency', label: 'Agency / creative / consulting', description: 'Project time, billable hours, weekly timesheet approval, comp-off for weekend work.',
    examples: 'design studios, media, law and CA firms, consultancies',
    settings: {
      'attendance.week_pattern': 'five_day', 'attendance.geofence_required': false, 'attendance.remote_enabled': true,
      'attendance.wfh_requires_approval': false, 'leave.comp_off_enabled': true, 'timesheets.enabled': true, 'expenses.enabled': true,
      'performance.enabled': true, 'payroll.ot_pay': 'none',
    },
    shifts: [{ code: 'STUDIO', name: 'Studio (10–7)', startTime: '10:00', endTime: '19:00', graceInMin: 30, breakMin: 60, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0, 6] }],
    leaveTypes: [],
  },
  // ── Added when the console offered five types and the server knew six of a
  //    different five. Each is a STARTING POINT, not a rulebook: the settings
  //    below are ordinary configuration the customer can change the moment it is
  //    applied. The one that moves money is `payroll.ot_pay`, so it follows the
  //    nearest existing preset rather than a guess of mine -- the customer's own
  //    contract and state rules decide it in the end.
  {
    code: 'healthcare', label: 'Healthcare / hospitals / diagnostics', description: 'Round-the-clock rosters, night shifts, strict site punch and overtime for the floor.',
    examples: 'hospitals, nursing homes, diagnostic labs, pharmacies',
    settings: {
      'attendance.week_pattern': 'roster', 'attendance.geofence_required': true, 'attendance.geofence_enforce': true,
      'attendance.qr_punch_enabled': true, 'attendance.auto_checkout_after_minutes': 120, 'attendance.remote_enabled': false,
      'attendance.late_marks_per_half_day': 3, 'payroll.ot_pay': 'single', 'approvals.no_approver_fallback': 'route_to_hr',
    },
    shifts: [
      { code: 'MORN', name: 'Morning (7–3)', startTime: '07:00', endTime: '15:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'EVE', name: 'Evening (3–11)', startTime: '15:00', endTime: '23:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'NIGHT', name: 'Night (11–7)', startTime: '23:00', endTime: '07:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'OPD', name: 'OPD / admin (9–5)', startTime: '09:00', endTime: '17:00', graceInMin: 15, breakMin: 45, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0] },
    ],
    leaveTypes: [],
  },
  {
    code: 'logistics', label: 'Logistics / transport / warehousing', description: 'Day and night crews, drivers on the road, trip expenses and site punch at the depot.',
    examples: 'transport companies, courier and delivery fleets, warehouses, cold chain',
    settings: {
      'attendance.week_pattern': 'six_day', 'attendance.geofence_required': true, 'attendance.geofence_enforce': false,
      'attendance.qr_punch_enabled': true, 'attendance.remote_enabled': false, 'attendance.late_reason_required': true,
      'expenses.enabled': true, 'payroll.ot_pay': 'single',
    },
    shifts: [
      { code: 'DAY', name: 'Day (8–5)', startTime: '08:00', endTime: '17:00', graceInMin: 15, breakMin: 60, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'NIGHT', name: 'Night (8pm–5am)', startTime: '20:00', endTime: '05:00', graceInMin: 15, breakMin: 60, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
    ],
    leaveTypes: [],
  },
  {
    code: 'security_facility', label: 'Security / housekeeping / facility services', description: 'Contract manpower posted to client sites: three-shift rosters, site fences, statutory overtime.',
    examples: 'security agencies, housekeeping and facility management, manpower contractors',
    settings: {
      'attendance.week_pattern': 'roster', 'attendance.geofence_required': true, 'attendance.geofence_enforce': true,
      'attendance.qr_punch_enabled': true, 'attendance.auto_checkout_after_minutes': 120, 'attendance.remote_enabled': false,
      'attendance.late_marks_per_half_day': 3, 'attendance.unmarked_day_is_lop': true, 'payroll.ot_pay': 'double',
      'approvals.no_approver_fallback': 'route_to_hr',
    },
    shifts: [
      { code: 'A', name: 'A shift (6–2)', startTime: '06:00', endTime: '14:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'B', name: 'B shift (2–10)', startTime: '14:00', endTime: '22:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
      { code: 'C', name: 'C shift (10–6)', startTime: '22:00', endTime: '06:00', graceInMin: 10, breakMin: 30, fullDayMin: 450, halfDayMin: 225, otAfterMin: 30, otEligible: true, weeklyOffDays: [0] },
    ],
    leaveTypes: [],
  },
  {
    code: 'ngo', label: 'NGO / non-profit / social enterprise', description: 'Programme and field teams, project time for grant reporting, comp-off for weekend outreach.',
    examples: 'NGOs, foundations, trusts, social enterprises, research bodies',
    settings: {
      'attendance.week_pattern': 'five_day', 'attendance.geofence_required': false, 'attendance.remote_enabled': true,
      'attendance.wfh_requires_approval': false, 'leave.comp_off_enabled': true, 'timesheets.enabled': true,
      'expenses.enabled': true, 'performance.enabled': true, 'payroll.ot_pay': 'none',
    },
    shifts: [{ code: 'GEN', name: 'General (9:30–6)', startTime: '09:30', endTime: '18:00', graceInMin: 30, breakMin: 45, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0, 6] }],
    leaveTypes: [],
  },
  {
    code: 'government', label: 'Government / public sector / aided institutions', description: 'Fixed office hours, punch on site, no overtime, HR routing when no approver is set.',
    examples: 'government departments, PSUs, municipal bodies, government-aided institutions',
    settings: {
      'attendance.week_pattern': 'five_day', 'attendance.geofence_required': true, 'attendance.geofence_enforce': false,
      'attendance.remote_enabled': false, 'attendance.late_marks_per_half_day': 3, 'payroll.ot_pay': 'none',
      'approvals.no_approver_fallback': 'route_to_hr',
    },
    shifts: [{ code: 'OFFICE', name: 'Office (10–5:30)', startTime: '10:00', endTime: '17:30', graceInMin: 15, breakMin: 30, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0, 6] }],
    leaveTypes: [],
  },
  {
    code: 'bfsi', label: 'Banking / finance / insurance', description: 'Branch and back-office hours, on-site punch, late reasons recorded, compliance-heavy approvals.',
    examples: 'banks, NBFCs, insurance, brokers, fintech with branches',
    settings: {
      'attendance.week_pattern': 'five_day', 'attendance.geofence_required': true, 'attendance.geofence_enforce': false,
      'attendance.remote_enabled': false, 'attendance.late_reason_required': true, 'expenses.enabled': true,
      'performance.enabled': true, 'payroll.ot_pay': 'none', 'approvals.no_approver_fallback': 'route_to_hr',
    },
    shifts: [{ code: 'BRANCH', name: 'Branch (10–6)', startTime: '10:00', endTime: '18:00', graceInMin: 15, breakMin: 45, fullDayMin: 420, halfDayMin: 210, weeklyOffDays: [0, 6] }],
    leaveTypes: [],
  },
]

export const presetByCode = (code: string): Preset | undefined => PRESETS.find((p) => p.code === code)
