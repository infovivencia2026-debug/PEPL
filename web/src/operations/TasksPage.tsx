import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  Check,
  Sparkles,
} from 'lucide-react'
import { dateLabel } from '../api'
import {
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
} from '../ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
}

export function TasksPage({ data, act }: Props) {
  const [busy, setBusy] = useState('')
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
