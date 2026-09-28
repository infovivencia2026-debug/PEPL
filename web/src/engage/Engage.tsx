/**
 * Engage: policies people must acknowledge, surveys that are anonymous by
 * construction, the recognition wall, and this week's celebrations. The
 * anonymity promise is printed where answers are given, because a promise
 * made elsewhere is not a promise.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Award, Cake, Check, FileText, Gift, PartyPopper, Plus, Send, ShieldCheck } from 'lucide-react'
import { domainApi } from '../domainApi'
import { fullName, dateLabel, errorCode } from '../api'
import { Avatar, Button, Card, Empty, ErrorBox, Modal, PageHeader, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Policy { id: string; code: string; title: string; version: number; body: string | null; status: string; requires_acknowledgement: boolean; due_days: number; published_at: string | null; acknowledged_at: string | null }
interface Survey { id: string; title: string; kind: string; status: string; anonymous: boolean; min_group: number; closes_at: string | null; questions: Array<{ id: string; text: string; type: 'scale' | 'nps' | 'text' | 'choice'; options?: string[] }>; responded?: boolean }
interface Celebration { employeeId: string; name: string; kind: 'birthday' | 'anniversary'; on: string; years?: number }

export function EngagePage({ data, screen = 'policies' }: { data: Workspace; screen?: string }) {
  const VIEWS: Array<[string, string, boolean]> = [
    ['policies', 'Policies', data.permissions.includes('policy.read')],
    ['surveys', 'Surveys', data.permissions.includes('survey.read') && Boolean(data.modules.surveys)],
    ['recognition', 'Recognition', Boolean(data.modules.learning)],
    ['celebrations', 'Celebrations', true],
  ]
  const shown = VIEWS.filter((v) => v[2])
  const tabs = <Tabs value={shown.find((v) => v[0] === screen)?.[1] ?? shown[0]?.[1] ?? ''} items={shown.map((v) => v[1])}
    onChange={(label) => { const v = shown.find((x) => x[1] === label); window.location.hash = `#/engage${v && v[0] !== 'policies' ? `/${v[0]}` : ''}` }} />
  const HEAD: Record<string, [string, string]> = {
    policies: ['Policies', 'What everyone agreed to, and who still has to.'],
    surveys: ['Surveys', 'Ask honestly; answers on an anonymous survey cannot be traced to anyone.'],
    recognition: ['Recognition', 'Say thank you where the company can see it.'],
    celebrations: ['Celebrations', 'Birthdays and work anniversaries coming up.'],
  }
  const [title, description] = HEAD[screen] ?? HEAD.policies!
  return (
    <>
      <PageHeader title={title} description={description} eyebrow={`Engage · ${title}`} />
      {tabs}
      {screen === 'surveys' ? <Surveys data={data} /> : screen === 'recognition' ? <Recognition data={data} /> : screen === 'celebrations' ? <Celebrations data={data} /> : <Policies data={data} />}
    </>
  )
}

function Policies({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<Policy[] | null>(null)
  const [error, setError] = useState('')
  // The API code behind `error`, so a plan-gated module reads as an offer.
  const [code, setCode] = useState<string | undefined>()
  const [busy, setBusy] = useState('')
  const [drafting, setDrafting] = useState(false)
  const [compliance, setCompliance] = useState<{ id: string; audience: number; acknowledged: number; overdue: number; pending: Array<{ name: string; department: string | null; dueOn: string }> } | null>(null)
  const canManage = data.permissions.includes('policy.manage')
  const load = useCallback(async () => { try { setRows((await domainApi<{ policies: Policy[] }>('/policies')).policies); setError('') } catch (e) { setError((e as Error).message); setCode(errorCode(e)) } }, [])
  useEffect(() => { void load() }, [load])
  async function act(path: string, id: string) { setBusy(id); try { await domainApi(path, {}); await load() } catch (e) { setError((e as Error).message); setCode(errorCode(e)) } finally { setBusy('') } }
  return (
    <>
      {canManage && <div className="row-actions"><Button onClick={() => setDrafting(true)}><Plus size={16} aria-hidden="true" />Draft a policy</Button></div>}
      {error && <ErrorBox message={error} code={code} />}
      {!rows ? <Skeleton /> : !rows.length ? <Card><Empty title="No policies yet" text="POSH, leave, travel, code of conduct — publish one and everyone it applies to is asked to acknowledge it." /></Card> : (
        <div className="template-grid">
          {rows.map((p) => (
            <Card key={p.id}>
              <div className="approval-full-head">
                <div><strong>{p.title}</strong><small>{p.code} · v{p.version}</small></div>
                <span className={`badge ${p.status === 'published' ? 'green' : p.status === 'retired' ? 'coral' : 'amber'}`}><span />{p.status}</span>
              </div>
              {p.body && <p className="template-excerpt">{p.body.slice(0, 180)}{p.body.length > 180 ? '…' : ''}</p>}
              {p.status === 'published' && p.requires_acknowledgement && (
                p.acknowledged_at
                  ? <p className="subtle"><Check size={14} aria-hidden="true" /> You acknowledged this on {dateLabel(p.acknowledged_at)}</p>
                  : <Button disabled={busy === p.id} onClick={() => void act(`/policies/${p.id}/acknowledge`, p.id)}><FileText size={15} aria-hidden="true" />I have read and accept</Button>
              )}
              {canManage && (
                <div className="decision-actions">
                  {p.status === 'draft' && <Button variant="secondary" disabled={busy === p.id} onClick={() => void act(`/policies/${p.id}/publish`, p.id)}>Publish</Button>}
                  {p.status === 'published' && <Button variant="ghost" onClick={async () => setCompliance({ id: p.id, ...(await domainApi<{ audience: number; acknowledged: number; overdue: number; pending: Array<{ name: string; department: string | null; dueOn: string }> }>(`/policies/${p.id}/compliance`)) })}>Who has not</Button>}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {drafting && <DraftPolicy onClose={() => setDrafting(false)} onSaved={async () => { setDrafting(false); await load() }} />}
      {compliance && (
        <Modal title="Acknowledgements" onClose={() => setCompliance(null)}>
          <p><strong>{compliance.acknowledged}</strong> of {compliance.audience} have acknowledged{compliance.overdue ? `, ${compliance.overdue} overdue` : ''}.</p>
          {compliance.pending.length ? (
            <ul className="plain-list">{compliance.pending.map((x) => <li key={x.name}>{x.name}{x.department ? ` · ${x.department}` : ''} <small>due {dateLabel(x.dueOn)}</small></li>)}</ul>
          ) : <p className="subtle">Everyone is done.</p>}
        </Modal>
      )}
    </>
  )
}

function DraftPolicy({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ code: '', title: '', body: '', requiresAcknowledgement: true, dueDays: '14' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true); setError('')
    try { await domainApi('/policies', { code: form.code, title: form.title, body: form.body, requiresAcknowledgement: form.requiresAcknowledgement, dueDays: Number(form.dueDays) }); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Draft a policy" wide onClose={onClose}>
      <div className="template-form">
        <div className="two-up">
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="POSH" /></label>
          <label className="field"><span>Title</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Prevention of Sexual Harassment Policy" /></label>
        </div>
        <label className="field"><span>Body</span><textarea rows={10} value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} placeholder="## Purpose…" /></label>
        <div className="two-up">
          <label className="check"><input type="checkbox" checked={form.requiresAcknowledgement} onChange={(e) => setForm({ ...form, requiresAcknowledgement: e.target.checked })} /> Ask everyone to acknowledge</label>
          <label className="field"><span>Days to acknowledge</span><input type="number" min={1} max={365} value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} /></label>
        </div>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.code || !form.title} onClick={() => void save()}>{busy ? 'Saving…' : 'Save draft'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
        <p className="subtle">Publishing retires the previous version of this code and tells the audience; nobody is asked twice for the same version.</p>
      </div>
    </Modal>
  )
}

function Surveys({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<Survey[] | null>(null)
  const [error, setError] = useState('')
  const [answering, setAnswering] = useState<Survey | null>(null)
  const [results, setResults] = useState<{ survey: Survey; invited: number; responded: number; enps?: number | null; rows: Array<{ segment: string; question_id: string; responses: number; avg_value: string | null; distribution: Record<string, number> | null; texts: string[] | null }> } | null>(null)
  const canManage = data.permissions.includes('survey.manage')
  const load = useCallback(async () => { try { setRows((await domainApi<{ surveys: Survey[] }>('/surveys')).surveys); setError('') } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  return (
    <>
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : !rows.length ? <Card><Empty title="No surveys yet" text="A pulse survey, an eNPS round or a suggestion box. Answers on an anonymous survey cannot be read by anyone — not even HR." /></Card> : (
        <div className="template-grid">
          {rows.map((s) => (
            <Card key={s.id}>
              <div className="approval-full-head">
                <div><strong>{s.title}</strong><small>{s.kind.replace('_', ' ')}{s.closes_at ? ` · closes ${dateLabel(s.closes_at)}` : ''}</small></div>
                <span className={`badge ${s.status === 'open' ? 'green' : s.status === 'closed' ? 'coral' : 'amber'}`}><span />{s.status}</span>
              </div>
              {s.anonymous && <p className="anon-note"><ShieldCheck size={14} aria-hidden="true" /> Anonymous: answers cannot be traced to a person, and groups smaller than {s.min_group} are never shown.</p>}
              <div className="decision-actions">
                {s.status === 'open' && !s.responded && <Button onClick={() => setAnswering(s)}>Answer</Button>}
                {s.responded && <span className="subtle"><Check size={14} aria-hidden="true" /> You have answered</span>}
                {canManage && s.status !== 'draft' && <Button variant="ghost" onClick={async () => setResults({ survey: s, ...(await domainApi<{ invited: number; responded: number; enps?: number | null; rows: Array<{ segment: string; question_id: string; responses: number; avg_value: string | null; distribution: Record<string, number> | null; texts: string[] | null }> }>(`/surveys/${s.id}/results`)) })}>Results</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {answering && <AnswerSurvey survey={answering} onClose={() => setAnswering(null)} onDone={async () => { setAnswering(null); await load() }} />}
      {results && (
        <Modal title={`${results.survey.title} · results`} wide onClose={() => setResults(null)}>
          <p><strong>{results.responded}</strong> of {results.invited} answered{results.enps !== undefined && results.enps !== null ? ` · eNPS ${results.enps}` : ''}.</p>
          {!results.rows.length ? <Empty title="Nothing to show yet" text="Results appear once enough people have answered; a segment below the minimum group is withheld entirely." /> : (
            <div className="table-scroll">
              <table>
                <thead><tr><th>Segment</th><th>Question</th><th className="num">Answers</th><th className="num">Average</th><th>Comments</th></tr></thead>
                <tbody>
                  {results.rows.map((r, i) => (
                    <tr key={i}>
                      <td>{r.segment}</td>
                      <td>{results.survey.questions.find((q) => q.id === r.question_id)?.text ?? r.question_id}</td>
                      <td className="num">{r.responses}</td>
                      <td className="num">{r.avg_value ?? '—'}</td>
                      <td>{r.texts?.length ? r.texts.slice(0, 3).map((t, j) => <em key={j}>“{t}” </em>) : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Modal>
      )}
    </>
  )
}

function AnswerSurvey({ survey, onClose, onDone }: { survey: Survey; onClose: () => void; onDone: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, number | string>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function submit() {
    setBusy(true); setError('')
    try { await domainApi(`/surveys/${survey.id}/respond`, { answers }); await onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title={survey.title} onClose={onClose}>
      {survey.anonymous && <p className="anon-note"><ShieldCheck size={14} aria-hidden="true" /> Your answers cannot be traced to you. Groups smaller than {survey.min_group} are never shown.</p>}
      <div className="template-form">
        {survey.questions.map((q) => (
          <div key={q.id} className="field">
            <span>{q.text}</span>
            {q.type === 'text' ? <textarea rows={3} value={String(answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />
              : q.type === 'choice' ? <select value={String(answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}><option value="">Choose</option>{(q.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}</select>
              : (
                <div className="scale-row" role="radiogroup" aria-label={q.text}>
                  {Array.from({ length: q.type === 'nps' ? 11 : 5 }, (_, i) => (q.type === 'nps' ? i : i + 1)).map((n) => (
                    <button type="button" key={n} role="radio" aria-checked={answers[q.id] === n} className={`scale-dot ${answers[q.id] === n ? 'picked' : ''}`} onClick={() => setAnswers({ ...answers, [q.id]: n })}>{n}</button>
                  ))}
                </div>
              )}
          </div>
        ))}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy} onClick={() => void submit()}><Send size={15} aria-hidden="true" />{busy ? 'Sending…' : 'Send my answers'}</Button></div>
      </div>
    </Modal>
  )
}

function Recognition({ data }: { data: Workspace }) {
  const [badges, setBadges] = useState<Array<{ code: string; name: string; description: string | null; points: number; manager_only: boolean }>>([])
  const [feed, setFeed] = useState<Array<{ id: string; badge_code: string; badge_name: string; to_name: string; from_name: string; message: string; points: number; created_at: string }> | null>(null)
  const [leaders, setLeaders] = useState<Array<{ employeeId: string; name: string; points: number; badges: number }>>([])
  const [giving, setGiving] = useState(false)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setBadges((await domainApi<{ badges: typeof badges }>('/recognition/badges')).badges)
      setFeed((await domainApi<{ recognitions: NonNullable<typeof feed> }>('/recognition/feed')).recognitions)
      setLeaders((await domainApi<{ leaders: typeof leaders }>('/recognition/leaderboard')).leaders)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])
  return (
    <>
      <div className="row-actions">{data.user.employeeId && <Button onClick={() => setGiving(true)}><Award size={16} aria-hidden="true" />Recognise someone</Button>}</div>
      {error && <ErrorBox message={error} />}
      <div className="wall-layout">
        <div>
          {!feed ? <Skeleton /> : !feed.length ? <Card><Empty title="The wall is empty" text="Say thank you to someone; it appears here for the company to see." /></Card> : (
            <ul className="wall">
              {feed.map((r) => (
                <li key={r.id}>
                  <Avatar name={r.to_name} />
                  <div>
                    <p><strong>{r.from_name}</strong> recognised <strong>{r.to_name}</strong> · <span className="badge green"><span />{r.badge_name}{r.points ? ` +${r.points}` : ''}</span></p>
                    <blockquote>{r.message}</blockquote>
                    <small>{dateLabel(r.created_at)}</small>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <aside>
          <Card title="This quarter" subtitle="Most recognised">
            {leaders.length ? <ol className="leaderboard">{leaders.map((l) => <li key={l.employeeId}><span>{l.name}</span><strong>{l.points}</strong></li>)}</ol> : <p className="subtle">Nobody yet.</p>}
          </Card>
        </aside>
      </div>
      {giving && <GiveRecognition badges={badges} data={data} onClose={() => setGiving(false)} onDone={async () => { setGiving(false); await load() }} />}
    </>
  )
}

function GiveRecognition({ badges, data, onClose, onDone }: { badges: Array<{ code: string; name: string; description: string | null; points: number; manager_only: boolean }>; data: Workspace; onClose: () => void; onDone: () => Promise<void> }) {
  const [badgeCode, setBadgeCode] = useState(badges[0]?.code ?? '')
  const [toEmployeeId, setTo] = useState('')
  const [message, setMessage] = useState('')
  const [visibility, setVisibility] = useState('company')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const isManager = data.user.scope !== 'self'
  const people = useMemo(() => data.employees.filter((e) => e.status !== 'exited' && e.id !== data.user.employeeId), [data.employees, data.user.employeeId])
  async function give() {
    setBusy(true); setError('')
    try { await domainApi('/recognition', { badgeCode, toEmployeeId, message, visibility }); await onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Recognise someone" onClose={onClose}>
      <div className="template-form">
        <div className="badge-picker" role="radiogroup" aria-label="Badge">
          {badges.map((b) => {
            const locked = b.manager_only && !isManager
            return (
              <button type="button" key={b.code} role="radio" aria-checked={badgeCode === b.code} disabled={locked} title={locked ? 'Only a manager can give this badge' : b.description ?? undefined}
                className={`badge-option ${badgeCode === b.code ? 'picked' : ''}`} onClick={() => setBadgeCode(b.code)}>
                <Gift size={16} aria-hidden="true" />
                <strong>{b.name}</strong>
                <small>{b.points ? `+${b.points} points` : 'no points'}{locked ? ' · managers only' : ''}</small>
              </button>
            )
          })}
        </div>
        <label className="field"><span>Who</span><select value={toEmployeeId} onChange={(e) => setTo(e.target.value)}><option value="">Choose a colleague</option>{people.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}</select></label>
        <label className="field"><span>What they did</span><textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Stayed late to get the dispatch out" /></label>
        <label className="field"><span>Who sees it</span><select value={visibility} onChange={(e) => setVisibility(e.target.value)}><option value="company">Everyone</option><option value="team">Their team</option><option value="private">Just them</option></select></label>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !toEmployeeId || message.trim().length < 5} onClick={() => void give()}><PartyPopper size={15} aria-hidden="true" />{busy ? 'Sending…' : 'Send recognition'}</Button></div>
      </div>
    </Modal>
  )
}

function Celebrations({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<Celebration[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const to = new Date(Date.parse(data.today) + 30 * 86_400_000).toISOString().slice(0, 10)
    domainApi<{ celebrations: Celebration[] }>(`/celebrations?from=${data.today}&to=${to}`).then((r) => setRows(r.celebrations)).catch((e: Error) => setError(e.message))
  }, [data.today])
  if (error) return <ErrorBox message={error} />
  if (!rows) return <Skeleton />
  if (!rows.length) return <Card><Empty title="Nothing in the next month" text="Birthdays and work anniversaries appear here — people who opted out are never listed." /></Card>
  return (
    <div className="template-grid">
      {rows.map((c) => (
        <Card key={`${c.employeeId}-${c.kind}-${c.on}`} className="celebration">
          {c.kind === 'birthday' ? <Cake size={20} aria-hidden="true" /> : <PartyPopper size={20} aria-hidden="true" />}
          <div>
            <strong>{c.name}</strong>
            <p>{c.kind === 'birthday' ? 'Birthday' : `${c.years} year${c.years === 1 ? '' : 's'} with the company`} · {dateLabel(c.on)}</p>
          </div>
        </Card>
      ))}
    </div>
  )
}
