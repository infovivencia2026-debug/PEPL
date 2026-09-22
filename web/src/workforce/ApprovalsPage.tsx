/**
 * The approval inbox.
 *
 * Every module raises approvals here, so this is one queue with one set of
 * verbs: approve, reject, send back — on one card or on a selection. Where a
 * step came from is said in words (routed to you as HR, delegated by, reminded)
 * rather than colour, because a manager deciding for a stranger needs to know
 * why it landed with them before they decide.
 */
import type { Workspace, Approval } from '../types'
import { useMemo, useState } from 'react'
import {
  BellRing,
  CalendarDays,
  Check,
  CheckCheck,
  CheckSquare2,
  Route,
  Square,
  Undo2,
  UserRoundCheck,
  X,
} from 'lucide-react'
import { fullName, dateLabel, pretty } from '../api'
import { domainApi } from '../domainApi'
import { Avatar, Button, Card, Empty, PageHeader, Tabs } from '../ui'

const ROLE_LABEL: Record<string, string> = { manager: 'as manager', hr: 'as HR', finance: 'as finance', dept_head: 'as department head' }

function waiting(hours: number): string {
  if (hours < 1) return 'just now'
  if (hours < 24) return `${Math.floor(hours)} h`
  const d = Math.floor(hours / 24)
  return `${d} day${d === 1 ? '' : 's'}`
}

/** Where this step came from, in words. Empty when it is simply yours. */
function Provenance({ a }: { a: Approval }) {
  const items: Array<{ icon: typeof Route; text: string; tone: 'amber' | 'green' | 'muted' }> = []
  if (a.routed_to_hr) items.push({ icon: Route, text: 'Routed to you as HR — the requester had no approver', tone: 'amber' })
  if (a.delegated_from) items.push({ icon: UserRoundCheck, text: `Delegated by ${a.delegated_from}`, tone: 'green' })
  if (a.reminded_at) items.push({ icon: BellRing, text: `Reminded ${dateLabel(a.reminded_at)}`, tone: 'muted' })
  if (!items.length) return null
  return (
    <ul className="provenance" aria-label="How this reached you">
      {items.map((i) => (
        <li key={i.text} className={i.tone}>
          <i.icon size={13} aria-hidden="true" />
          {i.text}
        </li>
      ))}
    </ul>
  )
}

export function ApprovalsPage({ data, act }: { data: Workspace; act: (path: string, body: unknown, message: string) => Promise<void> }) {
  const [filter, setFilter] = useState('All requests')
  const [comment, setComment] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkComment, setBulkComment] = useState('')
  const [bulkMode, setBulkMode] = useState<'approve' | 'reject' | null>(null)
  const [bulkResult, setBulkResult] = useState<{ ok: number; failed: string[] } | null>(null)

  const rows = useMemo(
    () => data.approvals.filter((a) => filter === 'All requests' || pretty(a.entity_type) === filter),
    [data.approvals, filter],
  )
  const stale = data.approvals.filter((a) => a.age_hours >= 48).length
  const routed = data.approvals.filter((a) => a.routed_to_hr).length
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.request_id))

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  }
  function toggleAll() {
    setSelected(allVisibleSelected ? new Set() : new Set(rows.map((r) => r.request_id)))
  }
  // Decisions go to the domain API; `act` (the UI API) is then used only to reload the workspace and toast.
  const refresh = (message: string) => act('/workspace', undefined, message)
  async function decide(id: string, action: string) {
    setBusy(id)
    try {
      await domainApi(`/approvals/${id}/act`, { action, comment: (comment[id] ?? '').trim() || undefined })
      setSelected((s) => { const n = new Set(s); n.delete(id); return n })
      await refresh('Decision recorded.')
    } catch (e) {
      await refresh((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  async function bulk(action: 'approve' | 'reject') {
    if (action === 'reject' && !bulkComment.trim()) { setBulkMode('reject'); return }
    setBusy('bulk')
    try {
      const ids = [...selected].slice(0, 50)
      const r = await domainApi<{ results: Array<{ id: string; status?: string; error?: string }> }>('/approvals/bulk', { ids, action, comment: bulkComment.trim() || undefined })
      const failed = r.results.filter((x) => x.error)
      setBulkResult({ ok: r.results.length - failed.length, failed: failed.map((f) => data.approvals.find((a) => a.request_id === f.id)?.title ?? f.id) })
      setSelected(new Set(failed.map((f) => f.id)))
      setBulkComment('')
      setBulkMode(null)
      await refresh(`${r.results.length - failed.length} decided.`)
    } catch (e) {
      await refresh((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title="A little attention goes a long way"
        description="The decisions waiting for you, all in one place — from every module."
        eyebrow="Your approval inbox"
      />
      <div className="approval-summary">
        <span className="icon-box">
          <CheckCheck size={23} aria-hidden="true" />
        </span>
        <div>
          <strong>
            {data.approvals.length} pending {data.approvals.length === 1 ? 'decision' : 'decisions'}
          </strong>
          <p>
            {stale ? `${stale} waiting more than two days` : 'Nothing has waited more than two days'}
            {routed ? ` · ${routed} routed to you as HR` : ''}
          </p>
        </div>
        {rows.length > 0 && (
          <button type="button" className="select-all" onClick={toggleAll} aria-pressed={allVisibleSelected}>
            {allVisibleSelected ? <CheckSquare2 size={17} aria-hidden="true" /> : <Square size={17} aria-hidden="true" />}
            {allVisibleSelected ? 'Clear selection' : `Select all ${rows.length}`}
          </button>
        )}
      </div>
      <Tabs
        value={filter}
        onChange={(v) => { setFilter(v); setSelected(new Set()) }}
        items={['All requests', ...new Set(data.approvals.map((a) => pretty(a.entity_type)))]}
      />
      {bulkResult && (
        <div className={`bulk-result ${bulkResult.failed.length ? 'partial' : ''}`} role="status">
          <strong>{bulkResult.ok} decided.</strong>
          {bulkResult.failed.length > 0 && <span> Not decided ({bulkResult.failed.length}): {bulkResult.failed.join(', ')} — they were already decided or are not yours; they stay selected.</span>}
          <button type="button" className="btn ghost" onClick={() => setBulkResult(null)} aria-label="Dismiss">
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      )}
      {rows.length ? (
        <div className="approval-grid">
          {rows.map((a) => {
            const l = data.leaves.find((l) => l.id === a.entity_id)
            const who = l ? fullName(l) : a.subject_name ?? a.requested_by ?? a.title
            const isSel = selected.has(a.request_id)
            return (
              <Card key={a.request_id} className={`approval-card ${isSel ? 'selected' : ''}`}>
                <div className="approval-full-head">
                  <label className="select-box">
                    <input type="checkbox" checked={isSel} onChange={() => toggle(a.request_id)} aria-label={`Select ${a.title}`} />
                    <span className="person-line">
                      <Avatar name={who} />
                      <span>
                        <strong>{who}</strong>
                        <small>{pretty(a.entity_type)} request{a.requested_by && a.requested_by !== who ? ` · raised by ${a.requested_by}` : ''}</small>
                      </span>
                    </span>
                  </label>
                  <span className={`age ${a.age_hours >= 48 ? 'stale' : ''}`} title={`Submitted ${dateLabel(a.created_at)}`}>
                    waiting {waiting(a.age_hours)}
                  </span>
                </div>
                <h2>{l ? l.leave_name : a.title}</h2>
                <div className="request-details">
                  <span>
                    <CalendarDays size={16} aria-hidden="true" />
                    {l ? `${dateLabel(l.start_date)} – ${dateLabel(l.end_date)}` : dateLabel(a.created_at)}
                  </span>
                  {l && <span>{l.total_days} day(s)</span>}
                  <span>Step {a.step_no}{a.approver_role ? ` ${ROLE_LABEL[a.approver_role] ?? ''}` : ''}</span>
                </div>
                <Provenance a={a} />
                {l?.reason && <blockquote>{l.reason}</blockquote>}
                <label className="field">
                  <span className="sr-only">Comment for {a.title}</span>
                  <input
                    placeholder="Add a note (optional; required to reject)"
                    value={comment[a.request_id] ?? ''}
                    maxLength={2000}
                    onChange={(e) => setComment({ ...comment, [a.request_id]: e.target.value })}
                  />
                </label>
                <div className="decision-actions">
                  <Button disabled={busy !== null} onClick={() => void decide(a.request_id, 'approve')}>
                    <Check size={17} aria-hidden="true" />
                    Approve
                  </Button>
                  <Button variant="danger" disabled={busy !== null || !(comment[a.request_id] ?? '').trim()} title={(comment[a.request_id] ?? '').trim() ? undefined : 'Add a note to reject'} onClick={() => void decide(a.request_id, 'reject')}>
                    Reject
                  </Button>
                  <Button variant="ghost" disabled={busy !== null} onClick={() => void decide(a.request_id, 'send_back')}>
                    <Undo2 size={16} aria-hidden="true" />
                    Send back
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      ) : (
        <Card>
          <Empty title="You’re all caught up" text="Take a breath. There are no requests waiting for your decision." />
        </Card>
      )}
      {selected.size > 0 && (
        <div className="decision-tray" role="region" aria-label="Bulk decision">
          <strong>{selected.size} selected</strong>
          {bulkMode === 'reject' ? (
            <label className="field tray-field">
              <span className="sr-only">Reason for rejecting {selected.size} requests</span>
              <input autoFocus placeholder="Why are these rejected? (sent to each requester)" value={bulkComment} maxLength={2000} onChange={(e) => setBulkComment(e.target.value)} />
            </label>
          ) : (
            <label className="field tray-field">
              <span className="sr-only">Note for the selected requests</span>
              <input placeholder="Note for all (optional)" value={bulkComment} maxLength={2000} onChange={(e) => setBulkComment(e.target.value)} />
            </label>
          )}
          <div className="decision-actions">
            {bulkMode !== 'reject' && (
              <Button disabled={busy !== null} onClick={() => void bulk('approve')}>
                <Check size={17} aria-hidden="true" />
                Approve {selected.size}
              </Button>
            )}
            <Button variant="danger" disabled={busy !== null || (bulkMode === 'reject' && !bulkComment.trim())} onClick={() => void bulk('reject')}>
              {bulkMode === 'reject' ? `Reject ${selected.size}` : 'Reject…'}
            </Button>
            <Button variant="ghost" disabled={busy !== null} onClick={() => { setSelected(new Set()); setBulkMode(null) }}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
