import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  CalendarDays,
  Check,
  CheckCheck,
  Undo2,
} from 'lucide-react'
import { fullName, dateLabel, pretty } from '../api'
import {
  Avatar,
  Badge,
  Button,
  Card,
  Empty,
  PageHeader,
  Tabs,
} from '../ui'
type Props = { data: Workspace; open: (s: FormSpec) => void }

export function ApprovalsPage({
  data,
  act,
}: {
  data: Workspace
  act: (path: string, body: unknown, message: string) => Promise<void>
}) {
  const [filter, setFilter] = useState('All requests'),
    [comment, setComment] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState<string | null>(null)
  const rows = data.approvals.filter(
    (a) => filter === 'All requests' || pretty(a.entity_type) === filter,
  )
  async function decide(id: string, action: string) {
    setBusy(id)
    try {
      await act(
        `/approvals/${id}/actions`,
        { action, comment: comment[id] ?? '' },
        'Decision recorded.',
      )
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <PageHeader
        title="A little attention goes a long way"
        description="The decisions waiting for you, all in one place."
        eyebrow="Your approval inbox"
      />
      <div className="approval-summary">
        <span className="icon-box">
          <CheckCheck size={23} />
        </span>
        <div>
          <strong>
            {data.approvals.length} pending{' '}
            {data.approvals.length === 1 ? 'decision' : 'decisions'}
          </strong>
          <p>Requests assigned to your current approval step.</p>
        </div>
      </div>
      <Tabs
        value={filter}
        onChange={setFilter}
        items={[
          'All requests',
          ...new Set(data.approvals.map((a) => pretty(a.entity_type))),
        ]}
      />
      {rows.length ? (
        <div className="approval-grid">
          {rows.map((a) => {
            const l = data.leaves.find((l) => l.id === a.entity_id)
            return (
              <Card key={a.request_id}>
                <div className="approval-full-head">
                  <span className="person-line">
                    <Avatar name={l ? fullName(l) : a.title} />
                    <span>
                      <strong>{l ? fullName(l) : a.title}</strong>
                      <small>{pretty(a.entity_type)} request</small>
                    </span>
                  </span>
                  <Badge>pending</Badge>
                </div>
                <h2>{l ? l.leave_name : a.title}</h2>
                <div className="request-details">
                  <span>
                    <CalendarDays size={16} />
                    {l
                      ? `${dateLabel(l.start_date)} – ${dateLabel(l.end_date)}`
                      : dateLabel(a.created_at)}
                  </span>
                  {l && <span>{l.total_days} day(s)</span>}
                </div>
                {l?.reason && <blockquote>{l.reason}</blockquote>}
                <p className="subtle">
                  Submitted {dateLabel(a.created_at)} · Approval step{' '}
                  {a.step_no}
                </p>
                {a.entity_type === 'leave' ? (
                  <>
                    <label className="field">
                      <span className="sr-only">Comment for {a.title}</span>
                      <input
                        placeholder="Add a note (optional)"
                        value={comment[a.request_id] ?? ''}
                        maxLength={2000}
                        onChange={(e) =>
                          setComment({
                            ...comment,
                            [a.request_id]: e.target.value,
                          })
                        }
                      />
                    </label>
                    <div className="decision-actions">
                      <Button
                        disabled={busy === a.request_id}
                        onClick={() => void decide(a.request_id, 'approve')}
                      >
                        <Check size={17} />
                        Approve
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy === a.request_id}
                        onClick={() => void decide(a.request_id, 'reject')}
                      >
                        Reject
                      </Button>
                      <Button
                        variant="ghost"
                        disabled={busy === a.request_id}
                        onClick={() => void decide(a.request_id, 'send_back')}
                      >
                        <Undo2 size={16} />
                        Send back
                      </Button>
                    </div>
                  </>
                ) : (
                  <p className="form-intro">
                    Complete this decision in the originating module.
                  </p>
                )}
              </Card>
            )
          })}
        </div>
      ) : (
        <Card>
          <Empty
            title="You’re all caught up"
            text="Take a breath. There are no requests waiting for your decision."
          />
        </Card>
      )}
    </>
  )
}
