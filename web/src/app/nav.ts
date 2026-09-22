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
  Settings2,
  Users,
  Wallet,
  MessageCircle,
  Mail,
  FileText,
  FileSpreadsheet,
  Landmark,
  ReceiptIndianRupee,
  BellRing,
  BriefcaseBusiness,
  Target,
  PartyPopper,
  GraduationCap,
  Building2,
} from 'lucide-react'

export interface NavItem {
  id: string
  label: string
  icon: typeof Users
  permission?: string
  module?: string
  employeeRequired?: boolean
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
  { id: 'engage', label: 'Engage', icon: PartyPopper },
  { id: 'growth', label: 'Growth', icon: GraduationCap },
  { id: 'company', label: 'Company', icon: Building2, permission: 'settings.write' },
  { id: 'performance', label: 'Performance', icon: Target, permission: 'performance.read', module: 'performance' },
  { id: 'hiring', label: 'Hiring', icon: BriefcaseBusiness, permission: 'recruit.read', module: 'recruitment' },
  { id: 'organisation', label: 'Organisation', icon: Users, permission: 'settings.write' },
  { id: 'chat', label: 'Team chat', icon: MessageCircle },
  { id: 'mail', label: 'Mailbox', icon: Mail },
  { id: 'documents', label: 'Documents', icon: FileText, permission: 'document.read', module: 'documents' },
  { id: 'import', label: 'Import employees', icon: FileSpreadsheet, permission: 'import.run' },
  { id: 'bank-files', label: 'Bank files', icon: Landmark, permission: 'bank.read', module: 'payroll' },
  { id: 'my-tax', label: 'My tax declaration', icon: ReceiptIndianRupee, permission: 'payroll.read', module: 'payroll', employeeRequired: true },
  { id: 'tax-declarations', label: 'Declarations queue', icon: ReceiptIndianRupee, permission: 'payroll.process', module: 'payroll' },
  { id: 'notification-settings', label: 'Notification settings', icon: BellRing },
  { id: 'account', label: 'Account settings', icon: Settings2 },
  {
    id: 'approvals',
    label: 'Approvals',
    icon: CheckCheck,
    permission: 'approval.act',
  },
  { id: 'tasks', label: 'My tasks', icon: ListTodo, permission: 'task.read' },
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
