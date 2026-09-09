/**
 * The navigation model.
 *
 * Two lists, not one: NAV is the primary rail, MORE is what sits behind the
 * overflow menu. Each entry names the permission and module that make it
 * visible, so navigation is derived from what the person can actually reach
 * rather than from their role name — a tenant may call a role anything.
 */
import {
  Activity,
  CalendarDays,
  ChartNoAxesCombined,
  CheckCheck,
  LayoutDashboard,
  ListTodo,
  Megaphone,
  Settings2,
  Users,
  Wallet,
} from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  icon: typeof Users
  permission?: string
  module?: string
}

export const NAV: NavItem[] = [
  { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
  { id: 'people', label: 'People', icon: Users, permission: 'employee.read' },
  {
    id: 'attendance',
    label: 'Attendance',
    icon: CalendarDays,
    permission: 'attendance.read',
    module: 'attendance',
  },
  {
    id: 'leave',
    label: 'Leave',
    icon: CalendarDays,
    permission: 'leave.read',
    module: 'leave',
  },
  {
    id: 'payroll',
    label: 'Payroll',
    icon: Wallet,
    permission: 'payroll.read',
    module: 'payroll',
  },
  {
    id: 'reports',
    label: 'Reports',
    icon: ChartNoAxesCombined,
    permission: 'report.read',
  },
]
export const MORE: NavItem[] = [
  {
    id: 'approvals',
    label: 'Approvals',
    icon: CheckCheck,
    permission: 'approval.act',
  },
  { id: 'tasks', label: 'My tasks', icon: ListTodo, permission: 'task.read' },
  {
    id: 'announcements',
    label: 'Announcements',
    icon: Megaphone,
    permission: 'announcement.read',
  },
  {
    id: 'activity',
    label: 'Activity log',
    icon: Activity,
    permission: 'audit.read',
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings2,
    permission: 'settings.write',
  },
]
export function getRoute() {
  return location.hash.replace(/^#\/?/, '') || 'dashboard'
}
