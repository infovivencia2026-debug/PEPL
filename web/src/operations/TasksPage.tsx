import { AssetsPage } from '../work/Assets'
import { WorkReportsPage } from '../work/Reports'
import { ProfitabilityPage } from '../work/Profitability'
import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  Check,
  Sparkles,
} from 'lucide-react'
import { dateLabel } from '../api'
import { Badge, Button, Card, Empty, PageHeader, Tabs } from '../ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
}

export function TasksPage({ data, act, screen = 'tasks' }: Props & { screen?: string }) {
  const [busy, setBusy] = useState('')
  // Work hub: tasks, the asset register, work reports and project profitability
  const WORK: Array<[string, string, boolean]> = [
    ['tasks', 'My tasks', true],
    ['assets', 'Assets', data.permissions.includes('asset.read') && Boolean(data.modules.assets)],
    ['reports', 'Work reports', data.permissions.includes('task.read')],
    ['profitability', 'Profitability', data.permissions.includes('timesheet.read') && Boolean(data.modules.timesheets)],
  ]
  const shown = WORK.filter((v) => v[2])
  const workTabs = shown.length > 1 ? (
    <Tabs value={shown.find((v) => v[0] === screen)?.[1] ?? 'My tasks'} items={shown.map((v) => v[1])}
      onChange={(label) => { const v = shown.find((x) => x[1] === label); window.location.hash = `#/tasks${v && v[0] !== 'tasks' ? `/${v[0]}` : ''}` }} />
  ) : null
  if (screen === 'assets') return <><PageHeader title="Assets" description="What the company lent whom — and what must come back before anyone leaves." eyebrow="Work · Assets" />{workTabs}<AssetsPage data={data} /></>
  if (screen === 'reports') return <><PageHeader title="Work reports" description="The form your people fill in the field, rendered from your own template." eyebrow="Work · Reports" />{workTabs}<WorkReportsPage data={data} /></>
  if (screen === 'profitability') return <><PageHeader title="Project profitability" description="Hours against money, from approved timesheets and locked payroll." eyebrow="Work · Projects" />{workTabs}<ProfitabilityPage data={data} /></>
  return (
    <>
      <PageHeader
        title="Small steps. Real progress."
        description="Your assigned work, with room to focus."
        eyebrow="Your task list"
      />
      <div className="two-column">
        <Card title="Up next" subtitle={`${data.tasks.length} open tasks`}>
          {data.tasks.length ? (
            <div className="task-list">
              {data.tasks.map((t) => (
                <article key={t.id}>
                  <Button
                    variant="secondary"
                    disabled={busy === t.id}
                    aria-label={`Complete ${t.title}`}
                    onClick={async () => {
                      setBusy(t.id)
                      try {
                        await act(
                          `/tasks/${t.id}/complete`,
                          {},
                          'Task completed.',
                        )
                      } finally {
                        setBusy('')
                      }
                    }}
                  >
                    <Check size={18} />
                  </Button>
                  <div>
                    <h3>{t.title}</h3>
                    <p>
                      {t.due_date
                        ? `Due ${dateLabel(t.due_date)}`
                        : 'No due date'}
                    </p>
                  </div>
                  <Badge>{t.overdue ? 'overdue' : t.status}</Badge>
                </article>
              ))}
            </div>
          ) : (
            <Empty
              title="A little breathing room"
              text="You have no open assigned tasks. New tasks will appear here when they’re assigned to you."
            />
          )}
        </Card>
        <section className="focus-card">
          <Sparkles size={30} />
          <h2>
            One thing
            <br />
            at a time.
          </h2>
          <p>
            Give the important work
            <br />
            the attention it deserves.
          </p>
          <span className="focus-orb" />
        </section>
      </div>
    </>
  )
}
