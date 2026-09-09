import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  Clock3,
} from 'lucide-react'
import { dateLabel, pretty } from '../api'
import {
  Badge,
  Card,
  Empty,
  PageHeader,
  SearchBox,
} from '../ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
}

export function ActivityPage({ data }: Props) {
  const [search, setSearch] = useState('')
  const rows = data.activity.filter((a) =>
    `${a.action} ${a.entity_label ?? ''} ${a.actor_label ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <>
      <PageHeader
        title="Every step, accounted for"
        description="A record of changes across your workspace."
        eyebrow="Activity log"
      />
      <Card>
        <SearchBox
          value={search}
          onChange={setSearch}
          placeholder="Search recent activity..."
        />
        {rows.length ? (
          <div className="activity-full">
            {rows.map((a) => (
              <article key={a.id}>
                <span className="icon-box">
                  <Clock3 size={19} />
                </span>
                <div>
                  <h3>{pretty(a.action)}</h3>
                  <p>
                    {a.entity_label ?? pretty(a.entity_type)}
                    {a.actor_label ? ` · ${a.actor_label}` : ''}
                  </p>
                </div>
                <Badge>{a.severity}</Badge>
                <time>
                  {dateLabel(a.created_at)}
                  <small>
                    {new Date(a.created_at).toLocaleTimeString('en-IN', {
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </small>
                </time>
              </article>
            ))}
          </div>
        ) : (
          <Empty
            title="No recent activity in this view"
            text="The latest 30 permitted events appear here as work happens."
          />
        )}
      </Card>
    </>
  )
}
