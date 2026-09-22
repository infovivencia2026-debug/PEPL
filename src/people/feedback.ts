/**
 * 360° feedback and promotion / increment recommendations.
 *
 * Feedback answers are confidential in the POLICY (a rater sees only their
 * own row); `feedback_aggregate()` is the only way anyone else reads them,
 * and it withholds a relationship group below `min_group`.
 *
 * A recommendation is raised off an appraisal, approved through the approval
 * engine, and on approval becomes the two writes HR would have made by hand:
 * an assignment change (designation / grade) and a compensation revision,
 * both effective-dated, both citing the appraisal.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { notify } from '../comms/index.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { changeAssignment, changeCompensation } from './history.ts'
import { currentPosting } from './profile.ts'

export class FeedbackError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'FeedbackError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const userOf = async (tx: PoolClient, employeeId: string): Promise<string | null> => (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])).rows[0]?.id ?? null

// ── 360° ─────────────────────────────────────────────────────────────────────

export interface FeedbackQuestion { id: string; text: string; type: 'rating' | 'text'; scale?: number }
export const DEFAULT_360_QUESTIONS: FeedbackQuestion[] = [
  { id: 'collab', text: 'Works well with others and shares credit', type: 'rating', scale: 5 },
  { id: 'delivery', text: 'Delivers what was promised, when it was promised', type: 'rating', scale: 5 },
  { id: 'comms', text: 'Communicates clearly and listens', type: 'rating', scale: 5 },
  { id: 'growth', text: 'Seeks feedback and acts on it', type: 'rating', scale: 5 },
  { id: 'keep', text: 'What should this person keep doing?', type: 'text' },
  { id: 'change', text: 'What is one thing they could do differently?', type: 'text' },
]
export type Relationship = 'manager' | 'peer' | 'report' | 'stakeholder' | 'self'
export interface Round { id: string; subject_employee_id: string; subject_name: string; appraisal_id: string | null; title: string; questions: FeedbackQuestion[]; min_group: number; due_on: string; status: string; created_at: string; closed_at: string | null }
const R_COLS = `r.id, r.subject_employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = r.subject_employee_id) AS subject_name, r.appraisal_id, r.title, r.questions, r.min_group, r.due_on::text, r.status, r.created_at::text, r.closed_at::text`

export async function openRound(tx: PoolClient, args: { subjectEmployeeId: string; appraisalId?: string | null; title?: string; questions?: FeedbackQuestion[]; minGroup?: number; dueOn: string; raters: Array<{ employeeId: string; relationship: Relationship }>; openedByUserId: string }): Promise<{ round: Round; requested: number }> {
  const tid = await tenantId(tx)
  const qs = args.questions?.length ? args.questions : DEFAULT_360_QUESTIONS
  for (const q of qs) if (!q.id || !q.text || !['rating', 'text'].includes(q.type)) throw new FeedbackError('VALIDATION_FAILED', 'each question has id, text and type rating|text')
  if (!args.raters.length) throw new FeedbackError('VALIDATION_FAILED', 'nominate at least one rater')
  for (const r of args.raters) {
    if (!['manager', 'peer', 'report', 'stakeholder', 'self'].includes(r.relationship)) throw new FeedbackError('VALIDATION_FAILED', 'relationship is manager, peer, report, stakeholder or self')
    if ((r.employeeId === args.subjectEmployeeId) !== (r.relationship === 'self')) throw new FeedbackError('VALIDATION_FAILED', 'only the subject is "self", and the subject can only be "self"')
  }
  if ((await tx.query(`SELECT 1 FROM feedback_rounds WHERE subject_employee_id = $1 AND status = 'open'`, [args.subjectEmployeeId])).rowCount) throw new FeedbackError('ROUND_OPEN', 'a 360° round is already open for this person')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO feedback_rounds (tenant_id, subject_employee_id, appraisal_id, title, questions, min_group, due_on, opened_by_user_id) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
    [tid, args.subjectEmployeeId, args.appraisalId ?? null, args.title?.trim() || '360° feedback', JSON.stringify(qs), args.minGroup ?? 3, args.dueOn, args.openedByUserId])
  const roundId = rows[0]!.id
  let requested = 0
  const seen = new Set<string>()
  for (const r of args.raters) {
    if (seen.has(r.employeeId)) continue
    seen.add(r.employeeId)
    const u = await userOf(tx, r.employeeId)
    await tx.query(`INSERT INTO feedback_requests (tenant_id, round_id, rater_employee_id, rater_user_id, relationship) VALUES ($1,$2,$3,$4,$5)`, [tid, roundId, r.employeeId, u, r.relationship])
    if (u) await notify(tx, { userId: u, eventType: 'feedback.requested', title: `Feedback requested by ${args.dueOn}`, body: 'Your answers are confidential; the person sees only group averages.', entityType: 'feedback_round', entityId: roundId, dedupeKey: `fb:${roundId}:${u}` })
    requested++
  }
  return { round: (await getRound(tx, roundId))!, requested }
}
export async function getRound(tx: PoolClient, id: string): Promise<Round | null> {
  return (await tx.query<Round>(`SELECT ${R_COLS} FROM feedback_rounds r WHERE r.id = $1`, [id])).rows[0] ?? null
}
export async function listRounds(tx: PoolClient, args: { employeeIds?: string[] | null; subjectEmployeeId?: string; status?: string }): Promise<Round[]> {
  return (await tx.query<Round>(`SELECT ${R_COLS} FROM feedback_rounds r WHERE ($1::uuid[] IS NULL OR r.subject_employee_id = ANY($1)) AND ($2::uuid IS NULL OR r.subject_employee_id = $2) AND ($3::text IS NULL OR r.status = $3) ORDER BY r.created_at DESC LIMIT 500`,
    [args.employeeIds ?? null, args.subjectEmployeeId ?? null, args.status ?? null])).rows
}
/** What the signed-in rater has been asked to answer (the policy hands back only their rows). */
export async function myRequests(tx: PoolClient, status?: string): Promise<Array<{ id: string; round_id: string; subject_name: string; title: string; relationship: string; due_on: string; status: string; questions: FeedbackQuestion[] }>> {
  return (await tx.query(`SELECT fr.id, fr.round_id, r.title, fr.relationship, r.due_on::text, fr.status, r.questions, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = r.subject_employee_id) AS subject_name
    FROM feedback_requests fr JOIN feedback_rounds r ON (r.tenant_id, r.id) = (fr.tenant_id, fr.round_id) WHERE r.status = 'open' AND ($1::text IS NULL OR fr.status = $1) ORDER BY r.due_on`, [status ?? null])).rows
}
export async function submitFeedback(tx: PoolClient, args: { requestId: string; answers: Record<string, number | string>; decline?: boolean }): Promise<void> {
  const req = (await tx.query<{ id: string; status: string; questions: FeedbackQuestion[]; round_status: string }>(`SELECT fr.id, fr.status, r.questions, r.status AS round_status FROM feedback_requests fr JOIN feedback_rounds r ON (r.tenant_id, r.id) = (fr.tenant_id, fr.round_id) WHERE fr.id = $1`, [args.requestId])).rows[0]
  if (!req) throw new FeedbackError('NOT_FOUND', 'no such feedback request of yours')
  if (req.round_status !== 'open') throw new FeedbackError('ROUND_CLOSED', 'this round has closed')
  if (req.status !== 'requested') throw new FeedbackError('FEEDBACK_STATE', `already ${req.status}`)
  if (args.decline) { await tx.query(`UPDATE feedback_requests SET status = 'declined', submitted_at = now() WHERE id = $1`, [req.id]); return }
  const clean: Record<string, number | string> = {}
  for (const q of req.questions) {
    const v = args.answers?.[q.id]
    if (q.type === 'rating') {
      if (v === undefined || v === null || v === '') throw new FeedbackError('VALIDATION_FAILED', `answer "${q.text}"`)
      const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > (q.scale ?? 5)) throw new FeedbackError('VALIDATION_FAILED', `"${q.text}" is 1–${q.scale ?? 5}`)
      clean[q.id] = n
    } else if (typeof v === 'string' && v.trim()) clean[q.id] = v.trim().slice(0, 2000)
  }
  await tx.query(`UPDATE feedback_requests SET status = 'submitted', answers = $2::jsonb, submitted_at = now() WHERE id = $1`, [req.id, JSON.stringify(clean)])
}
export interface AggregateRow { relationship: string; asked: number; answered: number; question_id: string | null; avg_value: number | null; texts: string[] | null; withheld: boolean }
export async function roundResults(tx: PoolClient, roundId: string): Promise<{ round: Round; byRelationship: AggregateRow[]; overall: Array<{ question_id: string; avg: number | null; n: number }> }> {
  const round = await getRound(tx, roundId)
  if (!round) throw new FeedbackError('NOT_FOUND', 'no such round')
  const rows = (await tx.query<AggregateRow & { avg_value: string | null }>(`SELECT * FROM feedback_aggregate($1)`, [roundId])).rows.map((r) => ({ ...r, avg_value: r.avg_value === null ? null : Number(r.avg_value) }))
  // overall = the mean of disclosed group averages weighted by answered count, excluding self
  const overall = round.questions.filter((q) => q.type === 'rating').map((q) => {
    const parts = rows.filter((r) => r.question_id === q.id && r.avg_value !== null && r.relationship !== 'self')
    const n = parts.reduce((s, r) => s + r.answered, 0)
    return { question_id: q.id, avg: n ? Math.round(parts.reduce((s, r) => s + r.avg_value! * r.answered, 0) / n * 100) / 100 : null, n }
  })
  return { round, byRelationship: rows, overall }
}
export async function closeRound(tx: PoolClient, roundId: string): Promise<Round> {
  const { rows } = await tx.query<{ id: string }>(`UPDATE feedback_rounds SET status = 'closed', closed_at = now() WHERE id = $1 AND status = 'open' RETURNING id`, [roundId])
  if (!rows[0]) throw new FeedbackError('NOT_FOUND', 'no such open round')
  const r = (await getRound(tx, roundId))!
  const u = await userOf(tx, r.subject_employee_id)
  if (u) await notify(tx, { userId: u, eventType: 'feedback.ready', title: 'Your 360° feedback is ready', entityType: 'feedback_round', entityId: roundId, dedupeKey: `fbdone:${roundId}` })
  return r
}
/** Nightly: raters with an open request due within 3 days or overdue, once a day. */
export async function remindFeedback(tx: PoolClient, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const soon = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10)
  const { rows } = await tx.query<{ id: string; rater_user_id: string; due_on: string; round_id: string }>(`SELECT request_id AS id, round_id, rater_user_id, due_on::text FROM feedback_pending($1::date)`, [soon])
  let n = 0
  for (const r of rows) if (await notify(tx, { userId: r.rater_user_id, eventType: 'feedback.due', title: r.due_on < today ? 'Overdue: feedback requested of you' : `Feedback due ${r.due_on}`, entityType: 'feedback_round', entityId: r.round_id, dedupeKey: `fbdue:${r.id}:${today}` })) n++
  return n
}

// ── recommendations ──────────────────────────────────────────────────────────

export interface Recommendation { id: string; employee_id: string; employee_name: string; appraisal_id: string | null; kind: string; new_designation: string | null; new_grade_code: string | null; new_annual_ctc_paise: string | null; current_annual_ctc_paise: string | null; increment_pct: string | null; effective_from: string; justification: string; status: string; approval_request_id: string | null; recommended_by_user_id: string; created_at: string; applied_at: string | null }
const REC_COLS = `x.id, x.employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = x.employee_id) AS employee_name, x.appraisal_id, x.kind, x.new_designation, x.new_grade_code, x.new_annual_ctc_paise::text, x.current_annual_ctc_paise::text, x.increment_pct::text, x.effective_from::text, x.justification, x.status, x.approval_request_id, x.recommended_by_user_id, x.created_at::text, x.applied_at::text`

export async function recommend(tx: PoolClient, cfg: ResolvedConfig, args: { employeeId: string; appraisalId?: string | null; newDesignation?: string | null; newGradeCode?: string | null; newAnnualCtcPaise?: number | null; incrementPct?: number | null; effectiveFrom: string; justification: string; recommendedByUserId: string }): Promise<Recommendation> {
  const tid = await tenantId(tx)
  if (!args.justification?.trim() || args.justification.trim().length < 10) throw new FeedbackError('VALIDATION_FAILED', 'justify the recommendation (at least a sentence)')
  const promo = Boolean(args.newDesignation || args.newGradeCode)
  let newCtc = args.newAnnualCtcPaise ?? null
  const current = (await tx.query<{ ctc: string }>(`SELECT annual_ctc_paise::text AS ctc FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to > $2::date) ORDER BY effective_from DESC LIMIT 1`, [args.employeeId, args.effectiveFrom])).rows[0]?.ctc ?? null
  let pct = args.incrementPct ?? null
  if (pct !== null && (pct <= 0 || pct > 500)) throw new FeedbackError('VALIDATION_FAILED', 'incrementPct is between 0 and 500')
  if (pct !== null && newCtc === null) {
    if (current === null) throw new FeedbackError('NO_CURRENT_COMPENSATION', 'a percentage needs a current CTC on record; give the new CTC instead')
    newCtc = Math.round(Number(current) * (1 + pct / 100) / 100) * 100   // to the rupee
  }
  if (newCtc !== null && current !== null && newCtc <= Number(current)) throw new FeedbackError('VALIDATION_FAILED', 'an increment raises the CTC')
  if (newCtc !== null && current !== null && pct === null) pct = Math.round((newCtc / Number(current) - 1) * 10000) / 100
  if (!promo && newCtc === null) throw new FeedbackError('VALIDATION_FAILED', 'nothing is recommended: give a designation/grade, a CTC or a percentage')
  if (args.appraisalId) {
    const a = (await tx.query<{ employee_id: string; final_rating: number | null }>(`SELECT employee_id, final_rating FROM appraisals WHERE id = $1`, [args.appraisalId])).rows[0]
    if (!a || a.employee_id !== args.employeeId) throw new FeedbackError('NOT_FOUND', 'no such appraisal for this person')
  }
  if ((await tx.query(`SELECT 1 FROM recommendations WHERE employee_id = $1 AND status IN ('pending','approved')`, [args.employeeId])).rowCount) throw new FeedbackError('RECOMMENDATION_OPEN', 'a recommendation is already in flight for this person')
  const kind = promo && newCtc !== null ? 'both' : promo ? 'promotion' : 'increment'
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO recommendations (tenant_id, employee_id, appraisal_id, kind, new_designation, new_grade_code, new_annual_ctc_paise, current_annual_ctc_paise, increment_pct, effective_from, justification, recommended_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
    [tid, args.employeeId, args.appraisalId ?? null, kind, args.newDesignation?.trim() || null, args.newGradeCode?.trim() || null, newCtc === null ? null : String(newCtc), current, pct, args.effectiveFrom, args.justification.trim(), args.recommendedByUserId])
  const id = rows[0]!.id
  const approval = await raiseWithPolicy(tx, { entityType: 'recommendation', entityId: id, requestedByUserId: args.recommendedByUserId, subjectEmployeeId: args.employeeId,
    magnitude: newCtc !== null && current !== null ? newCtc - Number(current) : 1, fallback: cfg.get<string>('performance.recommendation_approval_chain') as ChainCode,
    title: `${kind === 'promotion' ? 'Promotion' : kind === 'increment' ? 'Increment' : 'Promotion + increment'} · ${[args.newDesignation, pct !== null ? `+${pct}%` : null].filter(Boolean).join(' · ')} · from ${args.effectiveFrom}` })
  await tx.query(`UPDATE recommendations SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleRecommendationDecision(tx, { approvalRequestId: approval.requestId, status: 'approved', actorUserId: args.recommendedByUserId })
  return (await getRecommendation(tx, id))!
}
export async function getRecommendation(tx: PoolClient, id: string): Promise<Recommendation | null> {
  return (await tx.query<Recommendation>(`SELECT ${REC_COLS} FROM recommendations x WHERE x.id = $1`, [id])).rows[0] ?? null
}
export async function listRecommendations(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<Recommendation[]> {
  return (await tx.query<Recommendation>(`SELECT ${REC_COLS} FROM recommendations x WHERE ($1::uuid[] IS NULL OR x.employee_id = ANY($1)) AND ($2::uuid IS NULL OR x.employee_id = $2) AND ($3::text IS NULL OR x.status = $3) ORDER BY x.created_at DESC LIMIT 500`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])).rows
}
export async function withdrawRecommendation(tx: PoolClient, id: string): Promise<void> {
  const r = await tx.query(`UPDATE recommendations SET status = 'withdrawn' WHERE id = $1 AND status = 'pending'`, [id])
  if (!r.rowCount) throw new FeedbackError('NOT_FOUND', 'no such pending recommendation')
  await tx.query(`UPDATE approval_requests SET status = 'withdrawn', closed_at = now() WHERE id = (SELECT approval_request_id FROM recommendations WHERE id = $1) AND status = 'pending'`, [id])
}
/** Approved: applied at once when the date has come, else left 'approved' for the nightly job. */
export async function settleRecommendationDecision(tx: PoolClient, args: { approvalRequestId: string; status: 'approved' | 'rejected'; actorUserId: string }): Promise<{ changed: boolean }> {
  const { rows } = await tx.query<{ id: string }>(`UPDATE recommendations SET status = $2 WHERE approval_request_id = $1 AND status = 'pending' RETURNING id`, [args.approvalRequestId, args.status])
  if (!rows[0]) return { changed: false }
  const rec = (await getRecommendation(tx, rows[0].id))!
  if (args.status === 'rejected') {
    await notify(tx, { userId: rec.recommended_by_user_id, eventType: 'recommendation.decided', title: `Recommendation for ${rec.employee_name} was not approved`, entityType: 'recommendation', entityId: rec.id, dedupeKey: `rec:${rec.id}` })
    return { changed: true }
  }
  if (rec.effective_from <= new Date().toISOString().slice(0, 10)) await applyRecommendation(tx, rec, args.actorUserId)
  return { changed: true }
}
async function applyRecommendation(tx: PoolClient, rec: Recommendation, actorUserId?: string): Promise<void> {
  const reason = `${rec.kind}: appraisal recommendation${rec.appraisal_id ? ` ${rec.appraisal_id.slice(0, 8)}` : ''}`
  if (rec.new_designation || rec.new_grade_code) {
    const cur = await currentPosting(tx, rec.employee_id, rec.effective_from)
    await changeAssignment(tx, { employeeId: rec.employee_id, department: cur?.department ?? '—', designation: rec.new_designation ?? cur?.designation ?? '—', managerEmployeeId: cur?.manager_employee_id ?? undefined, locationCode: cur?.location_code ?? undefined, gradeCode: rec.new_grade_code ?? cur?.grade_code ?? undefined, effectiveFrom: rec.effective_from, reason, actorUserId })
  }
  if (rec.new_annual_ctc_paise) {
    const prev = (await tx.query<{ components: Record<string, number>; structure_code: string | null }>(`SELECT components, structure_code FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL ORDER BY effective_from DESC LIMIT 1`, [rec.employee_id])).rows[0]
    // scale the previous breakdown proportionally; a structure re-resolves it when HR next touches it
    const ratio = prev && rec.current_annual_ctc_paise ? Number(rec.new_annual_ctc_paise) / Number(rec.current_annual_ctc_paise) : null
    const components = prev && ratio ? Object.fromEntries(Object.entries(prev.components).map(([k, v]) => [k, Math.round(Number(v) * ratio / 100) * 100])) : {}
    await changeCompensation(tx, { employeeId: rec.employee_id, annualCtcPaise: Number(rec.new_annual_ctc_paise), components, structureCode: prev?.structure_code ?? undefined, effectiveFrom: rec.effective_from, reason, actorUserId })
  }
  await tx.query(`UPDATE recommendations SET status = 'applied', applied_at = now() WHERE id = $1`, [rec.id])
  const u = await userOf(tx, rec.employee_id)
  if (u) await notify(tx, { userId: u, eventType: 'people.promoted', title: rec.new_designation ? `Congratulations — you are now ${rec.new_designation}` : 'Your compensation has been revised', body: `Effective ${rec.effective_from}`, entityType: 'recommendation', entityId: rec.id, dedupeKey: `recapplied:${rec.id}` })
}
/** Nightly: approved recommendations whose date has come. */
export async function applyDueRecommendations(tx: PoolClient, today = new Date().toISOString().slice(0, 10), actorUserId?: string): Promise<number> {
  const { rows } = await tx.query<Recommendation>(`SELECT ${REC_COLS} FROM recommendations x WHERE x.status = 'approved' AND x.effective_from <= $1::date`, [today])
  for (const r of rows) await applyRecommendation(tx, r, actorUserId)
  return rows.length
}
