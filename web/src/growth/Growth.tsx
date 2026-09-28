/**
 * Growth: learning with mandatory-training compliance, 360° feedback whose
 * small groups stay withheld, and promotion / increment recommendations that
 * go through approval and land as real effective-dated changes.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { BookOpen, CircleCheck, GraduationCap, Plus, Send, TrendingUp, Users } from 'lucide-react'
import { domainApi } from '../domainApi'
import { fullName, money, dateLabel, errorCode } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, PageHeader, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

interface Course { id: string; code: string; title: string; description: string | null; mode: string; link: string | null; mandatory: boolean; validity_months: number | null; due_days: number; status: string }
interface Nomination { id: string; course_code: string; course_title: string; employee_id: string; employee_name: string; due_on: string; status: string; score: number | null; valid_until: string | null }
interface ComplianceRow { course: string; title: string; audience: number; completed: number; open: number; overdue: number; expiring: number; overdueNames: string[] }
interface Round { id: string; subject_employee_id: string; subject_name: string; title: string; due_on: string; status: string; min_group: number }
interface Recommendation { id: string; employee_id: string; employee_name: string; kind: string; new_designation: string | null; new_annual_ctc_paise: string | null; increment_pct: string | null; effective_from: string; justification: string; status: string }

export function GrowthPage({ data, screen = 'learning' }: { data: Workspace; screen?: string }) {
  const VIEWS: Array<[string, string, boolean]> = [
    ['learning', 'Learning', Boolean(data.modules.learning)],
    ['feedback', '360° feedback', data.permissions.includes('performance.review') || Boolean(data.user.employeeId)],
    ['recommendations', 'Recommendations', data.permissions.includes('performance.review')],
  ]
  const shown = VIEWS.filter((v) => v[2])
  const HEAD: Record<string, [string, string]> = {
    learning: ['Learning', 'Courses, certifications and what the law says everyone must have done.'],
    feedback: ['360° feedback', 'What colleagues say, gathered so that no single answer can be traced back.'],
    recommendations: ['Recommendations', 'Promotions and increments, approved once and applied on the date.'],
  }
  const [title, description] = HEAD[screen] ?? HEAD.learning!
  const tabs = <Tabs value={shown.find((v) => v[0] === screen)?.[1] ?? shown[0]?.[1] ?? ''} items={shown.map((v) => v[1])}
    onChange={(label) => { const v = shown.find((x) => x[1] === label); window.location.hash = `#/growth${v && v[0] !== 'learning' ? `/${v[0]}` : ''}` }} />
  return (
    <>
      <PageHeader title={title} description={description} eyebrow={`Growth · ${title}`} />
      {tabs}
      {screen === 'feedback' ? <Feedback data={data} /> : screen === 'recommendations' ? <Recommendations data={data} /> : <Learning data={data} />}
    </>
  )
}

function Learning({ data }: { data: Workspace }) {
  const [tab, setTab] = useState(data.permissions.includes('learning.manage') ? 'Compliance' : 'My learning')
  const [courses, setCourses] = useState<Course[]>([])
  const [mine, setMine] = useState<{ nominations: Nomination[]; points: { balance: number; earned: number; redeemed: number } } | null>(null)
  const [compliance, setCompliance] = useState<ComplianceRow[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  // The API code behind `error`, so a plan-gated module reads as an offer.
  const [code, setCode] = useState<string | undefined>()
  const [busy, setBusy] = useState('')
  const canManage = data.permissions.includes('learning.manage')
  const load = useCallback(async () => {
    try {
      setCourses((await domainApi<{ courses: Course[] }>('/learning/courses')).courses)
      if (data.user.employeeId) setMine(await domainApi('/me/learning'))
      if (canManage) setCompliance((await domainApi<{ courses: ComplianceRow[] }>('/learning/compliance')).courses)
      setError('')
    } catch (e) { setError((e as Error).message); setCode(errorCode(e)) }
  }, [canManage, data.user.employeeId])
  useEffect(() => { void load() }, [load])
  async function act(path: string, id: string, body: unknown = {}) { setBusy(id); try { await domainApi(path, body); await load() } catch (e) { setError((e as Error).message); setCode(errorCode(e)) } finally { setBusy('') } }
  const tabs = [...(canManage ? ['Compliance', 'Catalogue'] : ['Catalogue']), ...(data.user.employeeId ? ['My learning'] : [])]
  return (
    <>
      <Tabs value={tabs.includes(tab) ? tab : tabs[0]!} onChange={setTab} items={tabs} />
      {error && <ErrorBox message={error} code={code} />}
      {tab === 'Compliance' && (
        !compliance ? <Skeleton /> : !compliance.length ? <Card><Empty title="No mandatory courses" text="Mark a course mandatory and everyone it applies to — including new joiners — is nominated automatically." /></Card> : (
          <div className="template-grid">
            {compliance.map((c) => {
              const done = c.audience ? Math.round(c.completed / c.audience * 100) : 0
              return (
                <Card key={c.course}>
                  <div className="approval-full-head"><strong>{c.title}</strong><span className={`badge ${c.overdue ? 'coral' : done === 100 ? 'green' : 'amber'}`}><span />{done}% done</span></div>
                  <div className="stack-bar" role="img" aria-label={`${c.completed} completed, ${c.open} open, ${c.overdue} overdue of ${c.audience}`}>
                    <i className="done" style={{ width: `${c.audience ? c.completed / c.audience * 100 : 0}%` }} />
                    <i className="open" style={{ width: `${c.audience ? c.open / c.audience * 100 : 0}%` }} />
                    <i className="over" style={{ width: `${c.audience ? c.overdue / c.audience * 100 : 0}%` }} />
                  </div>
                  <p className="subtle">{c.completed} completed · {c.open} still to do · {c.overdue} overdue{c.expiring ? ` · ${c.expiring} lapsing within 60 days` : ''}</p>
                  {c.overdueNames.length > 0 && <details><summary>Who is overdue</summary><ul className="plain-list">{c.overdueNames.map((n) => <li key={n}>{n}</li>)}</ul></details>}
                </Card>
              )
            })}
          </div>
        )
      )}
      {tab === 'Catalogue' && (
        <>
          {canManage && <div className="row-actions"><Button onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" />Add a course</Button><Button variant="secondary" onClick={() => void act('/learning/nominate-mandatory', 'sweep')}>Nominate everyone due</Button></div>}
          {!courses.length ? <Card><Empty title="No courses yet" text="POSH awareness, safety induction, a product refresher — add one and nominate people, or make it mandatory and let the nightly sweep do it." /></Card> : (
            <div className="template-grid">
              {courses.map((c) => (
                <Card key={c.id}>
                  <div className="approval-full-head"><strong>{c.title}</strong>{c.mandatory && <span className="badge amber"><span />mandatory</span>}</div>
                  <p className="subtle">{c.code} · {c.mode.replace('_', ' ')}{c.validity_months ? ` · valid ${c.validity_months} months` : ''}</p>
                  {c.description && <p className="template-excerpt">{c.description}</p>}
                  {c.link && <a className="btn ghost" href={c.link} target="_blank" rel="noreferrer"><BookOpen size={15} aria-hidden="true" />Open course</a>}
                </Card>
              ))}
            </div>
          )}
        </>
      )}
      {tab === 'My learning' && (
        !mine ? <Skeleton /> : (
          <>
            <div className="stats-row">
              <div className="stat"><small>To do</small><strong>{mine.nominations.filter((n) => n.status === 'assigned' || n.status === 'in_progress').length}</strong></div>
              <div className="stat"><small>Completed</small><strong>{mine.nominations.filter((n) => n.status === 'completed').length}</strong></div>
              <div className="stat"><small>Recognition points</small><strong>{mine.points.balance}</strong><span className="subtle">{mine.points.earned} earned</span></div>
            </div>
            {!mine.nominations.length ? <Card><Empty title="Nothing assigned" text="Courses you are nominated for appear here with their due date." /></Card> : (
              <div className="template-grid">
                {mine.nominations.map((n) => (
                  <Card key={n.id}>
                    <div className="approval-full-head"><strong>{n.course_title}</strong><span className={`badge ${n.status === 'completed' ? 'green' : n.due_on < data.today ? 'coral' : 'amber'}`}><span />{n.status.replace('_', ' ')}</span></div>
                    <p className="subtle">Due {dateLabel(n.due_on)}{n.valid_until ? ` · valid to ${dateLabel(n.valid_until)}` : ''}{n.score !== null ? ` · scored ${n.score}` : ''}</p>
                    <div className="decision-actions">
                      {n.status === 'assigned' && <Button variant="secondary" disabled={busy === n.id} onClick={() => void act(`/learning/nominations/${n.id}/start`, n.id)}>Start</Button>}
                      {(n.status === 'assigned' || n.status === 'in_progress') && <Button disabled={busy === n.id} onClick={() => void act(`/learning/nominations/${n.id}/complete`, n.id, { passed: true })}><CircleCheck size={15} aria-hidden="true" />Mark complete</Button>}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </>
        )
      )}
      {adding && <CourseModal onClose={() => setAdding(false)} onSaved={async () => { setAdding(false); await load() }} />}
    </>
  )
}

function CourseModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => Promise<void> }) {
  const [form, setForm] = useState({ code: '', title: '', description: '', mode: 'online', link: '', mandatory: false, validityMonths: '', dueDays: '30' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function save() {
    setBusy(true); setError('')
    try { await domainApi('/learning/courses', { code: form.code, title: form.title, description: form.description || undefined, mode: form.mode, link: form.link || undefined, mandatory: form.mandatory, validityMonths: form.validityMonths ? Number(form.validityMonths) : undefined, dueDays: Number(form.dueDays) }); await onSaved() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Add a course" onClose={onClose}>
      <div className="template-form">
        <div className="two-up">
          <label className="field"><span>Code</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="POSH_AWARENESS" /></label>
          <label className="field"><span>Title</span><input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></label>
        </div>
        <label className="field"><span>What it covers</span><textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <div className="two-up">
          <label className="field"><span>Mode</span><select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>{['online', 'classroom', 'external', 'self_paced'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</select></label>
          <label className="field"><span>Link</span><input value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} placeholder="https://" /></label>
        </div>
        <div className="two-up">
          <label className="field"><span>Valid for (months, blank = never expires)</span><input type="number" min={1} max={120} value={form.validityMonths} onChange={(e) => setForm({ ...form, validityMonths: e.target.value })} /></label>
          <label className="field"><span>Days to complete</span><input type="number" min={1} max={365} value={form.dueDays} onChange={(e) => setForm({ ...form, dueDays: e.target.value })} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={form.mandatory} onChange={(e) => setForm({ ...form, mandatory: e.target.checked })} /> Mandatory — nominate the whole audience, including new joiners</label>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.code || !form.title} onClick={() => void save()}>{busy ? 'Saving…' : 'Add course'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function Feedback({ data }: { data: Workspace }) {
  const [rounds, setRounds] = useState<Round[] | null>(null)
  const [requests, setRequests] = useState<Array<{ id: string; subject_name: string; title: string; relationship: string; due_on: string; questions: Array<{ id: string; text: string; type: 'rating' | 'text'; scale?: number }> }>>([])
  const [answering, setAnswering] = useState<(typeof requests)[number] | null>(null)
  const [results, setResults] = useState<{ round: Round; byRelationship: Array<{ relationship: string; asked: number; answered: number; question_id: string | null; avg_value: number | null; texts: string[] | null; withheld: boolean }>; overall: Array<{ question_id: string; avg: number | null; n: number }> } | null>(null)
  const [opening, setOpening] = useState(false)
  const [error, setError] = useState('')
  const canReview = data.permissions.includes('performance.review')
  const load = useCallback(async () => {
    try {
      if (canReview) setRounds((await domainApi<{ rounds: Round[] }>('/feedback/rounds')).rounds); else setRounds([])
      if (data.user.employeeId) setRequests((await domainApi<{ requests: typeof requests }>('/me/feedback-requests?status=requested')).requests)
      setError('')
    } catch (e) { setError((e as Error).message) }
  }, [canReview, data.user.employeeId])
  useEffect(() => { void load() }, [load])
  return (
    <>
      {error && <ErrorBox message={error} />}
      {requests.length > 0 && (
        <Card title={`${requests.length} colleague${requests.length === 1 ? '' : 's'} asked for your feedback`} subtitle="Your answers are confidential; they see group averages, never who said what.">
          <ul className="plain-list">
            {requests.map((r) => (
              <li key={r.id}>
                <Users size={14} aria-hidden="true" /> {r.subject_name} · as {r.relationship} · due {dateLabel(r.due_on)}
                <Button variant="secondary" onClick={() => setAnswering(r)}>Answer</Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {canReview && <div className="row-actions"><Button onClick={() => setOpening(true)}><Plus size={16} aria-hidden="true" />Open a 360° round</Button></div>}
      {!rounds ? <Skeleton /> : !rounds.length ? (
        <Card><Empty title="No rounds open" text="A 360° round asks a person’s manager, peers and reports the same short set of questions, and shows the answers only as group averages." /></Card>
      ) : (
        <div className="template-grid">
          {rounds.map((r) => (
            <Card key={r.id}>
              <div className="approval-full-head"><strong>{r.subject_name}</strong><span className={`badge ${r.status === 'open' ? 'amber' : 'green'}`}><span />{r.status}</span></div>
              <p className="subtle">{r.title} · due {dateLabel(r.due_on)} · groups under {r.min_group} are withheld</p>
              <div className="decision-actions">
                <Button variant="secondary" onClick={async () => setResults(await domainApi(`/feedback/rounds/${r.id}`))}>Results</Button>
                {r.status === 'open' && <Button variant="ghost" onClick={async () => { await domainApi(`/feedback/rounds/${r.id}/close`, {}); await load() }}>Close round</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {answering && <AnswerFeedback request={answering} onClose={() => setAnswering(null)} onDone={async () => { setAnswering(null); await load() }} />}
      {results && (
        <Modal title={`${results.round.subject_name} · 360° results`} wide onClose={() => setResults(null)}>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Relationship</th><th>Question</th><th className="num">Asked</th><th className="num">Answered</th><th className="num">Average</th><th>Comments</th></tr></thead>
              <tbody>
                {results.byRelationship.map((r, i) => (
                  <tr key={i}>
                    <td>{r.relationship}</td>
                    <td>{r.question_id ?? '—'}</td>
                    <td className="num">{r.asked}</td>
                    <td className="num">{r.answered}</td>
                    <td className="num">{r.withheld ? <span className="subtle">withheld</span> : r.avg_value ?? '—'}</td>
                    <td>{r.texts?.slice(0, 2).map((t, j) => <em key={j}>“{t}” </em>) ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="subtle">A group smaller than the minimum shows nothing at all — not an average, not a count of answers.</p>
        </Modal>
      )}
      {opening && <OpenRound data={data} onClose={() => setOpening(false)} onDone={async () => { setOpening(false); await load() }} />}
    </>
  )
}

function AnswerFeedback({ request, onClose, onDone }: { request: { id: string; subject_name: string; questions: Array<{ id: string; text: string; type: 'rating' | 'text'; scale?: number }> }; onClose: () => void; onDone: () => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, number | string>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  async function send(decline = false) {
    setBusy(true); setError('')
    try { await domainApi(`/me/feedback-requests/${request.id}`, decline ? { decline: true } : { answers }); await onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title={`Feedback on ${request.subject_name}`} onClose={onClose}>
      <p className="anon-note">Your answers are confidential. They are shown only as group averages, and a group smaller than the minimum is withheld entirely.</p>
      <div className="template-form">
        {request.questions.map((q) => (
          <div key={q.id} className="field">
            <span>{q.text}</span>
            {q.type === 'rating' ? (
              <div className="scale-row" role="radiogroup" aria-label={q.text}>
                {Array.from({ length: q.scale ?? 5 }, (_, i) => i + 1).map((n) => (
                  <button type="button" key={n} role="radio" aria-checked={answers[q.id] === n} className={`scale-dot ${answers[q.id] === n ? 'picked' : ''}`} onClick={() => setAnswers({ ...answers, [q.id]: n })}>{n}</button>
                ))}
              </div>
            ) : <textarea rows={2} value={String(answers[q.id] ?? '')} onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })} />}
          </div>
        ))}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy} onClick={() => void send()}><Send size={15} aria-hidden="true" />Send</Button><Button variant="ghost" disabled={busy} onClick={() => void send(true)}>I would rather not</Button></div>
      </div>
    </Modal>
  )
}

function OpenRound({ data, onClose, onDone }: { data: Workspace; onClose: () => void; onDone: () => Promise<void> }) {
  const [subject, setSubject] = useState('')
  const [dueOn, setDueOn] = useState(new Date(Date.parse(data.today) + 14 * 86_400_000).toISOString().slice(0, 10))
  const [raters, setRaters] = useState<Record<string, string>>({})
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const people = useMemo(() => data.employees.filter((e) => e.status !== 'exited'), [data.employees])
  async function open() {
    setBusy(true); setError('')
    try {
      await domainApi('/feedback/rounds', { subjectEmployeeId: subject, dueOn, raters: Object.entries(raters).filter(([, rel]) => rel).map(([employeeId, relationship]) => ({ employeeId, relationship })) })
      await onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const chosen = Object.values(raters).filter(Boolean).length
  return (
    <Modal title="Open a 360° round" wide onClose={onClose}>
      <div className="template-form">
        <div className="two-up">
          <label className="field"><span>About whom</span><select value={subject} onChange={(e) => { setSubject(e.target.value); setRaters({}) }}><option value="">Choose a person</option>{people.map((p) => <option key={p.id} value={p.id}>{fullName(p)}</option>)}</select></label>
          <label className="field"><span>Answers due by</span><input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} /></label>
        </div>
        {subject && (
          <>
            <p className="subtle">Who should be asked, and how they know them. {chosen} chosen.</p>
            <div className="table-scroll" style={{ maxHeight: 280 }}>
              <table>
                <thead><tr><th>Person</th><th>Relationship</th></tr></thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id}>
                      <td>{fullName(p)}{p.id === subject ? ' (the subject)' : ''}</td>
                      <td>
                        <select value={raters[p.id] ?? ''} aria-label={`Relationship of ${fullName(p)}`} onChange={(e) => setRaters({ ...raters, [p.id]: e.target.value })}>
                          <option value="">Not asked</option>
                          {p.id === subject ? <option value="self">Self</option> : <><option value="manager">Manager</option><option value="peer">Peer</option><option value="report">Report</option><option value="stakeholder">Stakeholder</option></>}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !subject || !chosen} onClick={() => void open()}>{busy ? 'Opening…' : `Ask ${chosen} people`}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function Recommendations({ data }: { data: Workspace }) {
  const [rows, setRows] = useState<Recommendation[] | null>(null)
  const [raising, setRaising] = useState(false)
  const [error, setError] = useState('')
  const canSeeMoney = data.permissions.includes('compensation.read')
  const load = useCallback(async () => { try { setRows((await domainApi<{ recommendations: Recommendation[] }>('/recommendations')).recommendations); setError('') } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  return (
    <>
      <div className="row-actions"><Button onClick={() => setRaising(true)}><TrendingUp size={16} aria-hidden="true" />Recommend someone</Button></div>
      {error && <ErrorBox message={error} />}
      {!rows ? <Skeleton /> : !rows.length ? (
        <Card><Empty title="No recommendations" text="A promotion or increment raised here goes through approval and is applied on its effective date — the designation and the compensation change together, citing the appraisal." /></Card>
      ) : (
        <Card className="data-card">
          <div className="table-scroll">
            <table>
              <thead><tr><th>Person</th><th>What</th><th className="num">Increase</th><th>Effective</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.employee_name}</strong></td>
                    <td>{r.new_designation ?? '—'}<br /><small>{r.kind}</small></td>
                    <td className="num">{r.increment_pct ? `${Number(r.increment_pct)}%` : '—'}{canSeeMoney && r.new_annual_ctc_paise ? <><br /><small>to {money(r.new_annual_ctc_paise)}</small></> : null}</td>
                    <td>{dateLabel(r.effective_from)}</td>
                    <td><span className={`badge ${r.status === 'applied' ? 'green' : r.status === 'rejected' ? 'coral' : 'amber'}`}><span />{r.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {raising && <RaiseRecommendation data={data} onClose={() => setRaising(false)} onDone={async () => { setRaising(false); await load() }} />}
    </>
  )
}

function RaiseRecommendation({ data, onClose, onDone }: { data: Workspace; onClose: () => void; onDone: () => Promise<void> }) {
  const [form, setForm] = useState({ employeeId: '', newDesignation: '', incrementPct: '', newCtc: '', effectiveFrom: `${Number(data.today.slice(0, 4)) + (Number(data.today.slice(5, 7)) >= 4 ? 1 : 0)}-04-01`, justification: '' })
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const canSeeMoney = data.permissions.includes('compensation.read')
  const people = useMemo(() => data.employees.filter((e) => e.status !== 'exited' && e.id !== data.user.employeeId), [data.employees, data.user.employeeId])
  async function save() {
    setBusy(true); setError('')
    try {
      await domainApi('/recommendations', {
        employeeId: form.employeeId, newDesignation: form.newDesignation || undefined,
        incrementPct: form.incrementPct ? Number(form.incrementPct) : undefined,
        newAnnualCtcPaise: canSeeMoney && form.newCtc ? Math.round(Number(form.newCtc) * 100) : undefined,
        effectiveFrom: form.effectiveFrom, justification: form.justification,
      })
      await onDone()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  return (
    <Modal title="Recommend a promotion or increment" onClose={onClose}>
      <div className="template-form">
        <label className="field"><span>Who</span><select value={form.employeeId} onChange={(e) => setForm({ ...form, employeeId: e.target.value })}><option value="">Choose</option>{people.map((p) => <option key={p.id} value={p.id}>{fullName(p)} · {p.designation ?? ''}</option>)}</select></label>
        <div className="two-up">
          <label className="field"><span>New designation (optional)</span><input value={form.newDesignation} onChange={(e) => setForm({ ...form, newDesignation: e.target.value })} placeholder="Senior Engineer" /></label>
          <label className="field"><span>Increment (%)</span><input type="number" min={0} max={500} step={0.5} value={form.incrementPct} onChange={(e) => setForm({ ...form, incrementPct: e.target.value })} /></label>
        </div>
        {canSeeMoney && <label className="field"><span>Or a new annual CTC (₹)</span><input type="number" min={0} value={form.newCtc} onChange={(e) => setForm({ ...form, newCtc: e.target.value })} /></label>}
        <label className="field"><span>Effective from</span><input type="date" value={form.effectiveFrom} onChange={(e) => setForm({ ...form, effectiveFrom: e.target.value })} /></label>
        <label className="field"><span>Why (at least a sentence)</span><textarea rows={3} value={form.justification} onChange={(e) => setForm({ ...form, justification: e.target.value })} placeholder="Exceeded on every goal this cycle; led the Q3 release." /></label>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !form.employeeId || form.justification.trim().length < 10} onClick={() => void save()}><GraduationCap size={15} aria-hidden="true" />{busy ? 'Raising…' : 'Send for approval'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
        <p className="subtle">On approval this becomes an effective-dated assignment change and a compensation revision — the two writes HR would have made by hand.</p>
      </div>
    </Modal>
  )
}
