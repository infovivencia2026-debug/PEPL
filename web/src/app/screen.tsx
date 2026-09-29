/**
 * Which screen the current route shows.
 *
 * Route to element and nothing else: no data loading, no state. Keeping the
 * decision in one place means an unreachable route fails the same way
 * everywhere — with the page that explains it, not a blank panel.
 */
import { lazy, Suspense, type ReactElement } from 'react'
import { Card, Empty, Skeleton } from '../ui'
import { Dashboard } from '../Dashboard'
import { People, EmployeeProfile } from '../People'
import { AttendancePage, ApprovalsPage, LeavePage } from '../Workforce'
import {
  TasksPage,
  SettingsPage,
  ReportsPage,
  ActivityPage,
} from '../Operations'
import { PayrollPage } from '../Payroll'
const Communications = lazy(() => import('../Communications').then((m) => ({ default: m.Communications })))
import { EngagePage } from '../engage/Engage'
const GrowthPage = lazy(() => import('../growth/Growth').then((m) => ({ default: m.GrowthPage })))
import { CompanyPage } from '../company/Company'
const ReportBuilder = lazy(() => import('../reports/Builder').then((m) => ({ default: m.ReportBuilder })))
import { DocumentsPage, ImportPage } from '../DataTools'
import { PaymentsPage } from '../PaymentsPage'
import { MyTaxDeclaration, TaxDeclarationsQueue } from '../TaxDeclarations'
import { PushSettings } from '../PushSettings'
import { AccountSettings } from '../Account'
import { Organisation } from '../Organisation'
const RecruitmentPage = lazy(() => import('../Recruitment').then((m) => ({ default: m.RecruitmentPage })))
const PerformancePage = lazy(() => import('../Performance').then((m) => ({ default: m.PerformancePage })))
import type { Workspace } from '../types'
import type { FormSpec } from '../forms'

export interface ScreenArgs {
  data: Workspace
  props: {
    data: Workspace
    open: (s: FormSpec | null) => void
    act: (path: string, body: unknown, message: string) => Promise<void>
  }
  route: string
  section: string
  permitted: boolean
  revision: number
  setForm: (s: FormSpec | null) => void
  load: () => Promise<void>
  onDate: (s: string) => void
}

export function screenFor({
  data, props, route, section, permitted, revision, setForm, load, onDate,
}: ScreenArgs): ReactElement | null {
  let page: ReactElement | null = null
  if (!permitted)
    page = (
      <Card>
        <Empty
          title="This page isn’t available"
          text="Choose a page from your navigation to continue."
          action={
            <a href="#/dashboard" className="btn primary">
              Back to overview
            </a>
          }
        />
      </Card>
    )
  else if (section === 'dashboard') page = <Dashboard data={data} act={props.act} />
  else if (section === 'company') page = <CompanyPage data={data} screen={route.split('/')[1] || 'security'} />
  else if (section === 'growth') page = <GrowthPage data={data} screen={route.split('/')[1] || 'learning'} />
  else if (section === 'engage') page = <EngagePage data={data} screen={route.split('/')[1] || 'policies'} />
  else if (section === 'chat' || section === 'mail') page = <Communications key={section} mode={section} data={data} />
  else if (section === 'documents') page = <DocumentsPage data={data} />
  else if (section === 'import') page = <ImportPage />
  else if (section === 'bank-files') page = <PaymentsPage data={data} />
  else if (section === 'my-tax') page = <MyTaxDeclaration data={data} />
  else if (section === 'tax-declarations') page = <TaxDeclarationsQueue data={data} />
  else if (section === 'notification-settings') page = <PushSettings />
  else if (section === 'account') page = <AccountSettings data={data} />
  else if (section === 'organisation') page = <Organisation data={data} />
  else if (section === 'hiring') page = <RecruitmentPage data={data} route={route} />
  else if (section === 'performance') page = <PerformancePage data={data} />
  else if (section === 'people')
    page = ['org-chart', 'positions', 'probation', 'letters', 'requests'].includes(route.split('/')[1] ?? '') ? (
      <People data={data} open={setForm} screen={route.split('/')[1]} />
    ) : route.split('/')[1] ? (
      <EmployeeProfile
        id={route.split('/')[1]}
        data={data}
        open={setForm}
        revision={revision}
      />
    ) : (
      <People data={data} open={setForm} />
    )
  else if (section === 'attendance')
    page = (
      <AttendancePage
        {...props}
        onDate={onDate}
        view={route.split('/')[1] || 'register'}
      />
    )
  else if (section === 'leave') page = <LeavePage {...props} />
  else if (section === 'approvals') page = <ApprovalsPage {...props} />
  else if (section === 'payroll')
    page = ['compliance', 'contractors', 'bonus'].includes(route.split('/')[1] ?? '')
      ? <PayrollPage {...props} refresh={load} screen={route.split('/')[1]} />
      : <PayrollPage {...props} refresh={load} />
  else if (section === 'tasks') page = <TasksPage {...props} screen={route.split('/')[1] || 'tasks'} />
  else if (section === 'reports') page = route.split('/')[1] === 'builder' ? <ReportBuilder data={data} /> : <ReportsPage {...props} />
  else if (section === 'activity') page = <ActivityPage {...props} />
  else if (section === 'settings') page = <SettingsPage {...props} />
  // Each lazy screen is its own chunk, so the first load no longer carries
  // Mailbox, Recruitment, Performance, Growth and the report builder for
  // somebody who only opens the dashboard. The fallback is the app's own
  // skeleton, not a spinner, so the layout does not jump when it arrives.
  return page === null ? null : <Suspense fallback={<Skeleton />}>{page}</Suspense>
}
