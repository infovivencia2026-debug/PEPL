import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import {
  Check,
  CheckCheck,
  Send,
} from 'lucide-react'
import { dateLabel } from '../api'
import {
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

export function AnnouncementsPage({ data, act }: Props) {
  return (
    <>
      <PageHeader
        title="Worth sharing"
        description="Company news, useful updates, and a sense of belonging."
        eyebrow="Your noticeboard"
      />
      <div className="announcement-grid">
        {data.announcements.length ? (
          data.announcements.map((a) => (
            <Card key={a.id}>
              <div className="announcement-header">
                <span className="icon-box">
                  <Send size={21} />
                </span>
                <time>{dateLabel(a.publish_at)}</time>
              </div>
              <h2>{a.title}</h2>
              <p className="announcement-body">
                {
                  new DOMParser().parseFromString(a.body_html, 'text/html').body
                    .textContent
                }
              </p>
              {a.requires_acknowledgement && (
                <footer>
                  {a.acknowledged_at ? (
                    <span className="acknowledged">
                      <CheckCheck size={18} />
                      Acknowledged {dateLabel(a.acknowledged_at)}
                    </span>
                  ) : (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        void act(
                          `/announcements/${a.id}/acknowledge`,
                          {},
                          'Announcement acknowledged.',
                        )
                      }
                    >
                      <Check size={17} />
                      I’ve read this
                    </Button>
                  )}
                </footer>
              )}
            </Card>
          ))
        ) : (
          <Card>
            <Empty
              title="A quiet noticeboard, for now"
              text="Announcements addressed to you will appear here when published."
            />
          </Card>
        )}
      </div>
    </>
  )
}
