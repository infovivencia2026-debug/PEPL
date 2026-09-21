/**
 * Performance: goals (weighted, with check-ins), review cycles, appraisals
 * and performance improvement plans.
 *
 * An appraisal walks self_pending → manager_pending → calibration →
 * acknowledgement → closed. Only the employee writes the self review, only
 * the reviewer (or HR) the manager review, only HR calibrates, only the
 * employee acknowledges. Opening a cycle creates one appraisal per active
 * employee with the manager of record as reviewer; someone with no manager
 * is reviewed by HR. Ratings are integers on the cycle's scale.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { currentPosting } from './profile.ts'

export class PerformanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'PerformanceError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const userOf = async (tx: PoolClient, employeeId: string): Promise<string | null> =>
  (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])).rows[0]?.id ?? null

// ── cycles ───────────────────────────────────────────────────────────────────

export interface Cycle {
  id: string; name: string; period_start: string; period_end: string; self_review_due: string | null; manager_review_due: string | null
  rating_scale: number; status: 'draft' | 'open' | 'calibration' | 'closed'; created_at: string
}
const CYCLE_COLS = `id, name, period_start::text, period_end::text, self_review_due::text, manager_review_due::text, rating_scale, status, created_at::text`

export async function createCycle(tx: PoolClient, args: { name: string; periodStart: string; periodEnd: string; selfReviewDue?: string | null; managerReviewDue?: string | null; ratingScale?: number }): Promise<Cycle> {
  const tid = await tenantId(tx)
  if (!args.name?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'the cycle needs a name')
  if (args.periodEnd < args.periodStart) throw new PerformanceError('VALIDATION_FAILED', 'the period ends before it starts')
  const dup = await tx.query(`SELECT 1 FROM review_cycles WHERE lower(name) = lower($1)`, [args.name.trim()])
  if (dup.rowCount) throw new PerformanceError('CYCLE_EXISTS', 'a cycle with that name exists')
  const { rows } = await tx.query<Cycle>(
    `INSERT INTO review_cycles (tenant_id, name, period_start, period_end, self_review_due, manager_review_due, rating_scale) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${CYCLE_COLS}`,
    [tid, args.name.trim(), args.periodStart, args.periodEnd, args.selfReviewDue ?? null, args.managerReviewDue ?? null, args.ratingScale ?? 5])
  return rows[0]!
}

export async function listCycles(tx: PoolClient): Promise<Cycle[]> {
  return (await tx.query<Cycle>(`SELECT ${CYCLE_COLS} FROM review_cycles ORDER BY period_start DESC`)).rows
}
export async function getCycle(tx: PoolClient, id: string): Promise<Cycle | null> {
  return (await tx.query<Cycle>(`SELECT ${CYCLE_COLS} FROM review_cycles WHERE id = $1`, [id])).rows[0] ?? null
}

/** Opens the cycle: one appraisal per active employee, reviewer = manager of record; everyone is told. */
export async function openCycle(tx: PoolClient, cycleId: string): Promise<{ appraisals: number }> {
  const tid = await tenantId(tx)
  const c = await getCycle(tx, cycleId)
  if (!c) throw new PerformanceError('NOT_FOUND', 'no such cycle')
  if (c.status !== 'draft') throw new PerformanceError('CYCLE_NOT_DRAFT', `the cycle is ${c.status}`)
  const { rows } = await tx.query<{ id: string }>(`SELECT id FROM employees WHERE status = 'active' AND date_of_joining <= $1`, [c.period_end])
  let n = 0
  for (const e of rows) {
    const posting = await currentPosting(tx, e.id, c.period_end)
    const reviewer = posting?.manager_employee_id && posting.manager_employee_id !== e.id ? posting.manager_employee_id : null
    const ins = await tx.query(`INSERT INTO appraisals (tenant_id, cycle_id, employee_id, reviewer_employee_id) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [tid, cycleId, e.id, reviewer])
    n += ins.rowCount ?? 0
    const u = await userOf(tx, e.id)
    if (u) await notify(tx, { userId: u, eventType: 'performance.cycle.opened', title: `${c.name}: your self review is open`, body: c.self_review_due ? `Due ${c.self_review_due}` : undefined, entityType: 'review_cycle', entityId: cycleId, dedupeKey: `cycle:${cycleId}:${u}` })
  }
  await tx.query(`UPDATE review_cycles SET status = 'open' WHERE id = $1`, [cycleId])
  return { appraisals: n }
}

export async function setCycleStatus(tx: PoolClient, cycleId: string, status: 'calibration' | 'closed'): Promise<Cycle> {
  const c = await getCycle(tx, cycleId)
  if (!c) throw new PerformanceError('NOT_FOUND', 'no such cycle')
  if (status === 'calibration' && c.status !== 'open') throw new PerformanceError('CYCLE_STATE', `cannot move a ${c.status} cycle to calibration`)
  if (status === 'closed') {
    if (c.status !== 'calibration') throw new PerformanceError('CYCLE_STATE', 'close from calibration, after every rating is final')
    const open = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM appraisals WHERE cycle_id = $1 AND final_rating IS NULL`, [cycleId])
    if (Number(open.rows[0]!.n) > 0) throw new PerformanceError('RATINGS_PENDING', `${open.rows[0]!.n} appraisal(s) have no final rating`)
    await tx.query(`UPDATE appraisals SET status = 'closed' WHERE cycle_id = $1 AND status = 'acknowledgement'`, [cycleId])
  }
  await tx.query(`UPDATE review_cycles SET status = $2 WHERE id = $1`, [cycleId, status])
  return (await getCycle(tx, cycleId))!
}

// ── goals ────────────────────────────────────────────────────────────────────

export interface Goal {
  id: string; employee_id: string; cycle_id: string | null; title: string; description: string | null; kpi: string | null; target: string | null
  weight_pct: number; due_on: string | null; status: 'active' | 'completed' | 'cancelled'; progress_pct: number; set_by_user_id: string | null; created_at: string; updated_at: string
}
const GOAL_COLS = `id, employee_id, cycle_id, title, description, kpi, target, weight_pct, due_on::text, status, progress_pct, set_by_user_id, created_at::text, updated_at::text`

export async function setGoal(
  tx: PoolClient,
  args: { id?: string; employeeId: string; cycleId?: string | null; title: string; description?: string | null; kpi?: string | null; target?: string | null; weightPct?: number; dueOn?: string | null; setByUserId: string },
): Promise<Goal> {
  const tid = await tenantId(tx)
  if (!args.title?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'a goal needs a title')
  const weight = args.weightPct ?? 0
  if (!Number.isInteger(weight) || weight < 0 || weight > 100) throw new PerformanceError('VALIDATION_FAILED', 'weight is a whole percentage 0–100')
  if (args.cycleId) {
    const c = await getCycle(tx, args.cycleId)
    if (!c) throw new PerformanceError('NOT_FOUND', 'no such cycle')
    if (c.status === 'closed') throw new PerformanceError('CYCLE_STATE', 'the cycle is closed')
    const { rows } = await tx.query<{ w: string }>(
      `SELECT coalesce(sum(weight_pct), 0)::text AS w FROM goals WHERE employee_id = $1 AND cycle_id = $2 AND status = 'active' AND ($3::uuid IS NULL OR id <> $3)`,
      [args.employeeId, args.cycleId, args.id ?? null])
    if (Number(rows[0]!.w) + weight > 100) throw new PerformanceError('WEIGHT_OVER', `goal weights for the cycle would total ${Number(rows[0]!.w) + weight}%`)
  }
  if (args.id) {
    const { rows } = await tx.query<Goal>(
      `UPDATE goals SET title = $3, description = $4, kpi = $5, target = $6, weight_pct = $7, due_on = $8, cycle_id = $9, updated_at = now()
        WHERE id = $1 AND employee_id = $2 AND status = 'active' RETURNING ${GOAL_COLS}`,
      [args.id, args.employeeId, args.title.trim(), args.description ?? null, args.kpi ?? null, args.target ?? null, weight, args.dueOn ?? null, args.cycleId ?? null])
    if (!rows[0]) throw new PerformanceError('NOT_FOUND', 'no such active goal')
    return rows[0]
  }
  const { rows } = await tx.query<Goal>(
    `INSERT INTO goals (tenant_id, employee_id, cycle_id, title, description, kpi, target, weight_pct, due_on, set_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${GOAL_COLS}`,
    [tid, args.employeeId, args.cycleId ?? null, args.title.trim(), args.description ?? null, args.kpi ?? null, args.target ?? null, weight, args.dueOn ?? null, args.setByUserId])
  return rows[0]!
}

export async function checkIn(tx: PoolClient, args: { goalId: string; progressPct: number; note: string; byUserId: string }): Promise<Goal> {
  const tid = await tenantId(tx)
  if (!Number.isInteger(args.progressPct) || args.progressPct < 0 || args.progressPct > 100) throw new PerformanceError('VALIDATION_FAILED', 'progress is a whole percentage 0–100')
  if (!args.note?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'say what moved')
  const g = (await tx.query<Goal>(`SELECT ${GOAL_COLS} FROM goals WHERE id = $1`, [args.goalId])).rows[0]
  if (!g) throw new PerformanceError('NOT_FOUND', 'no such goal')
  if (g.status !== 'active') throw new PerformanceError('GOAL_CLOSED', `the goal is ${g.status}`)
  await tx.query(`INSERT INTO goal_checkins (tenant_id, goal_id, progress_pct, note, by_user_id) VALUES ($1,$2,$3,$4,$5)`, [tid, args.goalId, args.progressPct, args.note.trim(), args.byUserId])
  const { rows } = await tx.query<Goal>(
    `UPDATE goals SET progress_pct = $2, status = CASE WHEN $2 = 100 THEN 'completed' ELSE status END, updated_at = now() WHERE id = $1 RETURNING ${GOAL_COLS}`, [args.goalId, args.progressPct])
  return rows[0]!
}

export async function setGoalStatus(tx: PoolClient, goalId: string, status: 'completed' | 'cancelled'): Promise<Goal> {
  const { rows } = await tx.query<Goal>(`UPDATE goals SET status = $2, updated_at = now() WHERE id = $1 AND status = 'active' RETURNING ${GOAL_COLS}`, [goalId, status])
  if (!rows[0]) throw new PerformanceError('NOT_FOUND', 'no such active goal')
  return rows[0]
}

export async function listGoals(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; cycleId?: string; status?: string }): Promise<Goal[]> {
  return (await tx.query<Goal>(
    `SELECT ${GOAL_COLS} FROM goals WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::uuid IS NULL OR cycle_id = $3) AND ($4::text IS NULL OR status = $4)
      ORDER BY status, due_on NULLS LAST, created_at LIMIT 500`, [args.employeeIds ?? null, args.employeeId ?? null, args.cycleId ?? null, args.status ?? null])).rows
}
export async function listCheckins(tx: PoolClient, goalId: string): Promise<Array<{ id: string; progress_pct: number; note: string; by_user_id: string | null; created_at: string }>> {
  return (await tx.query(`SELECT id, progress_pct, note, by_user_id, created_at::text FROM goal_checkins WHERE goal_id = $1 ORDER BY created_at DESC`, [goalId])).rows
}

// ── appraisals ───────────────────────────────────────────────────────────────

export interface Appraisal {
  id: string; cycle_id: string; employee_id: string; reviewer_employee_id: string | null; status: string
  self_rating: number | null; self_comments: string | null; self_submitted_at: string | null
  manager_rating: number | null; manager_comments: string | null; manager_submitted_at: string | null
  final_rating: number | null; calibration_note: string | null; acknowledged_at: string | null; employee_comments: string | null
}
const APP_COLS = `id, cycle_id, employee_id, reviewer_employee_id, status, self_rating, self_comments, self_submitted_at::text, manager_rating, manager_comments, manager_submitted_at::text, final_rating, calibration_note, acknowledged_at::text, employee_comments`

export async function getAppraisal(tx: PoolClient, id: string): Promise<Appraisal | null> {
  return (await tx.query<Appraisal>(`SELECT ${APP_COLS} FROM appraisals WHERE id = $1`, [id])).rows[0] ?? null
}
export async function listAppraisals(tx: PoolClient, args: { cycleId?: string; employeeIds?: string[] | null; employeeId?: string; reviewerEmployeeId?: string; status?: string }): Promise<Appraisal[]> {
  return (await tx.query<Appraisal>(
    `SELECT ${APP_COLS} FROM appraisals WHERE ($1::uuid IS NULL OR cycle_id = $1) AND ($2::uuid[] IS NULL OR employee_id = ANY($2)) AND ($3::uuid IS NULL OR employee_id = $3)
        AND ($4::uuid IS NULL OR reviewer_employee_id = $4) AND ($5::text IS NULL OR status = $5) ORDER BY status, employee_id LIMIT 1000`,
    [args.cycleId ?? null, args.employeeIds ?? null, args.employeeId ?? null, args.reviewerEmployeeId ?? null, args.status ?? null])).rows
}

async function scaleOf(tx: PoolClient, cycleId: string): Promise<{ scale: number; status: string }> {
  const c = await getCycle(tx, cycleId)
  if (!c) throw new PerformanceError('NOT_FOUND', 'no such cycle')
  return { scale: c.rating_scale, status: c.status }
}
const checkRating = (r: number, scale: number): void => {
  if (!Number.isInteger(r) || r < 1 || r > scale) throw new PerformanceError('VALIDATION_FAILED', `rating is a whole number 1–${scale}`)
}

export async function submitSelfReview(tx: PoolClient, args: { appraisalId: string; employeeId: string; rating: number; comments: string }): Promise<Appraisal> {
  const a = await getAppraisal(tx, args.appraisalId)
  if (!a) throw new PerformanceError('NOT_FOUND', 'no such appraisal')
  if (a.employee_id !== args.employeeId) throw new PerformanceError('NOT_YOURS', 'only the employee writes the self review')
  if (a.status !== 'self_pending') throw new PerformanceError('APPRAISAL_STATE', `the appraisal is at ${a.status}`)
  const { scale, status } = await scaleOf(tx, a.cycle_id)
  if (status !== 'open') throw new PerformanceError('CYCLE_STATE', 'the cycle is not open')
  checkRating(args.rating, scale)
  if (!args.comments?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'write a few lines on the period')
  const { rows } = await tx.query<Appraisal>(
    `UPDATE appraisals SET self_rating = $2, self_comments = $3, self_submitted_at = now(), status = 'manager_pending' WHERE id = $1 RETURNING ${APP_COLS}`, [a.id, args.rating, args.comments.trim()])
  if (a.reviewer_employee_id) {
    const u = await userOf(tx, a.reviewer_employee_id)
    if (u) await notify(tx, { userId: u, eventType: 'performance.review.due', title: 'A self review is in — your review is due', entityType: 'appraisal', entityId: a.id, dedupeKey: `appraisal:${a.id}:mgr` })
  }
  return rows[0]!
}

export async function submitManagerReview(
  tx: PoolClient, args: { appraisalId: string; actorEmployeeId: string | null; isHr: boolean; rating: number; comments: string },
): Promise<Appraisal> {
  const a = await getAppraisal(tx, args.appraisalId)
  if (!a) throw new PerformanceError('NOT_FOUND', 'no such appraisal')
  const isReviewer = a.reviewer_employee_id !== null && a.reviewer_employee_id === args.actorEmployeeId
  if (!isReviewer && !args.isHr) throw new PerformanceError('NOT_REVIEWER', 'only the reviewer (or HR) writes the manager review')
  if (a.employee_id === args.actorEmployeeId) throw new PerformanceError('NOT_REVIEWER', 'you cannot review yourself')
  // an unsubmitted self review does not block the manager
  if (a.status !== 'manager_pending' && a.status !== 'self_pending') throw new PerformanceError('APPRAISAL_STATE', `the appraisal is at ${a.status}`)
  const { scale, status } = await scaleOf(tx, a.cycle_id)
  if (status !== 'open' && status !== 'calibration') throw new PerformanceError('CYCLE_STATE', 'the cycle is not open')
  checkRating(args.rating, scale)
  if (!args.comments?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'the review needs comments')
  const { rows } = await tx.query<Appraisal>(
    `UPDATE appraisals SET manager_rating = $2, manager_comments = $3, manager_submitted_at = now(), final_rating = $2, status = 'calibration' WHERE id = $1 RETURNING ${APP_COLS}`,
    [a.id, args.rating, args.comments.trim()])
  return rows[0]!
}

/** HR sets the final rating (defaults to the manager's) and releases the appraisal to the employee. */
export async function calibrate(tx: PoolClient, args: { appraisalId: string; finalRating?: number; note?: string | null }): Promise<Appraisal> {
  const a = await getAppraisal(tx, args.appraisalId)
  if (!a) throw new PerformanceError('NOT_FOUND', 'no such appraisal')
  if (a.status !== 'calibration') throw new PerformanceError('APPRAISAL_STATE', `the appraisal is at ${a.status}`)
  const { scale } = await scaleOf(tx, a.cycle_id)
  const final = args.finalRating ?? a.manager_rating
  if (final === null || final === undefined) throw new PerformanceError('VALIDATION_FAILED', 'a final rating is needed')
  checkRating(final, scale)
  if (a.manager_rating !== null && final !== a.manager_rating && !args.note?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'changing the rating needs a calibration note')
  const { rows } = await tx.query<Appraisal>(
    `UPDATE appraisals SET final_rating = $2, calibration_note = $3, status = 'acknowledgement' WHERE id = $1 RETURNING ${APP_COLS}`, [a.id, final, args.note?.trim() || null])
  const u = await userOf(tx, a.employee_id)
  if (u) await notify(tx, { userId: u, eventType: 'performance.review.released', title: 'Your appraisal is ready to read and acknowledge', entityType: 'appraisal', entityId: a.id, dedupeKey: `appraisal:${a.id}:ack` })
  return rows[0]!
}

export async function acknowledge(tx: PoolClient, args: { appraisalId: string; employeeId: string; comments?: string | null }): Promise<Appraisal> {
  const a = await getAppraisal(tx, args.appraisalId)
  if (!a) throw new PerformanceError('NOT_FOUND', 'no such appraisal')
  if (a.employee_id !== args.employeeId) throw new PerformanceError('NOT_YOURS', 'only the employee acknowledges')
  if (a.status !== 'acknowledgement') throw new PerformanceError('APPRAISAL_STATE', `the appraisal is at ${a.status}`)
  const { rows } = await tx.query<Appraisal>(`UPDATE appraisals SET acknowledged_at = now(), employee_comments = $2 WHERE id = $1 RETURNING ${APP_COLS}`, [a.id, args.comments?.trim() || null])
  return rows[0]!
}

/** What the employee may see of their own appraisal: manager's words only once released. */
export function redactForEmployee(a: Appraisal): Appraisal {
  if (['acknowledgement', 'closed'].includes(a.status)) return a
  return { ...a, manager_rating: null, manager_comments: null, final_rating: null, calibration_note: null }
}

export async function ratingDistribution(tx: PoolClient, cycleId: string): Promise<{ total: number; pending: number; byRating: Record<string, number>; byDepartment: Array<{ department: string; avg: number; n: number }> }> {
  const { rows } = await tx.query<{ final_rating: number | null; department: string | null }>(
    `SELECT a.final_rating, (SELECT department FROM employee_assignments x WHERE x.employee_id = a.employee_id AND x.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) AS department
       FROM appraisals a WHERE a.cycle_id = $1`, [cycleId])
  const byRating: Record<string, number> = {}
  const dept = new Map<string, { sum: number; n: number }>()
  let pending = 0
  for (const r of rows) {
    if (r.final_rating === null) { pending++; continue }
    byRating[String(r.final_rating)] = (byRating[String(r.final_rating)] ?? 0) + 1
    const d = dept.get(r.department ?? '—') ?? { sum: 0, n: 0 }
    d.sum += r.final_rating; d.n++; dept.set(r.department ?? '—', d)
  }
  return { total: rows.length, pending, byRating, byDepartment: [...dept].map(([department, d]) => ({ department, avg: Math.round((d.sum / d.n) * 100) / 100, n: d.n })) }
}

// ── performance improvement plans ────────────────────────────────────────────

export interface Pip {
  id: string; employee_id: string; opened_by_user_id: string | null; reason: string; objectives: Array<{ title: string; measure?: string; dueOn?: string }>
  starts_on: string; review_on: string; ends_on: string; status: 'active' | 'extended' | 'closed_success' | 'closed_exit'
  reviews: Array<{ on: string; byUserId: string; note: string; verdict: string }>; outcome: string | null; closed_at: string | null; created_at: string
}
const PIP_COLS = `id, employee_id, opened_by_user_id, reason, objectives, starts_on::text, review_on::text, ends_on::text, status, reviews, outcome, closed_at::text, created_at::text`

export async function openPip(
  tx: PoolClient, args: { employeeId: string; openedByUserId: string; reason: string; objectives: Pip['objectives']; startsOn: string; reviewOn: string; endsOn: string },
): Promise<Pip> {
  const tid = await tenantId(tx)
  if (!args.reason?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'a PIP states its reason')
  if (!args.objectives?.length || args.objectives.some((o) => !o.title?.trim())) throw new PerformanceError('VALIDATION_FAILED', 'at least one objective, each with a title')
  if (args.endsOn < args.startsOn || args.reviewOn < args.startsOn || args.reviewOn > args.endsOn) throw new PerformanceError('VALIDATION_FAILED', 'review date must fall within the plan')
  const live = await tx.query(`SELECT 1 FROM pips WHERE employee_id = $1 AND status IN ('active','extended')`, [args.employeeId])
  if (live.rowCount) throw new PerformanceError('PIP_OPEN', 'this person already has a live plan')
  const { rows } = await tx.query<Pip>(
    `INSERT INTO pips (tenant_id, employee_id, opened_by_user_id, reason, objectives, starts_on, review_on, ends_on) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING ${PIP_COLS}`,
    [tid, args.employeeId, args.openedByUserId, args.reason.trim(), JSON.stringify(args.objectives), args.startsOn, args.reviewOn, args.endsOn])
  const u = await userOf(tx, args.employeeId)
  if (u) await notify(tx, { userId: u, eventType: 'performance.pip.opened', title: 'A performance improvement plan has been opened with you', body: `Runs ${args.startsOn} to ${args.endsOn}; review on ${args.reviewOn}`, entityType: 'pip', entityId: rows[0]!.id, dedupeKey: `pip:${rows[0]!.id}` })
  return rows[0]!
}

export async function reviewPip(
  tx: PoolClient, args: { pipId: string; byUserId: string; note: string; verdict: 'continue' | 'extend' | 'close_success' | 'close_exit'; extendTo?: string | null; nextReviewOn?: string | null },
): Promise<Pip> {
  if (!args.note?.trim()) throw new PerformanceError('VALIDATION_FAILED', 'the review needs a note')
  const p = (await tx.query<Pip>(`SELECT ${PIP_COLS} FROM pips WHERE id = $1`, [args.pipId])).rows[0]
  if (!p) throw new PerformanceError('NOT_FOUND', 'no such plan')
  if (!['active', 'extended'].includes(p.status)) throw new PerformanceError('PIP_CLOSED', `the plan is ${p.status}`)
  const review = { on: new Date().toISOString().slice(0, 10), byUserId: args.byUserId, note: args.note.trim(), verdict: args.verdict }
  let sql = `UPDATE pips SET reviews = reviews || $2::jsonb`
  const params: unknown[] = [p.id, JSON.stringify([review])]
  if (args.verdict === 'extend') {
    if (!args.extendTo || args.extendTo <= p.ends_on) throw new PerformanceError('VALIDATION_FAILED', 'extension must end after the current end date')
    params.push(args.extendTo, args.nextReviewOn ?? args.extendTo)
    sql += `, status = 'extended', ends_on = $3, review_on = $4`
  } else if (args.verdict === 'continue') {
    params.push(args.nextReviewOn ?? p.ends_on)
    sql += `, review_on = $3`
  } else {
    sql += `, status = '${args.verdict === 'close_success' ? 'closed_success' : 'closed_exit'}', outcome = $2::jsonb->0->>'note', closed_at = now()`
  }
  const { rows } = await tx.query<Pip>(`${sql} WHERE id = $1 RETURNING ${PIP_COLS}`, params)
  return rows[0]!
}

export async function listPips(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<Pip[]> {
  return (await tx.query<Pip>(
    `SELECT ${PIP_COLS} FROM pips WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT 200`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])).rows
}
