/**
 * The grounded assistant.
 *
 * Not a chatbot: a small set of INTENTS, each a question people actually ask
 * HR, each answered from the caller's own rows under the caller's own
 * permissions and scope, each answer carrying the rows it was read from. A
 * question that matches no intent says so and is counted, so the gaps drive
 * the next intent. There is no model in the loop and nothing leaves the
 * database; an LLM can later sit in front of `classify` to paraphrase, but
 * `answer` is what guarantees the answer is true and permitted.
 */
import type { PoolClient } from 'pg'
import type { AuthzContext } from '../authz/permissions.ts'
import type { ResolvedConfig } from '../config/resolver.ts'
import { can } from '../authz/permissions.ts'
import { balance } from '../leave/ledger.ts'

export interface Source { type: string; id?: string; label: string }
export interface Answer { intent: string | null; confidence: number; text: string; sources: Source[]; suggestions: string[]; data?: unknown }

interface Intent { key: string; patterns: RegExp[]; needsEmployee?: boolean; permission?: string; run: (tx: PoolClient, q: Ctx) => Promise<Omit<Answer, 'intent' | 'confidence' | 'suggestions'>> }
interface Ctx { auth: AuthzContext; cfg: ResolvedConfig; today: string; question: string; match: RegExpMatchArray }

const norm = (s: string): string => s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december']
const monthIn = (q: string, today: string): string | null => {
  const m = q.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b(?:\s+(\d{4}))?/i)
  if (!m) return /\blast month\b/.test(q) ? new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 2, 1)).toISOString().slice(0, 7) : null
  const idx = MONTHS.findIndex((x) => x.startsWith(m[1]!.toLowerCase().slice(0, 3)))
  const year = m[2] ? Number(m[2]) : (idx + 1 > Number(today.slice(5, 7)) ? Number(today.slice(0, 4)) - 1 : Number(today.slice(0, 4)))
  return `${year}-${String(idx + 1).padStart(2, '0')}`
}

const INTENTS: Intent[] = [
  { key: 'leave.balance', patterns: [/\b(leave|leaves|cl|sl|el|pl)\b.*\b(balance|left|remaining|have|available)\b/, /\bhow many (leaves|days off|holidays? can i)\b/, /\b(balance|remaining)\b.*\bleave/], needsEmployee: true,
    run: async (tx, q) => {
      const types = (await tx.query<{ id: string; code: string; name: string }>(`SELECT id, code, name FROM leave_types ORDER BY code`)).rows
      const year = Number(q.today.slice(0, 4))
      const rows = []
      for (const t of types) { const b = await balance(tx, q.auth.employeeId!, t.id, year, q.today); if (b.opening || b.accrued || b.consumed) rows.push({ code: t.code, name: t.name, available: b.available, consumed: b.consumed }) }
      if (!rows.length) return { text: 'You have no leave balances on record for this year yet.', sources: [{ type: 'leave_ledger', label: `Leave ledger ${year}` }] }
      return { text: rows.map((r) => `${r.name} (${r.code}): ${r.available} day${r.available === 1 ? '' : 's'} available, ${r.consumed} used`).join('\n'), sources: [{ type: 'leave_ledger', label: `Leave ledger ${year}` }], data: rows }
    } },
  { key: 'leave.pending', patterns: [/\b(my|pending|status of).*\bleave (request|application)/, /\bleave.*\b(approved|pending|status)\b/], needsEmployee: true,
    run: async (tx, q) => {
      const rows = (await tx.query<{ id: string; code: string; start_date: string; end_date: string; total_days: string; status: string }>(`SELECT l.id, lt.code, l.start_date::text, l.end_date::text, l.total_days::text, l.status FROM leave_requests l JOIN leave_types lt ON (lt.tenant_id, lt.id) = (l.tenant_id, l.leave_type_id) WHERE l.employee_id = $1 ORDER BY l.applied_at DESC LIMIT 5`, [q.auth.employeeId])).rows
      if (!rows.length) return { text: 'You have not applied for leave yet.', sources: [] }
      return { text: rows.map((r) => `${r.code} ${r.start_date}${r.end_date !== r.start_date ? ` to ${r.end_date}` : ''} (${r.total_days} day${Number(r.total_days) === 1 ? '' : 's'}): ${r.status}`).join('\n'), sources: rows.map((r) => ({ type: 'leave_request', id: r.id, label: `${r.code} ${r.start_date}` })), data: rows }
    } },
  { key: 'payroll.payday', patterns: [/\b(when|what date).*\b(salary|pay|payroll|paid)\b/, /\bpay ?day\b/, /\bsalary date\b/],
    run: async (tx, q) => {
      const p = (await tx.query<{ label: string; pay_date: string }>(`SELECT label, pay_date::text FROM payroll_periods WHERE pay_date >= $1::date ORDER BY pay_date LIMIT 1`, [q.today])).rows[0]
      if (!p) return { text: 'The next pay date has not been set up yet — payroll creates it when the period is opened.', sources: [] }
      return { text: `Salary for ${p.label} is scheduled to be paid on ${p.pay_date}.`, sources: [{ type: 'payroll_period', label: p.label }] }
    } },
  { key: 'payroll.payslip', patterns: [/\bpayslip|salary slip|pay slip\b/, /\b(my|last|latest) (salary|pay)\b/], needsEmployee: true,
    run: async (tx, q) => {
      const month = monthIn(q.question, q.today)
      const rows = (await tx.query<{ run_id: string; label: string; net: string }>(`SELECT s.run_id, p.label, s.net_paise::text AS net FROM payslips s JOIN payroll_runs r ON (r.tenant_id, r.id) = (s.tenant_id, s.run_id) JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id) WHERE s.employee_id = $1 AND r.status = 'locked' AND ($2::text IS NULL OR p.label = $2) ORDER BY p.period_end DESC LIMIT 3`, [q.auth.employeeId, month])).rows
      if (!rows.length) return { text: month ? `No locked payslip for ${month} yet.` : 'No payslips yet — the first appears once a payroll run is locked.', sources: [] }
      return { text: rows.map((r) => `${r.label}: net ₹${(Number(r.net) / 100).toLocaleString('en-IN')} — download from Me → Payslips`).join('\n'), sources: rows.map((r) => ({ type: 'payslip', id: r.run_id, label: r.label })), data: rows.map((r) => ({ period: r.label, runId: r.run_id })) }
    } },
  { key: 'holidays.upcoming', patterns: [/\b(next|upcoming|coming|list of|when is).*\bholiday/, /\bholidays? (this|next) (month|year)\b/, /\bpublic holidays?\b/],
    run: async (tx, q) => {
      const rows = (await tx.query<{ holiday_on: string; name: string }>(`SELECT holiday_on::text, name FROM holidays WHERE holiday_on >= $1::date ORDER BY holiday_on LIMIT 6`, [q.today])).rows
      if (!rows.length) return { text: 'No upcoming holidays are on the calendar.', sources: [{ type: 'holidays', label: 'Holiday calendar' }] }
      return { text: rows.map((r) => `${r.holiday_on}: ${r.name}`).join('\n'), sources: [{ type: 'holidays', label: 'Holiday calendar' }], data: rows }
    } },
  { key: 'attendance.today', patterns: [/\b(who is|who's|whos) (absent|present|on leave|in|out)\b/, /\b(absent|present|attendance) today\b/, /\bteam attendance\b/], permission: 'attendance.read',
    run: async (tx, q) => {
      const ids = q.auth.scope === 'all' ? null : [q.auth.employeeId, ...q.auth.reportIds].filter((x): x is string => Boolean(x))
      const rows = (await tx.query<{ status: string; n: string; names: string[] }>(`SELECT a.status, count(*)::text AS n, (array_agg(concat_ws(' ', e.first_name, e.last_name) ORDER BY e.first_name))[1:8] AS names FROM daily_attendance a JOIN employees e ON (e.tenant_id, e.id) = (a.tenant_id, a.employee_id) WHERE a.work_date = $1::date AND ($2::uuid[] IS NULL OR a.employee_id = ANY($2)) GROUP BY a.status ORDER BY a.status`, [q.today, ids])).rows
      if (!rows.length) return { text: `Nothing recorded for ${q.today} yet.`, sources: [{ type: 'daily_attendance', label: q.today }] }
      const want = /absent/.test(q.question) ? ['absent'] : /leave/.test(q.question) ? ['on_leave'] : /present|in\b/.test(q.question) ? ['present'] : null
      const show = want ? rows.filter((r) => want.includes(r.status)) : rows
      return { text: (show.length ? show : rows).map((r) => `${r.status.replace('_', ' ')}: ${r.n}${r.names.length && r.status !== 'present' ? ` (${r.names.join(', ')}${Number(r.n) > 8 ? ', …' : ''})` : ''}`).join('\n'), sources: [{ type: 'daily_attendance', label: q.today }], data: rows }
    } },
  { key: 'policy.lookup', patterns: [/\bpolicy\b/, /\b(rule|rules|allowed|can i|am i allowed|permitted)\b.*\b(wfh|work from home|remote|leave|dress|expense|travel|notice|probation|maternity|paternity|overtime|late)\b/, /\b(wfh|work from home) policy\b/],
    run: async (tx, q) => {
      const words = norm(q.question).split(' ').filter((w) => w.length > 3 && !['policy', 'what', 'does', 'about', 'company', 'have', 'there', 'allowed', 'rules'].includes(w))
      const rows = (await tx.query<{ id: string; code: string; title: string; body: string | null; rank: number }>(
        `SELECT id, code, title, body, ts_rank(to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '')), plainto_tsquery('english', $1)) AS rank FROM policies WHERE status = 'published' AND ($1 = '' OR to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '')) @@ plainto_tsquery('english', $1)) ORDER BY rank DESC, title LIMIT 3`, [words.join(' ')])).rows
      if (!rows.length) return { text: words.length ? `No published policy mentions "${words.join(' ')}". Ask HR, or check Company → Policies.` : 'Which policy? Try "what is the WFH policy" or "notice period policy".', sources: [] }
      const top = rows[0]!
      const excerpt = (top.body ?? '').replace(/\s+/g, ' ').slice(0, 400)
      return { text: `${top.title} (${top.code}):\n${excerpt}${(top.body ?? '').length > 400 ? '…' : ''}${rows.length > 1 ? `\n\nSee also: ${rows.slice(1).map((r) => r.title).join(', ')}` : ''}`, sources: rows.map((r) => ({ type: 'policy', id: r.id, label: r.title })), data: rows.map((r) => ({ id: r.id, code: r.code, title: r.title })) }
    } },
  { key: 'people.manager', patterns: [/\b(who is|who's|whos) my (manager|reporting manager|boss|supervisor)\b/, /\bmy manager\b/], needsEmployee: true,
    run: async (tx, q) => {
      const r = (await tx.query<{ name: string; email: string | null; designation: string | null }>(`SELECT concat_ws(' ', m.first_name, m.last_name) AS name, (SELECT email FROM app_users u WHERE u.employee_id = m.id AND u.status = 'active' LIMIT 1) AS email, (SELECT designation FROM employee_assignments x WHERE x.employee_id = m.id AND x.superseded_at IS NULL AND x.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS designation
        FROM employee_assignments a JOIN employees m ON (m.tenant_id, m.id) = (a.tenant_id, a.manager_employee_id) WHERE a.employee_id = $1 AND a.superseded_at IS NULL AND a.effective_to IS NULL ORDER BY a.effective_from DESC LIMIT 1`, [q.auth.employeeId])).rows[0]
      if (!r) return { text: 'No reporting manager is recorded for you.', sources: [] }
      return { text: `Your manager is ${r.name}${r.designation ? `, ${r.designation}` : ''}${r.email ? ` (${r.email})` : ''}.`, sources: [{ type: 'employee_assignment', label: 'Current posting' }] }
    } },
  { key: 'approvals.pending', patterns: [/\b(what|anything|requests?)\b.*\b(pending|waiting|awaiting)\b.*\b(approval|me|my)\b/, /\bmy (approvals|inbox|pending approvals)\b/, /\bwhat do i need to approve\b/],
    run: async (tx, q) => {
      const rows = (await tx.query<{ n: string; entity_type: string }>(`SELECT r.entity_type, count(*)::text AS n FROM approval_steps s JOIN approval_requests r ON (r.tenant_id, r.id) = (s.tenant_id, s.approval_request_id) WHERE s.approver_user_id = $1 AND s.status = 'pending' AND r.status = 'pending' GROUP BY r.entity_type ORDER BY 2 DESC`, [q.auth.userId])).rows
      if (!rows.length) return { text: 'Nothing is waiting for your approval.', sources: [{ type: 'inbox', label: 'Approvals inbox' }] }
      return { text: `Waiting for you: ${rows.map((r) => `${r.n} ${r.entity_type.replace('_', ' ')}`).join(', ')}. Open Inbox → Approvals.`, sources: [{ type: 'inbox', label: 'Approvals inbox' }], data: rows }
    } },
  { key: 'attendance.mine', patterns: [/\bmy (attendance|punches?|hours|working hours)\b/, /\bdid i (punch|clock|check)/, /\bhow many days (was i|have i been) (present|absent|late)\b/], needsEmployee: true,
    run: async (tx, q) => {
      const month = monthIn(q.question, q.today) ?? q.today.slice(0, 7)
      const r = (await tx.query<{ present: string; absent: string; leave: string; late: string; hours: string }>(`SELECT count(*) FILTER (WHERE status = 'present')::text AS present, count(*) FILTER (WHERE status = 'absent')::text AS absent, count(*) FILTER (WHERE status = 'on_leave')::text AS leave, count(*) FILTER (WHERE late_minutes > 0)::text AS late, round(coalesce(sum(worked_minutes), 0) / 60.0, 1)::text AS hours FROM daily_attendance WHERE employee_id = $1 AND to_char(work_date, 'YYYY-MM') = $2`, [q.auth.employeeId, month])).rows[0]!
      return { text: `${month}: ${r.present} present, ${r.absent} absent, ${r.leave} on leave, late ${r.late} time${r.late === '1' ? '' : 's'}, ${r.hours} hours worked.`, sources: [{ type: 'daily_attendance', label: month }], data: { month, ...r } }
    } },
]

export const INTENT_KEYS = INTENTS.map((i) => i.key)
export const EXAMPLES = ['How many leaves do I have left?', 'When is salary paid?', 'Show my payslip for August', 'Who is absent today?', 'What is the WFH policy?', 'Who is my manager?', 'What is pending my approval?', 'My attendance this month', 'Upcoming holidays']

/** Rule-based intent match: the longest pattern hit wins; confidence is the share of the question the pattern covered. */
export function classify(question: string): { intent: Intent | null; confidence: number; match: RegExpMatchArray | null } {
  const q = norm(question)
  let best: { intent: Intent; match: RegExpMatchArray; len: number } | null = null
  for (const intent of INTENTS) for (const p of intent.patterns) { const m = q.match(p); if (m && (!best || m[0].length > best.len)) best = { intent, match: m, len: m[0].length } }
  if (!best) return { intent: null, confidence: 0, match: null }
  return { intent: best.intent, match: best.match, confidence: Math.min(0.99, Math.max(0.4, Math.round(best.len / Math.max(1, q.length) * 100) / 100 + 0.3)) }
}

export async function answer(tx: PoolClient, args: { question: string; auth: AuthzContext; cfg: ResolvedConfig; today: string }): Promise<Answer> {
  const question = (args.question ?? '').trim().slice(0, 500)
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const log = async (intent: string | null, confidence: number, sources: Source[]): Promise<void> => { await tx.query(`INSERT INTO assistant_queries (tenant_id, user_id, question, intent, confidence, sources) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`, [tid, args.auth.userId, question, intent, confidence, JSON.stringify(sources)]) }
  if (!question) return { intent: null, confidence: 0, text: 'Ask me something — for example:', sources: [], suggestions: EXAMPLES }
  const c = classify(question)
  if (!c.intent) { await log(null, 0, []); return { intent: null, confidence: 0, text: 'I can answer questions about your leave, pay dates and payslips, attendance, holidays, policies, your manager and your approvals — from your own records. I did not understand that one; HR will see it was asked.', sources: [], suggestions: EXAMPLES } }
  if (c.intent.needsEmployee && !args.auth.employeeId) { await log(c.intent.key, c.confidence, []); return { intent: c.intent.key, confidence: c.confidence, text: 'Your login is not linked to an employee record, so I cannot look that up for you.', sources: [], suggestions: [] } }
  if (c.intent.permission && !can(args.auth, c.intent.permission as never)) { await log(c.intent.key, c.confidence, []); return { intent: c.intent.key, confidence: c.confidence, text: 'That needs a permission your role does not have.', sources: [], suggestions: [] } }
  const r = await c.intent.run(tx, { auth: args.auth, cfg: args.cfg, today: args.today, question: norm(question), match: c.match! })
  await log(c.intent.key, c.confidence, r.sources)
  return { intent: c.intent.key, confidence: c.confidence, suggestions: EXAMPLES.filter((e) => !classify(e).intent || classify(e).intent!.key !== c.intent!.key).slice(0, 3), ...r }
}
export async function markHelpful(tx: PoolClient, args: { id: string; helpful: boolean }): Promise<void> {
  await tx.query(`UPDATE assistant_queries SET helpful = $2 WHERE id = $1`, [args.id, args.helpful])
}
export async function lastQueryId(tx: PoolClient, userId: string): Promise<string | null> {
  return (await tx.query<{ id: string }>(`SELECT id FROM assistant_queries WHERE user_id = $1 ORDER BY asked_at DESC LIMIT 1`, [userId])).rows[0]?.id ?? null
}
export async function gaps(tx: PoolClient, days = 30): Promise<Array<{ sample_question: string; asks: number; last_asked: string }>> {
  return (await tx.query(`SELECT sample_question, asks, last_asked::text FROM assistant_gaps($1)`, [days])).rows
}
