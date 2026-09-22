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
]

export const presetByCode = (code: string): Preset | undefined => PRESETS.find((p) => p.code === code)
