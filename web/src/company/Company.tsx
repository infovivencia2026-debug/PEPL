/**
 * Company: the platform-level screens an org admin owns — the group console
 * (aggregates only, by consent), the reseller book, the sandbox, this
 * company's security posture, network benchmarks and what the assistant
 * could not answer.
 */
import { useCallback, useEffect, useState } from 'react'
import { Building2, CircleCheck, CircleHelp, Gauge, ShieldCheck, TriangleAlert, Users } from 'lucide-react'
import { domainApi } from '../domainApi'
import { money, dateLabel } from '../api'
import { Button, Card, Empty, ErrorBox, Modal, PageHeader, Skeleton, Tabs } from '../ui'
import type { Workspace } from '../types'

export function CompanyPage({ data, screen = 'security' }: { data: Workspace; screen?: string }) {
  const VIEWS: Array<[string, string, boolean]> = [
    ['security', 'Security posture', data.permissions.includes('settings.write')],
    ['group', 'Group', data.permissions.includes('group.manage')],
    ['sandbox', 'Sandbox', data.permissions.includes('settings.write')],
    ['benchmarks', 'Benchmarks', data.permissions.includes('report.read') && data.user.scope === 'all'],
    ['assistant', 'Assistant gaps', data.permissions.includes('settings.write')],
  ]
  const shown = VIEWS.filter((v) => v[2])
  const HEAD: Record<string, [string, string]> = {
    security: ['Security posture', 'Who holds the keys, whether the chain verifies, and what to tighten.'],
    group: ['Group & reseller', 'Companies under this one — totals only, by their consent.'],
    sandbox: ['Sandbox', 'A throwaway twin of this company, full of sample data, that never sends anything.'],
    benchmarks: ['Benchmarks', 'How this company compares with others of its type and size.'],
    assistant: ['Assistant gaps', 'Questions people asked that the assistant could not answer.'],
  }
  const [title, description] = HEAD[screen] ?? HEAD.security!
  const tabs = <Tabs value={shown.find((v) => v[0] === screen)?.[1] ?? shown[0]?.[1] ?? ''} items={shown.map((v) => v[1])}
    onChange={(label) => { const v = shown.find((x) => x[1] === label); window.location.hash = `#/company${v && v[0] !== 'security' ? `/${v[0]}` : ''}` }} />
  return (
    <>
      <PageHeader title={title} description={description} eyebrow={`Company · ${title}`} />
      {tabs}
      {screen === 'group' ? <GroupConsole data={data} /> : screen === 'sandbox' ? <Sandbox /> : screen === 'benchmarks' ? <Benchmarks /> : screen === 'assistant' ? <Gaps /> : <Posture />}
    </>
  )
}

interface PostureData {
  score: number; advice: string[]
  mfa: { admins: number; adminsWithMfa: number; users: number; usersWithMfa: number; requiredForAdmins: boolean }
  admins: Array<{ name: string; email: string; roles: string[]; mfa: boolean; lastLoginAt: string | null }>
  apiKeys: { live: number; expiringIn30Days: number }
  webhooks: { active: number; failingLast7Days: number }
  audit: { chainOk: boolean; eventsChecked: number; lastSealedDate: string | null }
  retention: { erasureAfterDays: number | null; chatHistoryDays: number | null }
  anomalies: { openBlocking: number; openWarnings: number }
  sessions: { active: number }
}

function Posture() {
  const [p, setP] = useState<PostureData | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { domainApi<PostureData>('/security-posture').then(setP).catch((e: Error) => setError(e.message)) }, [])
  if (error) return <ErrorBox message={error} />
  if (!p) return <Skeleton />
  const ring = Math.max(0, Math.min(100, p.score))
  return (
    <>
      <div className="posture-top">
        <Card className="score-card">
          <div className="score-ring" style={{ ['--pct' as string]: `${ring}` }} role="img" aria-label={`Security score ${p.score} out of 100`}>
            <strong>{p.score}</strong><small>/ 100</small>
          </div>
          <div>
            <h3>{p.score >= 90 ? 'Tight' : p.score >= 70 ? 'Reasonable' : 'Needs attention'}</h3>
            <p className="subtle">{p.advice.length ? `${p.advice.length} thing${p.advice.length === 1 ? '' : 's'} to fix` : 'Nothing outstanding.'}</p>
          </div>
        </Card>
        <Card title="What to do next" subtitle="Each one moves the score.">
          {p.advice.length ? (
            <ul className="plain-list">{p.advice.map((a) => <li key={a}><TriangleAlert size={14} aria-hidden="true" /> {a}</li>)}</ul>
          ) : <p className="subtle"><CircleCheck size={14} aria-hidden="true" /> Nothing outstanding.</p>}
        </Card>
      </div>
      <div className="stats-row">
        <div className="stat"><small>Admins with 2FA</small><strong>{p.mfa.adminsWithMfa}/{p.mfa.admins}</strong><span className="subtle">{p.mfa.requiredForAdmins ? 'required' : 'not required'}</span></div>
        <div className="stat"><small>Everyone with 2FA</small><strong>{p.mfa.usersWithMfa}/{p.mfa.users}</strong></div>
        <div className="stat"><small>Live API keys</small><strong>{p.apiKeys.live}</strong><span className="subtle">{p.apiKeys.expiringIn30Days} expiring</span></div>
        <div className="stat"><small>Active sessions</small><strong>{p.sessions.active}</strong></div>
      </div>
      <Card title="Administrators" subtitle="The people who can change everything.">
        <div className="table-scroll">
          <table>
            <thead><tr><th>Name</th><th>Roles</th><th>2FA</th><th>Last sign-in</th></tr></thead>
            <tbody>
              {p.admins.map((a) => (
                <tr key={a.email}>
                  <td><strong>{a.name}</strong><br /><small>{a.email}</small></td>
                  <td>{a.roles.join(', ')}</td>
                  <td><span className={`badge ${a.mfa ? 'green' : 'coral'}`}><span />{a.mfa ? 'on' : 'off'}</span></td>
                  <td>{a.lastLoginAt ? dateLabel(a.lastLoginAt) : 'never'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      <div className="two-column">
        <Card title="Audit chain" subtitle="Every event hashes the one before it.">
          <p className={`balance-pill ${p.audit.chainOk ? 'ok' : 'bad'}`}>{p.audit.chainOk ? <ShieldCheck size={15} aria-hidden="true" /> : <TriangleAlert size={15} aria-hidden="true" />}{p.audit.chainOk ? `Verified across ${p.audit.eventsChecked} events` : 'The chain does not verify'}</p>
          <p className="subtle">Last sealed {p.audit.lastSealedDate ? dateLabel(p.audit.lastSealedDate) : 'never'}.</p>
        </Card>
        <Card title="Retention" subtitle="How long things are kept.">
          <dl className="diff">
            <div><dt>Erasure after</dt><dd>{p.retention.erasureAfterDays ? `${p.retention.erasureAfterDays} days` : '—'}</dd></div>
            <div><dt>Chat history</dt><dd>{p.retention.chatHistoryDays ? `${p.retention.chatHistoryDays} days` : 'kept'}</dd></div>
            <div><dt>Open findings</dt><dd>{p.anomalies.openBlocking} blocking · {p.anomalies.openWarnings} warnings</dd></div>
            <div><dt>Webhooks</dt><dd>{p.webhooks.active} active{p.webhooks.failingLast7Days ? ` · ${p.webhooks.failingLast7Days} failing` : ''}</dd></div>
          </dl>
        </Card>
      </div>
    </>
  )
}

interface Group { id: string; name: string; kind: string; owner_tenant_id: string; members: number }
interface Snapshot { tenantId: string; name: string; headcount: number; joinersThisMonth: number; exitsThisMonth: number; presentToday: number; onLeaveToday: number; lastLockedPayroll: { period: string; netPaise: number; employees: number } | null; openApprovals: number; openTickets: number; complianceScore: number | null }

function GroupConsole({ data }: { data: Workspace }) {
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [memberships, setMemberships] = useState<Array<{ group_id: string; name: string; kind: string; owner_name: string; status: string }>>([])
  const [overview, setOverview] = useState<{ group: Group; companies: Snapshot[]; totals: { headcount: number; presentToday: number; netPayrollPaise: number; openApprovals: number } } | null>(null)
  const [error, setError] = useState('')
  const [creating, setCreating] = useState(false)
  const load = useCallback(async () => {
    try { const r = await domainApi<{ groups: Group[]; memberships: typeof memberships }>('/groups'); setGroups(r.groups); setMemberships(r.memberships); setError('') } catch (e) { setError((e as Error).message) }
  }, [])
  useEffect(() => { void load() }, [load])
  async function open(g: Group) {
    try { setOverview(await domainApi(`/groups/${g.id}/overview`)) } catch (e) { setError((e as Error).message) }
  }
  return (
    <>
      {error && <ErrorBox message={error} />}
      {memberships.length > 0 && (
        <Card title="Invitations and memberships" subtitle="Another company has asked to see this one’s totals.">
          <ul className="plain-list">
            {memberships.map((m) => (
              <li key={m.group_id}>
                <Building2 size={14} aria-hidden="true" /> <strong>{m.name}</strong> by {m.owner_name} · {m.status}
                {m.status === 'invited'
                  ? <><Button variant="secondary" onClick={async () => { await domainApi(`/groups/${m.group_id}/accept`, {}); await load() }}>Accept</Button></>
                  : <Button variant="ghost" onClick={async () => { await domainApi(`/groups/${m.group_id}/leave`, {}); await load() }}>Leave</Button>}
              </li>
            ))}
          </ul>
          <p className="subtle">Accepting shows the owner totals only — headcount, attendance today, last payroll total, open approvals — never a record. Every view is recorded in your audit log.</p>
        </Card>
      )}
      <div className="row-actions"><Button onClick={() => setCreating(true)}><Users size={16} aria-hidden="true" />Create a group</Button></div>
      {!groups ? <Skeleton /> : !groups.length ? (
        <Card><Empty title="No group yet" text="A group lets a holding company see its subsidiaries’ totals in one place. Each company accepts first; nothing is visible before that." /></Card>
      ) : (
        <div className="template-grid">
          {groups.map((g) => (
            <Card key={g.id}>
              <div className="approval-full-head"><strong>{g.name}</strong><span className="badge green"><span />{g.kind}</span></div>
              <p className="subtle">{g.members} member{g.members === 1 ? '' : 's'}</p>
              <div className="decision-actions">
                {g.kind === 'group' ? <Button variant="secondary" onClick={() => void open(g)}>Open console</Button> : <Button variant="secondary" onClick={async () => setOverview({ group: g, companies: [], totals: { headcount: 0, presentToday: 0, netPayrollPaise: 0, openApprovals: 0 } })}>Reseller book</Button>}
              </div>
            </Card>
          ))}
        </div>
      )}
      {overview && (
        <Modal title={overview.group.name} wide onClose={() => setOverview(null)}>
          {overview.companies.length ? (
            <>
              <div className="stats-row">
                <div className="stat"><small>People</small><strong>{overview.totals.headcount}</strong></div>
                <div className="stat"><small>In today</small><strong>{overview.totals.presentToday}</strong></div>
                <div className="stat"><small>Last payroll</small><strong>{money(overview.totals.netPayrollPaise)}</strong></div>
                <div className="stat"><small>Open approvals</small><strong>{overview.totals.openApprovals}</strong></div>
              </div>
              <div className="template-grid">
                {overview.companies.map((c) => (
                  <Card key={c.tenantId}>
                    <div className="approval-full-head"><strong>{c.name}</strong>{c.complianceScore !== null && <span className={`badge ${c.complianceScore >= 80 ? 'green' : 'amber'}`}><span />{c.complianceScore}% on time</span>}</div>
                    <dl className="diff">
                      <div><dt>People</dt><dd>{c.headcount}</dd></div>
                      <div><dt>In today</dt><dd>{c.presentToday}</dd></div>
                      <div><dt>Joiners</dt><dd>{c.joinersThisMonth}</dd></div>
                      <div><dt>Exits</dt><dd>{c.exitsThisMonth}</dd></div>
                      <div><dt>Last payroll</dt><dd>{c.lastLockedPayroll ? `${c.lastLockedPayroll.period} · ${money(c.lastLockedPayroll.netPaise)}` : '—'}</dd></div>
                      <div><dt>Waiting</dt><dd>{c.openApprovals} approvals · {c.openTickets} tickets</dd></div>
                    </dl>
                  </Card>
                ))}
              </div>
              <p className="subtle">You see totals, never individual records; each view is recorded in the member’s audit log.</p>
            </>
          ) : <Empty title="Nothing to show" text="Invite companies by their org admin’s email; their totals appear once they accept." />}
        </Modal>
      )}
      {creating && <CreateGroup onClose={() => setCreating(false)} onDone={async () => { setCreating(false); await load() }} />}
    </>
  )
}

function CreateGroup({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [name, setName] = useState('')
  const [kind, setKind] = useState('group')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false)
  return (
    <Modal title="Create a group" onClose={onClose}>
      <div className="template-form">
        <label className="field"><span>Name</span><input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Holdings" /></label>
        <label className="field"><span>Kind</span><select value={kind} onChange={(e) => setKind(e.target.value)}><option value="group">Group — see member companies’ totals</option><option value="reseller">Reseller — provision and bill companies</option></select></label>
        {error && <ErrorBox message={error} />}
        <div className="decision-actions"><Button disabled={busy || !name.trim()} onClick={async () => { setBusy(true); try { await domainApi('/groups', { name, kind }); await onDone() } catch (e) { setError((e as Error).message) } finally { setBusy(false) } }}>{busy ? 'Creating…' : 'Create'}</Button><Button variant="ghost" onClick={onClose}>Cancel</Button></div>
      </div>
    </Modal>
  )
}

function Sandbox() {
  const [state, setState] = useState<{ isSandbox: boolean; sandbox: { id: string; display_name: string; sandbox_expires_on: string; admin_email: string; headcount: number } | null; loginHint: { password: string; note: string } } | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState('')
  const load = useCallback(async () => { try { setState(await domainApi('/sandbox')); setError('') } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  async function act(path: string, method: 'POST' | 'DELETE', key: string) {
    setBusy(key)
    try { await domainApi(path, method === 'DELETE' ? undefined : {}, method); await load() } catch (e) { setError((e as Error).message) } finally { setBusy('') }
  }
  if (error) return <ErrorBox message={error} />
  if (!state) return <Skeleton />
  const days = state.sandbox ? Math.ceil((Date.parse(state.sandbox.sandbox_expires_on) - Date.now()) / 86_400_000) : 0
  return (
    <Card title={state.sandbox ? state.sandbox.display_name : 'No sandbox yet'} subtitle="A full copy of the product with invented people. Nothing it sends leaves the building.">
      {state.sandbox ? (
        <>
          <div className="stats-row">
            <div className="stat"><small>Sample people</small><strong>{state.sandbox.headcount}</strong></div>
            <div className="stat"><small>Expires in</small><strong className={days <= 3 ? 'bad' : ''}>{days} day{days === 1 ? '' : 's'}</strong></div>
          </div>
          <p className="subtle">Sign in at the same address with <strong>{state.sandbox.admin_email}</strong> and the password <code className="secret">{state.loginHint.password}</code> — {state.loginHint.note}.</p>
          <div className="decision-actions">
            <Button variant="secondary" disabled={busy !== ''} onClick={() => void act('/sandbox/reset', 'POST', 'reset')}>{busy === 'reset' ? 'Rebuilding…' : 'Reset with fresh data'}</Button>
            <Button variant="danger" disabled={busy !== ''} onClick={() => void act('/sandbox', 'DELETE', 'delete')}>Delete sandbox</Button>
          </div>
        </>
      ) : (
        <>
          <p>Train people, try a payroll run, break things — in a company that is not yours. Twelve sample people, a fortnight of attendance, every module switched on.</p>
          <Button disabled={busy !== ''} onClick={() => void act('/sandbox', 'POST', 'create')}>{busy === 'create' ? 'Building…' : 'Create a sandbox'}</Button>
        </>
      )}
    </Card>
  )
}

function Benchmarks() {
  const [b, setB] = useState<{ sharing: boolean; segment?: string; contributors?: number; minimum: number; metrics: Array<{ key: string; label: string; lowerIsBetter: boolean | null; mine?: number | null; p25?: number | null; median?: number | null; p75?: number | null; shown: boolean }>; note?: string } | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => { try { setB(await domainApi('/benchmarks')); setError('') } catch (e) { setError((e as Error).message) } }, [])
  useEffect(() => { void load() }, [load])
  if (error) return <ErrorBox message={error} />
  if (!b) return <Skeleton />
  return (
    <>
      {!b.sharing ? (
        <Card title="Join the benchmark" subtitle="Six operational ratios — never pay.">
          <p>{b.note}</p>
          <p className="subtle">What is shared: attrition, attendance, lateness, leave days, overtime and approval turnaround — as ratios, under a one-way hash of this company. Nothing is shown for a segment with fewer than {b.minimum} companies. Opting out deletes everything you contributed.</p>
          <p className="subtle">Turn on <code>benchmarks.share_enabled</code> in Settings to join.</p>
        </Card>
      ) : (
        <>
          <p className="subtle">Your segment: <strong>{b.segment}</strong> · {b.contributors} companies contributing (minimum {b.minimum}).</p>
          <div className="template-grid">
            {b.metrics.map((m) => (
              <Card key={m.key}>
                <strong>{m.label}</strong>
                {m.shown && m.median !== null && m.median !== undefined ? (
                  <>
                    <div className="bench-band" role="img" aria-label={`You ${m.mine ?? '—'}, median ${m.median}, quartiles ${m.p25} to ${m.p75}`}>
                      <i className="band" />
                      <i className="median" style={{ left: `${pos(m.median, m)}%` }} />
                      {m.mine !== null && m.mine !== undefined && <i className="mine" style={{ left: `${pos(m.mine, m)}%` }} />}
                    </div>
                    <p className="subtle">You <strong>{m.mine ?? '—'}</strong> · median {m.median} · p25 {m.p25} · p75 {m.p75}</p>
                  </>
                ) : <p className="subtle">Fewer than {b.minimum} companies in your segment yet — nothing is shown, not even a median.</p>}
              </Card>
            ))}
          </div>
          <Button variant="ghost" onClick={async () => { await domainApi('/benchmarks/opt-out', {}); await load() }}>Opt out and delete what we contributed</Button>
        </>
      )}
    </>
  )
}
function pos(v: number, m: { p25?: number | null; p75?: number | null }): number {
  const lo = Math.min(m.p25 ?? v, v), hi = Math.max(m.p75 ?? v, v)
  return hi === lo ? 50 : Math.max(2, Math.min(98, (v - lo) / (hi - lo) * 100))
}

function Gaps() {
  const [rows, setRows] = useState<Array<{ sample_question: string; asks: number; last_asked: string }> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { domainApi<{ gaps: NonNullable<typeof rows> }>('/assistant/gaps').then((r) => setRows(r.gaps)).catch((e: Error) => setError(e.message)) }, [])
  if (error) return <ErrorBox message={error} />
  if (!rows) return <Skeleton />
  if (!rows.length) return <Card><Empty title="Nothing unanswered" text="Questions the assistant could not answer appear here once at least two people have asked the same thing. Nobody is named." /></Card>
  return (
    <Card className="data-card">
      <div className="table-scroll">
        <table>
          <thead><tr><th>Question</th><th className="num">Asked</th><th>Last asked</th></tr></thead>
          <tbody>{rows.map((g, i) => <tr key={i}><td><CircleHelp size={14} aria-hidden="true" /> {g.sample_question}</td><td className="num">{g.asks}</td><td>{dateLabel(g.last_asked)}</td></tr>)}</tbody>
        </table>
      </div>
      <p className="subtle"><Gauge size={14} aria-hidden="true" /> Counts only — a question is never attributed to the person who asked it.</p>
    </Card>
  )
}
