/**
 * Learning-lite and recognition.
 *
 * Courses with nominations, completion and expiry; a mandatory course
 * nominates its whole audience (and new joiners, nightly). Compliance view:
 * who is overdue, whose certification lapses. Recognition: badges with
 * points, a company feed, a points balance payroll can pay out.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { currentPosting } from './profile.ts'

export class LearningError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'LearningError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const userOf = async (tx: PoolClient, employeeId: string): Promise<string | null> => (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])).rows[0]?.id ?? null
const addMonths = (d: string, m: number): string => { const x = new Date(d + 'T00:00:00Z'); x.setUTCMonth(x.getUTCMonth() + m); return x.toISOString().slice(0, 10) }

export interface Course { id: string; code: string; title: string; description: string | null; mode: string; link: string | null; duration_min: number | null; mandatory: boolean; audience: { departments?: string[]; designations?: string[]; joinedAfter?: string }; validity_months: number | null; due_days: number; status: string }
const C_COLS = `id, code, title, description, mode, link, duration_min, mandatory, audience, validity_months, due_days, status`

export async function upsertCourse(tx: PoolClient, c: { code: string; title: string; description?: string | null; mode?: Course['mode']; link?: string | null; durationMin?: number | null; mandatory?: boolean; audience?: Course['audience']; validityMonths?: number | null; dueDays?: number }): Promise<Course> {
  const tid = await tenantId(tx)
  const code = c.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32)
  if (!code || !c.title?.trim()) throw new LearningError('VALIDATION_FAILED', 'code and title are required')
  if (c.mode && !['online', 'classroom', 'external', 'self_paced'].includes(c.mode)) throw new LearningError('VALIDATION_FAILED', 'mode is online, classroom, external or self_paced')
  const { rows } = await tx.query<Course>(
    `INSERT INTO courses (tenant_id, code, title, description, mode, link, duration_min, mandatory, audience, validity_months, due_days) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)
     ON CONFLICT (tenant_id, code) DO UPDATE SET title = EXCLUDED.title, description = EXCLUDED.description, mode = EXCLUDED.mode, link = EXCLUDED.link, duration_min = EXCLUDED.duration_min, mandatory = EXCLUDED.mandatory, audience = EXCLUDED.audience, validity_months = EXCLUDED.validity_months, due_days = EXCLUDED.due_days, status = 'active'
     RETURNING ${C_COLS}`,
    [tid, code, c.title.trim(), c.description ?? null, c.mode ?? 'online', c.link ?? null, c.durationMin ?? null, c.mandatory ?? false, JSON.stringify(c.audience ?? {}), c.validityMonths ?? null, c.dueDays ?? 30])
  return rows[0]!
}
export async function listCourses(tx: PoolClient, includeRetired = false): Promise<Course[]> {
  return (await tx.query<Course>(`SELECT ${C_COLS} FROM courses WHERE $1 OR status = 'active' ORDER BY mandatory DESC, title`, [includeRetired])).rows
}
export async function retireCourse(tx: PoolClient, code: string): Promise<void> {
  const r = await tx.query(`UPDATE courses SET status = 'retired' WHERE code = $1 AND status = 'active'`, [code])
  if (!r.rowCount) throw new LearningError('NOT_FOUND', 'no such active course')
}

async function audienceOf(tx: PoolClient, a: Course['audience']): Promise<string[]> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT e.id FROM employees e LEFT JOIN LATERAL (SELECT department, designation FROM employee_assignments x WHERE x.employee_id = e.id AND x.superseded_at IS NULL AND x.effective_to IS NULL ORDER BY effective_from DESC LIMIT 1) p ON true
      WHERE e.status = 'active' AND e.erased_at IS NULL AND ($1::text[] IS NULL OR p.department = ANY($1)) AND ($2::text[] IS NULL OR p.designation = ANY($2)) AND ($3::date IS NULL OR e.date_of_joining >= $3)`,
    [a.departments?.length ? a.departments : null, a.designations?.length ? a.designations : null, a.joinedAfter ?? null])
  return rows.map((r) => r.id)
}

export interface Nomination { id: string; course_id: string; course_code: string; course_title: string; employee_id: string; employee_name: string; due_on: string; status: string; started_at: string | null; completed_at: string | null; score: number | null; certificate_document_id: string | null; valid_until: string | null; note: string | null }
const N_COLS = `n.id, n.course_id, c.code AS course_code, c.title AS course_title, n.employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = n.employee_id) AS employee_name, n.due_on::text, n.status, n.started_at::text, n.completed_at::text, n.score, n.certificate_document_id, n.valid_until::text, n.note`
const N_FROM = `FROM course_nominations n JOIN courses c ON (c.tenant_id, c.id) = (n.tenant_id, n.course_id)`

/** Nominate people; anyone with a live nomination or a still-valid completion is skipped. Returns how many were told. */
export async function nominate(tx: PoolClient, args: { courseCode: string; employeeIds: string[]; nominatedByUserId?: string | null; dueOn?: string }): Promise<number> {
  const tid = await tenantId(tx)
  const c = (await listCourses(tx)).find((x) => x.code === args.courseCode)
  if (!c) throw new LearningError('NOT_FOUND', 'no such course')
  const today = new Date().toISOString().slice(0, 10)
  const dueOn = args.dueOn ?? new Date(Date.parse(today) + c.due_days * 86_400_000).toISOString().slice(0, 10)
  let n = 0
  for (const e of new Set(args.employeeIds)) {
    const live = await tx.query(`SELECT 1 FROM course_nominations WHERE course_id = $1 AND employee_id = $2 AND (status IN ('assigned','in_progress') OR (status = 'completed' AND (valid_until IS NULL OR valid_until >= $3::date)))`, [c.id, e, today])
    if (live.rowCount) continue
    const { rows } = await tx.query<{ id: string }>(`INSERT INTO course_nominations (tenant_id, course_id, employee_id, nominated_by_user_id, due_on) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tid, c.id, e, args.nominatedByUserId ?? null, dueOn])
    const u = await userOf(tx, e)
    if (u) await notify(tx, { userId: u, eventType: 'learning.nominated', title: `${c.mandatory ? 'Required training' : 'Training'}: ${c.title}`, body: `Complete by ${dueOn}${c.link ? ` · ${c.link}` : ''}`, entityType: 'course_nomination', entityId: rows[0]!.id, dedupeKey: `nom:${rows[0]!.id}` })
    n++
  }
  return n
}
/** Nightly: every mandatory course reaches its whole audience (new joiners included); expired certifications are re-nominated. */
export async function nominateMandatory(tx: PoolClient): Promise<number> {
  let n = 0
  for (const c of (await listCourses(tx)).filter((x) => x.mandatory)) n += await nominate(tx, { courseCode: c.code, employeeIds: await audienceOf(tx, c.audience) })
  return n
}

export async function startCourse(tx: PoolClient, args: { nominationId: string; employeeId: string }): Promise<void> {
  const r = await tx.query(`UPDATE course_nominations SET status = 'in_progress', started_at = coalesce(started_at, now()) WHERE id = $1 AND employee_id = $2 AND status = 'assigned'`, [args.nominationId, args.employeeId])
  if (!r.rowCount) throw new LearningError('NOT_FOUND', 'no such assigned course of yours')
}
export async function completeCourse(tx: PoolClient, args: { nominationId: string; employeeId?: string; score?: number | null; passed?: boolean; certificateDocumentId?: string | null; note?: string | null; actorUserId: string; byTrainer?: boolean }): Promise<Nomination> {
  const n = (await tx.query<Nomination & { validity_months: number | null }>(`SELECT ${N_COLS}, c.validity_months ${N_FROM} WHERE n.id = $1 FOR UPDATE OF n`, [args.nominationId])).rows[0]
  if (!n) throw new LearningError('NOT_FOUND', 'no such nomination')
  if (!args.byTrainer && n.employee_id !== args.employeeId) throw new LearningError('NOT_YOURS', 'only the nominee or a trainer/HR completes it')
  if (!['assigned', 'in_progress'].includes(n.status)) throw new LearningError('NOMINATION_STATE', `already ${n.status}`)
  if (args.score !== undefined && args.score !== null && (!Number.isInteger(args.score) || args.score < 0 || args.score > 100)) throw new LearningError('VALIDATION_FAILED', 'score is 0–100')
  const passed = args.passed ?? true
  const today = new Date().toISOString().slice(0, 10)
  const { rows } = await tx.query<Nomination>(
    `UPDATE course_nominations SET status = $2, completed_at = now(), score = $3, certificate_document_id = $4, valid_until = $5, note = $6 WHERE id = $1 RETURNING ${N_COLS.replace(/n\./g, 'course_nominations.').replace(/c\.code AS course_code, c\.title AS course_title, /, '')}, (SELECT code FROM courses WHERE id = course_nominations.course_id) AS course_code, (SELECT title FROM courses WHERE id = course_nominations.course_id) AS course_title`,
    [n.id, passed ? 'completed' : 'failed', args.score ?? null, args.certificateDocumentId ?? null, passed && n.validity_months ? addMonths(today, n.validity_months) : null, args.note ?? null])
  return rows[0]!
}
export async function waive(tx: PoolClient, nominationId: string, note: string): Promise<void> {
  if (!note?.trim()) throw new LearningError('VALIDATION_FAILED', 'say why it is waived')
  const r = await tx.query(`UPDATE course_nominations SET status = 'waived', note = $2 WHERE id = $1 AND status IN ('assigned','in_progress')`, [nominationId, note.trim()])
  if (!r.rowCount) throw new LearningError('NOT_FOUND', 'no such open nomination')
}
export async function listNominations(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; courseCode?: string; status?: string }): Promise<Nomination[]> {
  return (await tx.query<Nomination>(
    `SELECT ${N_COLS} ${N_FROM} WHERE ($1::uuid[] IS NULL OR n.employee_id = ANY($1)) AND ($2::uuid IS NULL OR n.employee_id = $2) AND ($3::text IS NULL OR c.code = $3) AND ($4::text IS NULL OR n.status = $4) ORDER BY n.due_on, n.status LIMIT 1000`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.courseCode ?? null, args.status ?? null])).rows
}
/** The compliance view: per mandatory course, completed / open / overdue / expiring within 60 days. */
export async function trainingCompliance(tx: PoolClient, today = new Date().toISOString().slice(0, 10)): Promise<Array<{ course: string; title: string; audience: number; completed: number; open: number; overdue: number; expiring: number; overdueNames: string[] }>> {
  const out: Array<{ course: string; title: string; audience: number; completed: number; open: number; overdue: number; expiring: number; overdueNames: string[] }> = []
  const soon = new Date(Date.parse(today) + 60 * 86_400_000).toISOString().slice(0, 10)
  for (const c of (await listCourses(tx)).filter((x) => x.mandatory)) {
    const audience = await audienceOf(tx, c.audience)
    const noms = await listNominations(tx, { courseCode: c.code })
    const byEmp = new Map<string, Nomination>()
    for (const n of noms) { const cur = byEmp.get(n.employee_id); if (!cur || n.due_on > cur.due_on) byEmp.set(n.employee_id, n) }
    let completed = 0, open = 0, overdue = 0, expiring = 0; const overdueNames: string[] = []
    for (const e of audience) {
      const n = byEmp.get(e)
      if (!n || ['assigned', 'in_progress', 'failed'].includes(n.status)) { if (n && n.due_on < today) { overdue++; overdueNames.push(n.employee_name) } else open++; continue }
      if (n.status === 'completed') { if (n.valid_until && n.valid_until < today) { overdue++; overdueNames.push(n.employee_name) } else { completed++; if (n.valid_until && n.valid_until <= soon) expiring++ } }
    }
    out.push({ course: c.code, title: c.title, audience: audience.length, completed, open, overdue, expiring, overdueNames })
  }
  return out
}

// ── recognition ──────────────────────────────────────────────────────────────

export interface Badge { id: string; code: string; name: string; description: string | null; points: number; manager_only: boolean; status: string }
export const DEFAULT_BADGES: Array<Omit<Badge, 'id' | 'status'>> = [
  { code: 'THANK_YOU', name: 'Thank you', description: 'A simple thanks for help', points: 0, manager_only: false },
  { code: 'TEAM_PLAYER', name: 'Team player', description: 'Went out of the way for the team', points: 10, manager_only: false },
  { code: 'CUSTOMER_HERO', name: 'Customer hero', description: 'Made a customer\'s day', points: 20, manager_only: false },
  { code: 'STAR_OF_MONTH', name: 'Star of the month', description: 'Manager\'s pick', points: 100, manager_only: true },
]
export async function listBadges(tx: PoolClient): Promise<Badge[]> {
  const tid = await tenantId(tx)
  if ((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM recognition_badges`)).rows[0]!.n === '0') {
    for (const b of DEFAULT_BADGES) await tx.query(`INSERT INTO recognition_badges (tenant_id, code, name, description, points, manager_only) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, code) DO NOTHING`, [tid, b.code, b.name, b.description, b.points, b.manager_only])
  }
  return (await tx.query<Badge>(`SELECT id, code, name, description, points, manager_only, status FROM recognition_badges WHERE status = 'active' ORDER BY points, name`)).rows
}
export async function upsertBadge(tx: PoolClient, b: { code: string; name: string; description?: string | null; points?: number; managerOnly?: boolean }): Promise<Badge> {
  const tid = await tenantId(tx)
  const code = b.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 32)
  if (!code || !b.name?.trim()) throw new LearningError('VALIDATION_FAILED', 'code and name are required')
  const { rows } = await tx.query<Badge>(`INSERT INTO recognition_badges (tenant_id, code, name, description, points, manager_only) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description, points = EXCLUDED.points, manager_only = EXCLUDED.manager_only, status = 'active' RETURNING id, code, name, description, points, manager_only, status`,
    [tid, code, b.name.trim(), b.description ?? null, b.points ?? 0, b.managerOnly ?? false])
  return rows[0]!
}

export interface Recognition { id: string; badge_code: string; badge_name: string; to_employee_id: string; to_name: string; from_user_id: string; from_name: string; message: string; points: number; visibility: string; created_at: string }
const R_COLS = `r.id, b.code AS badge_code, b.name AS badge_name, r.to_employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = r.to_employee_id) AS to_name, r.from_user_id, (SELECT full_name FROM app_users u WHERE u.id = r.from_user_id) AS from_name, r.message, r.points, r.visibility, r.created_at::text`

export async function recognise(tx: PoolClient, args: { badgeCode: string; toEmployeeId: string; fromUserId: string; fromEmployeeId: string | null; isManager: boolean; message: string; visibility?: Recognition['visibility'] }): Promise<Recognition> {
  const tid = await tenantId(tx)
  const b = (await listBadges(tx)).find((x) => x.code === args.badgeCode)
  if (!b) throw new LearningError('NOT_FOUND', 'no such badge')
  if (b.manager_only && !args.isManager) throw new LearningError('BADGE_MANAGER_ONLY', 'only a manager gives this badge')
  if (args.fromEmployeeId && args.fromEmployeeId === args.toEmployeeId) throw new LearningError('VALIDATION_FAILED', 'recognise someone else')
  if (!args.message?.trim() || args.message.trim().length < 5) throw new LearningError('VALIDATION_FAILED', 'say what it was for')
  // the same giver cannot shower the same person: one badge per pair per week
  const recent = await tx.query(`SELECT 1 FROM recognitions WHERE badge_id = $1 AND to_employee_id = $2 AND from_user_id = $3 AND created_at > now() - interval '7 days'`, [b.id, args.toEmployeeId, args.fromUserId])
  if (recent.rowCount) throw new LearningError('RECOGNITION_TOO_SOON', 'you gave this person that badge this week already')
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO recognitions (tenant_id, badge_id, to_employee_id, from_user_id, message, points, visibility) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [tid, b.id, args.toEmployeeId, args.fromUserId, args.message.trim().slice(0, 500), b.points, args.visibility ?? 'company'])
  if (b.points > 0) await tx.query(`INSERT INTO points_ledger (tenant_id, employee_id, delta, kind, ref_id, note) VALUES ($1,$2,$3,'recognition',$4,$5)`, [tid, args.toEmployeeId, b.points, rows[0]!.id, b.name])
  const u = await userOf(tx, args.toEmployeeId)
  if (u) await notify(tx, { userId: u, eventType: 'recognition.received', title: `You received "${b.name}"${b.points ? ` (+${b.points} points)` : ''}`, body: args.message.trim().slice(0, 200), entityType: 'recognition', entityId: rows[0]!.id, dedupeKey: `recog:${rows[0]!.id}` })
  return (await tx.query<Recognition>(`SELECT ${R_COLS} FROM recognitions r JOIN recognition_badges b ON (b.tenant_id, b.id) = (r.tenant_id, r.badge_id) WHERE r.id = $1`, [rows[0]!.id])).rows[0]!
}
export async function recognitionFeed(tx: PoolClient, args: { employeeId?: string; limit?: number; viewerEmployeeId?: string | null; viewerScopeIds?: string[] | null }): Promise<Recognition[]> {
  return (await tx.query<Recognition>(
    `SELECT ${R_COLS} FROM recognitions r JOIN recognition_badges b ON (b.tenant_id, b.id) = (r.tenant_id, r.badge_id)
      WHERE ($1::uuid IS NULL OR r.to_employee_id = $1)
        AND (r.visibility = 'company' OR r.to_employee_id = $2 OR r.from_user_id = current_app_user() OR (r.visibility = 'team' AND ($3::uuid[] IS NULL OR r.to_employee_id = ANY($3))))
      ORDER BY r.created_at DESC LIMIT $4`, [args.employeeId ?? null, args.viewerEmployeeId ?? null, args.viewerScopeIds ?? null, args.limit ?? 50])).rows
}
export async function pointsBalance(tx: PoolClient, employeeId: string): Promise<{ balance: number; earned: number; redeemed: number }> {
  const r = (await tx.query<{ balance: string; earned: string; redeemed: string }>(`SELECT coalesce(sum(delta),0)::text AS balance, coalesce(sum(delta) FILTER (WHERE delta > 0),0)::text AS earned, coalesce(-sum(delta) FILTER (WHERE delta < 0),0)::text AS redeemed FROM points_ledger WHERE employee_id = $1`, [employeeId])).rows[0]!
  return { balance: Number(r.balance), earned: Number(r.earned), redeemed: Number(r.redeemed) }
}
export async function redeemPoints(tx: PoolClient, args: { employeeId: string; points: number; kind: 'redemption' | 'payout' | 'adjustment'; note: string }): Promise<{ balance: number }> {
  const tid = await tenantId(tx)
  if (!Number.isInteger(args.points) || args.points === 0) throw new LearningError('VALIDATION_FAILED', 'points is a non-zero whole number')
  if (!args.note?.trim()) throw new LearningError('VALIDATION_FAILED', 'say what for')
  const bal = await pointsBalance(tx, args.employeeId)
  const delta = args.kind === 'adjustment' ? args.points : -Math.abs(args.points)
  if (bal.balance + delta < 0) throw new LearningError('INSUFFICIENT_POINTS', `only ${bal.balance} points available`)
  await tx.query(`INSERT INTO points_ledger (tenant_id, employee_id, delta, kind, note) VALUES ($1,$2,$3,$4,$5)`, [tid, args.employeeId, delta, args.kind, args.note.trim()])
  return { balance: bal.balance + delta }
}
export async function leaderboard(tx: PoolClient, args: { from: string; to: string; limit?: number }): Promise<Array<{ employeeId: string; name: string; points: number; badges: number }>> {
  const { rows } = await tx.query<{ employee_id: string; name: string; points: string; badges: string }>(
    `SELECT r.to_employee_id AS employee_id, concat_ws(' ', e.first_name, e.last_name) AS name, sum(r.points)::text AS points, count(*)::text AS badges
       FROM recognitions r JOIN employees e ON e.id = r.to_employee_id WHERE r.created_at::date BETWEEN $1::date AND $2::date AND r.visibility <> 'private'
      GROUP BY r.to_employee_id, e.first_name, e.last_name ORDER BY sum(r.points) DESC, count(*) DESC LIMIT $3`, [args.from, args.to, args.limit ?? 10])
  return rows.map((r) => ({ employeeId: r.employee_id, name: r.name, points: Number(r.points), badges: Number(r.badges) }))
}
export { currentPosting }

/** Nightly: nudge nominees due within 3 days or overdue, and anyone whose certification lapses within 30 days. Once per day per nomination. */
export async function remindTraining(tx: PoolClient, today = new Date().toISOString().slice(0, 10)): Promise<number> {
  const soon = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10)
  const lapse = new Date(Date.parse(today) + 30 * 86_400_000).toISOString().slice(0, 10)
  const { rows } = await tx.query<{ id: string; employee_id: string; title: string; due_on: string; valid_until: string | null; status: string }>(
    `SELECT n.id, n.employee_id, c.title, n.due_on::text, n.valid_until::text, n.status FROM course_nominations n JOIN courses c ON (c.tenant_id, c.id) = (n.tenant_id, n.course_id)
      WHERE c.status = 'active' AND ((n.status IN ('assigned','in_progress') AND n.due_on <= $1::date) OR (n.status = 'completed' AND c.mandatory AND n.valid_until BETWEEN $2::date AND $3::date))`, [soon, today, lapse])
  let n = 0
  for (const r of rows) {
    const u = await userOf(tx, r.employee_id)
    if (!u) continue
    const expiring = r.status === 'completed'
    const sent = await notify(tx, { userId: u, eventType: expiring ? 'learning.expiring' : r.due_on < today ? 'learning.overdue' : 'learning.due',
      title: expiring ? `Your ${r.title} certification lapses on ${r.valid_until}` : r.due_on < today ? `Overdue: ${r.title}` : `Due ${r.due_on}: ${r.title}`,
      body: expiring ? 'You will be re-nominated when it expires; finish the refresher early to stay covered.' : 'Open My learning to start or finish it.',
      entityType: 'course_nomination', entityId: r.id, dedupeKey: `learn:${r.id}:${today}` })
    if (sent) n++
  }
  return n
}
