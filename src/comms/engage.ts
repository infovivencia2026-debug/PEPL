/**
 * Policies (read-and-acknowledge), surveys (anonymous by policy) and the
 * celebrations feed.
 *
 * A published policy fans out a notification and a due date; HR sees who has
 * not signed. A survey response on an anonymous survey is written WITHOUT an
 * author and without RETURNING (the row is invisible to its own writer), and
 * is read back only through survey_aggregate(), which withholds any group
 * smaller than min_group.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { currentPosting } from '../people/profile.ts'

export class EngageError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'EngageError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const userOf = async (tx: PoolClient, employeeId: string): Promise<string | null> => (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])).rows[0]?.id ?? null

// ── policies ─────────────────────────────────────────────────────────────────

export interface Policy { id: string; code: string; title: string; version: number; body: string | null; document_id: string | null; requires_acknowledgement: boolean; applies_to: { departments?: string[]; locations?: string[] }; status: string; published_at: string | null; due_days: number }
const P_COLS = `id, code, title, version, body, document_id, requires_acknowledgement, applies_to, status, published_at::text, due_days`

export async function draftPolicy(tx: PoolClient, args: { code: string; title: string; body?: string | null; documentId?: string | null; requiresAcknowledgement?: boolean; appliesTo?: Policy['applies_to']; dueDays?: number; actorUserId: string }): Promise<Policy> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 40)
  if (!code || !args.title?.trim()) throw new EngageError('VALIDATION_FAILED', 'code and title are required')
  if (!args.body?.trim() && !args.documentId) throw new EngageError('VALIDATION_FAILED', 'a policy has a body or a document')
  // a new version of an existing code; the previous published one is retired on publish
  const { rows: v } = await tx.query<{ v: number }>(`SELECT coalesce(max(version), 0) + 1 AS v FROM policies WHERE code = $1`, [code])
  const { rows } = await tx.query<Policy>(
    `INSERT INTO policies (tenant_id, code, title, version, body, document_id, requires_acknowledgement, applies_to, due_days, created_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING ${P_COLS}`,
    [tid, code, args.title.trim(), v[0]!.v, args.body?.trim() || null, args.documentId ?? null, args.requiresAcknowledgement ?? true, JSON.stringify(args.appliesTo ?? {}), args.dueDays ?? 14, args.actorUserId])
  return rows[0]!
}

async function audienceOf(tx: PoolClient, appliesTo: Policy['applies_to']): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT e.id FROM employees e
       LEFT JOIN LATERAL (SELECT department, location_code FROM employee_assignments a WHERE a.employee_id = e.id AND a.superseded_at IS NULL AND a.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) a ON true
      WHERE e.status = 'active' AND e.erased_at IS NULL
        AND ($1::text[] IS NULL OR a.department = ANY($1)) AND ($2::text[] IS NULL OR a.location_code = ANY($2))`,
    [appliesTo.departments?.length ? appliesTo.departments : null, appliesTo.locations?.length ? appliesTo.locations : null])
  return rows.map((r) => r.id)
}

export async function publishPolicy(tx: PoolClient, policyId: string): Promise<{ policy: Policy; notified: number }> {
  const p = (await tx.query<Policy>(`SELECT ${P_COLS} FROM policies WHERE id = $1 FOR UPDATE`, [policyId])).rows[0]
  if (!p) throw new EngageError('NOT_FOUND', 'no such policy')
  if (p.status !== 'draft') throw new EngageError('POLICY_STATE', `the policy is ${p.status}`)
  await tx.query(`UPDATE policies SET status = 'retired' WHERE code = $1 AND status = 'published' AND id <> $2`, [p.code, p.id])
  await tx.query(`UPDATE policies SET status = 'published', published_at = now() WHERE id = $1`, [p.id])
  let notified = 0
  for (const e of await audienceOf(tx, p.applies_to)) {
    const u = await userOf(tx, e)
    if (!u) continue
    await notify(tx, { userId: u, eventType: 'policy.published', title: p.requires_acknowledgement ? `Please read and acknowledge: ${p.title}` : `New policy: ${p.title}`,
      body: p.requires_acknowledgement ? `Due within ${p.due_days} days.` : undefined, entityType: 'policy', entityId: p.id, dedupeKey: `policy:${p.id}:${u}` })
    notified++
  }
  return { policy: (await tx.query<Policy>(`SELECT ${P_COLS} FROM policies WHERE id = $1`, [p.id])).rows[0]!, notified }
}

export async function listPolicies(tx: PoolClient, args: { status?: string; forEmployeeId?: string }): Promise<Array<Policy & { acknowledged_at: string | null }>> {
  return (await tx.query<Policy & { acknowledged_at: string | null }>(
    `SELECT ${P_COLS.split(', ').map((c) => 'p.' + c).join(', ')}, (SELECT acknowledged_at::text FROM policy_acknowledgements a WHERE a.policy_id = p.id AND a.employee_id = $2) AS acknowledged_at
       FROM policies p WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.status = 'published' DESC, p.title, p.version DESC`, [args.status ?? null, args.forEmployeeId ?? null])).rows
}

export async function acknowledgePolicy(tx: PoolClient, args: { policyId: string; employeeId: string; ip?: string | null }): Promise<void> {
  const tid = await tenantId(tx)
  const p = (await tx.query<{ status: string; requires_acknowledgement: boolean }>(`SELECT status, requires_acknowledgement FROM policies WHERE id = $1`, [args.policyId])).rows[0]
  if (!p) throw new EngageError('NOT_FOUND', 'no such policy')
  if (p.status !== 'published') throw new EngageError('POLICY_STATE', 'only a published policy can be acknowledged')
  await tx.query(`INSERT INTO policy_acknowledgements (tenant_id, policy_id, employee_id, ip) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, policy_id, employee_id) DO NOTHING`, [tid, args.policyId, args.employeeId, args.ip ?? null])
}

/** Who has and has not signed a published policy — the compliance report. */
export async function policyCompliance(tx: PoolClient, policyId: string): Promise<{ policy: Policy; audience: number; acknowledged: number; overdue: number; pending: Array<{ employeeId: string; name: string; department: string | null; dueOn: string }> }> {
  const p = (await tx.query<Policy>(`SELECT ${P_COLS} FROM policies WHERE id = $1`, [policyId])).rows[0]
  if (!p) throw new EngageError('NOT_FOUND', 'no such policy')
  const audience = await audienceOf(tx, p.applies_to)
  const { rows: acked } = await tx.query<{ employee_id: string }>(`SELECT employee_id FROM policy_acknowledgements WHERE policy_id = $1`, [policyId])
  const ackSet = new Set(acked.map((a) => a.employee_id))
  const dueOn = p.published_at ? new Date(Date.parse(p.published_at) + p.due_days * 86_400_000).toISOString().slice(0, 10) : '—'
  const pending: Array<{ employeeId: string; name: string; department: string | null; dueOn: string }> = []
  for (const e of audience.filter((id) => !ackSet.has(id))) {
    const row = (await tx.query<{ name: string }>(`SELECT concat_ws(' ', first_name, last_name) AS name FROM employees WHERE id = $1`, [e])).rows[0]!
    const posting = await currentPosting(tx, e)
    pending.push({ employeeId: e, name: row.name, department: posting?.department ?? null, dueOn })
  }
  const overdue = dueOn !== '—' && dueOn < new Date().toISOString().slice(0, 10) ? pending.length : 0
  return { policy: p, audience: audience.length, acknowledged: audience.filter((id) => ackSet.has(id)).length, overdue, pending }
}

/** Nightly: remind everyone still to sign a published policy past half its due window. */
export async function remindPolicies(tx: PoolClient, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const { rows } = await tx.query<Policy>(`SELECT ${P_COLS} FROM policies WHERE status = 'published' AND requires_acknowledgement`)
  let n = 0
  for (const p of rows) {
    const c = await policyCompliance(tx, p.id)
    for (const e of c.pending) {
      const u = await userOf(tx, e.employeeId)
      if (u && await notify(tx, { userId: u, eventType: 'policy.reminder', title: `${e.dueOn < today ? 'Overdue' : 'Reminder'}: acknowledge ${p.title}`, entityType: 'policy', entityId: p.id, dedupeKey: `policy:remind:${p.id}:${u}:${today}` })) n++
    }
  }
  return n
}

// ── surveys ──────────────────────────────────────────────────────────────────

export interface Question { id: string; text: string; type: 'scale' | 'nps' | 'text' | 'choice'; options?: string[] }
export interface Survey { id: string; title: string; kind: string; questions: Question[]; anonymous: boolean; min_group: number; audience: { departments?: string[]; locations?: string[] }; opens_at: string; closes_at: string | null; status: string }
const S_COLS = `id, title, kind, questions, anonymous, min_group, audience, opens_at::text, closes_at::text, status`

export async function createSurvey(tx: PoolClient, args: { title: string; kind?: Survey['kind']; questions: Question[]; anonymous?: boolean; minGroup?: number; audience?: Survey['audience']; closesAt?: string | null; actorUserId: string }): Promise<Survey> {
  const tid = await tenantId(tx)
  if (!args.title?.trim()) throw new EngageError('VALIDATION_FAILED', 'a survey needs a title')
  if (!Array.isArray(args.questions) || !args.questions.length || args.questions.length > 30) throw new EngageError('VALIDATION_FAILED', '1–30 questions')
  for (const q of args.questions) {
    if (!q.id || !q.text?.trim() || !['scale', 'nps', 'text', 'choice'].includes(q.type)) throw new EngageError('VALIDATION_FAILED', 'each question has id, text and a type of scale, nps, text or choice')
    if (q.type === 'choice' && !(q.options?.length)) throw new EngageError('VALIDATION_FAILED', `question ${q.id}: choice needs options`)
  }
  if (new Set(args.questions.map((q) => q.id)).size !== args.questions.length) throw new EngageError('VALIDATION_FAILED', 'question ids repeat')
  const minGroup = args.minGroup ?? 5
  if (!Number.isInteger(minGroup) || minGroup < 1 || minGroup > 50) throw new EngageError('VALIDATION_FAILED', 'minGroup is 1–50')
  if ((args.anonymous ?? true) && minGroup < 3) throw new EngageError('VALIDATION_FAILED', 'an anonymous survey needs a minimum group of at least 3')
  const { rows } = await tx.query<Survey>(
    `INSERT INTO surveys (tenant_id, title, kind, questions, anonymous, min_group, audience, closes_at, created_by_user_id) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7::jsonb,$8,$9) RETURNING ${S_COLS}`,
    [tid, args.title.trim(), args.kind ?? 'pulse', JSON.stringify(args.questions), args.anonymous ?? true, minGroup, JSON.stringify(args.audience ?? {}), args.closesAt ?? null, args.actorUserId])
  return rows[0]!
}

export async function openSurvey(tx: PoolClient, surveyId: string): Promise<{ survey: Survey; invited: number }> {
  const s = (await tx.query<Survey>(`SELECT ${S_COLS} FROM surveys WHERE id = $1 FOR UPDATE`, [surveyId])).rows[0]
  if (!s) throw new EngageError('NOT_FOUND', 'no such survey')
  if (s.status !== 'draft') throw new EngageError('SURVEY_STATE', `the survey is ${s.status}`)
  await tx.query(`UPDATE surveys SET status = 'open', opens_at = now() WHERE id = $1`, [s.id])
  let invited = 0
  for (const e of await audienceOf(tx, s.audience)) {
    const u = await userOf(tx, e)
    if (u) { await notify(tx, { userId: u, eventType: 'survey.opened', title: `${s.anonymous ? 'Anonymous survey' : 'Survey'}: ${s.title}`, body: s.closes_at ? `Closes ${s.closes_at.slice(0, 10)}` : undefined, entityType: 'survey', entityId: s.id, dedupeKey: `survey:${s.id}:${u}` }); invited++ }
  }
  return { survey: (await tx.query<Survey>(`SELECT ${S_COLS} FROM surveys WHERE id = $1`, [s.id])).rows[0]!, invited }
}
export async function closeSurvey(tx: PoolClient, surveyId: string): Promise<Survey> {
  const { rows } = await tx.query<Survey>(`UPDATE surveys SET status = 'closed', closes_at = coalesce(closes_at, now()) WHERE id = $1 AND status = 'open' RETURNING ${S_COLS}`, [surveyId])
  if (!rows[0]) throw new EngageError('SURVEY_STATE', 'only an open survey closes')
  return rows[0]
}
export async function listSurveys(tx: PoolClient, args: { status?: string; forEmployeeId?: string }): Promise<Array<Survey & { responded: boolean; responses: number }>> {
  return (await tx.query<Survey & { responded: boolean; responses: number }>(
    `SELECT ${S_COLS.split(', ').map((c) => 's.' + c).join(', ')},
            EXISTS (SELECT 1 FROM survey_participation p WHERE p.survey_id = s.id AND p.employee_id = $2) AS responded,
            (SELECT count(*)::int FROM survey_participation p WHERE p.survey_id = s.id) AS responses
       FROM surveys s WHERE ($1::text IS NULL OR s.status = $1) ORDER BY s.created_at DESC`, [args.status ?? null, args.forEmployeeId ?? null])).rows
}

export async function respondSurvey(tx: PoolClient, args: { surveyId: string; employeeId: string; userId: string; answers: Record<string, unknown> }): Promise<void> {
  const tid = await tenantId(tx)
  const s = (await tx.query<Survey>(`SELECT ${S_COLS} FROM surveys WHERE id = $1`, [args.surveyId])).rows[0]
  if (!s) throw new EngageError('NOT_FOUND', 'no such survey')
  if (s.status !== 'open') throw new EngageError('SURVEY_STATE', 'the survey is not open')
  if ((await tx.query(`SELECT 1 FROM survey_participation WHERE survey_id = $1 AND employee_id = $2`, [args.surveyId, args.employeeId])).rowCount) throw new EngageError('ALREADY_RESPONDED', 'you have already answered this survey')
  const clean: Record<string, unknown> = {}
  for (const q of s.questions) {
    const v = args.answers[q.id]
    if (v === undefined || v === null || v === '') continue
    if (q.type === 'scale') { if (!Number.isInteger(v) || (v as number) < 1 || (v as number) > 5) throw new EngageError('VALIDATION_FAILED', `${q.id}: 1–5`); clean[q.id] = v }
    else if (q.type === 'nps') { if (!Number.isInteger(v) || (v as number) < 0 || (v as number) > 10) throw new EngageError('VALIDATION_FAILED', `${q.id}: 0–10`); clean[q.id] = v }
    else if (q.type === 'choice') { if (!q.options!.includes(String(v))) throw new EngageError('VALIDATION_FAILED', `${q.id}: not an option`); clean[q.id] = String(v) }
    else clean[q.id] = String(v).slice(0, 2000)
  }
  if (!Object.keys(clean).length) throw new EngageError('VALIDATION_FAILED', 'answer at least one question')
  const posting = await currentPosting(tx, args.employeeId)
  const segment = { department: posting?.department ?? null, location: posting?.location_code ?? null }
  // No RETURNING: on an anonymous survey the row is invisible to its own writer, by design.
  await tx.query(`INSERT INTO survey_responses (tenant_id, survey_id, author_user_id, segment, answers) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb)`,
    [tid, args.surveyId, s.anonymous ? null : args.userId, JSON.stringify(segment), JSON.stringify(clean)])
  await tx.query(`INSERT INTO survey_participation (tenant_id, survey_id, employee_id) VALUES ($1,$2,$3)`, [tid, args.surveyId, args.employeeId])
}

export interface AggregateRow { segment: string; question_id: string; responses: number; avg_value: string | null; distribution: Record<string, number> | null; texts: string[] | null }
export async function surveyResults(tx: PoolClient, surveyId: string, segmentKey: 'department' | 'location' | null): Promise<{ survey: Survey; invited: number; responded: number; rows: AggregateRow[]; enps: number | null }> {
  const s = (await tx.query<Survey>(`SELECT ${S_COLS} FROM surveys WHERE id = $1`, [surveyId])).rows[0]
  if (!s) throw new EngageError('NOT_FOUND', 'no such survey')
  const responded = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM survey_participation WHERE survey_id = $1`, [surveyId])).rows[0]!.n)
  const invited = (await audienceOf(tx, s.audience)).length
  const { rows } = await tx.query<AggregateRow>(`SELECT segment, question_id, responses, avg_value::text, distribution, texts FROM survey_aggregate($1, $2)`, [surveyId, segmentKey])
  // eNPS from the first nps question, company-wide: % promoters (9–10) − % detractors (0–6)
  let enps: number | null = null
  const npsQ = s.questions.find((q) => q.type === 'nps')
  if (npsQ && segmentKey === null) {
    const r = rows.find((x) => x.question_id === npsQ.id && x.segment === 'all')
    if (r?.distribution) {
      const total = Object.values(r.distribution).reduce((a, b) => a + Number(b), 0)
      const prom = Object.entries(r.distribution).filter(([k]) => Number(k) >= 9).reduce((a, [, v]) => a + Number(v), 0)
      const det = Object.entries(r.distribution).filter(([k]) => Number(k) <= 6).reduce((a, [, v]) => a + Number(v), 0)
      enps = total ? Math.round(((prom - det) / total) * 100) : null
    }
  }
  return { survey: s, invited, responded, rows, enps }
}

// ── celebrations ─────────────────────────────────────────────────────────────

export async function celebrations(tx: PoolClient, args: { from: string; to: string; employeeIds?: string[] | null }): Promise<Array<{ employeeId: string; name: string; department: string | null; kind: 'birthday' | 'work_anniversary'; on: string; years?: number }>> {
  const { rows } = await tx.query<{ id: string; name: string; department: string | null; date_of_birth: string | null; date_of_joining: string; opted_out: boolean }>(
    `SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS name, a.department, e.date_of_birth::text, e.date_of_joining::text,
            coalesce((e.custom_fields ->> 'celebrations_opt_out')::boolean, false) AS opted_out
       FROM employees e LEFT JOIN LATERAL (SELECT department FROM employee_assignments x WHERE x.employee_id = e.id AND x.superseded_at IS NULL AND x.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) a ON true
      WHERE e.status = 'active' AND e.erased_at IS NULL AND ($1::uuid[] IS NULL OR e.id = ANY($1))`, [args.employeeIds ?? null])
  const out: Array<{ employeeId: string; name: string; department: string | null; kind: 'birthday' | 'work_anniversary'; on: string; years?: number }> = []
  const years = [Number(args.from.slice(0, 4)), Number(args.to.slice(0, 4))]
  for (const r of rows) {
    if (r.opted_out) continue
    for (const y of new Set(years)) {
      if (r.date_of_birth) { const on = `${y}-${r.date_of_birth.slice(5)}`; if (on >= args.from && on <= args.to) out.push({ employeeId: r.id, name: r.name, department: r.department, kind: 'birthday', on }) }
      const on = `${y}-${r.date_of_joining.slice(5)}`
      const n = y - Number(r.date_of_joining.slice(0, 4))
      if (n >= 1 && on >= args.from && on <= args.to) out.push({ employeeId: r.id, name: r.name, department: r.department, kind: 'work_anniversary', on, years: n })
    }
  }
  return out.sort((a, b) => a.on.localeCompare(b.on) || a.name.localeCompare(b.name))
}
