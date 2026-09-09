/**
 * Everything the dashboard counts, derived in one place.
 *
 * Pure functions over the workspace payload: no JSX, no fetching. Keeping the
 * arithmetic out of the tiles means a tile is only layout, and a number can be
 * checked without rendering anything.
 */
import type { Workspace } from '../types'

export interface DashboardMetrics {
  employees: Workspace['employees']
  activeCount: number
  month: string
  joiners: Workspace['employees']
  onLeaveToday: number
  presentCount: number
  totalAttendance: number
  remoteCount: number
  attendanceSegments: { label: string; value: number }[]
  presentPercent: number
  departmentSegments: { label: string; value: number }[]
  payrollThisMonth: Workspace['payroll'][number] | undefined
}

const OTHER_STATUSES = ['present', 'on_duty', 'on_leave', 'absent']

export function deriveMetrics(data: Workspace): DashboardMetrics {
  const employees = data.employees
  const month = data.today.slice(0, 7)

  const joiners = employees
    .filter((e) => e.date_of_joining.startsWith(month))
    .sort((a, b) => b.date_of_joining.localeCompare(a.date_of_joining))

  const onLeaveToday = data.leaves.filter(
    (l) =>
      l.status === 'approved' &&
      l.start_date <= data.today &&
      l.end_date >= data.today,
  ).length

  const count = (predicate: (a: Workspace['attendance'][number]) => boolean) =>
    data.attendance.filter(predicate).length

  const presentCount = count((a) => a.status === 'present' || a.status === 'on_duty')
  const totalAttendance = data.attendance.length

  const byDepartment = Object.entries(
    employees.reduce<Record<string, number>>((acc, e) => {
      const key = e.department ?? 'Unassigned'
      acc[key] = (acc[key] ?? 0) + 1
      return acc
    }, {}),
  ).sort((a, b) => b[1] - a[1])

  const departmentSegments = byDepartment
    .slice(0, 5)
    .map(([label, value]) => ({ label, value }))
  if (byDepartment.length > 5) {
    departmentSegments.push({
      label: 'Other',
      value: byDepartment.slice(5).reduce((sum, [, n]) => sum + n, 0),
    })
  }

  return {
    employees,
    activeCount: employees.filter((e) => e.status === 'active').length,
    month,
    joiners,
    onLeaveToday,
    presentCount,
    totalAttendance,
    remoteCount: count((a) => a.is_remote),
    attendanceSegments: [
      { label: 'Present', value: presentCount },
      { label: 'On leave', value: count((a) => a.status === 'on_leave') },
      { label: 'Absent', value: count((a) => a.status === 'absent') },
      { label: 'Other', value: count((a) => !OTHER_STATUSES.includes(a.status)) },
    ],
    presentPercent: totalAttendance
      ? Math.round((presentCount / totalAttendance) * 100)
      : 0,
    departmentSegments,
    payrollThisMonth: data.payroll.find((p) => p.label.startsWith(month)),
  }
}

export function greetingFor(date = new Date()): string {
  const hour = date.getHours()
  if (hour < 12) return 'Good morning'
  if (hour < 17) return 'Good afternoon'
  return 'Good evening'
}

/** The permission predicate every tile uses to decide whether it renders. */
export const permits = (data: Workspace) => (permission: string) =>
  data.permissions.includes(permission)
