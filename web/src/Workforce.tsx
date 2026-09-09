/**
 * Attendance, leave and approvals.
 *
 * The three screens live in ./workforce/, one file each. This barrel keeps the
 * import path stable for anything that already reaches for them.
 */
export { AttendancePage } from './workforce/AttendancePage'
export { LeavePage } from './workforce/LeavePage'
export { ApprovalsPage } from './workforce/ApprovalsPage'
