/**
 * The exit workflow before the money: the employee resigns; HR accepts it
 * into a separation (with the notice period from the record, or waived);
 * five areas clear the person (manager, IT, finance, admin, HR), each able
 * to record a recovery that the F&F will deduct; the exit interview is
 * captured for HR only; and the relieving-cum-experience letter is issued
 * once the settlement has been paid.
 *
 * Clearance GATES the settlement: a separation with a pending clearance is
 * not picked up by the payroll freeze, so a laptop still out cannot be
 * forgotten in the final pay.
 */
import type { PoolClient } from 'pg'
import { openReturnables } from '../work/assets.ts'
import { initiateSeparation, getSeparation, type Separation, type SeparationReason } from '../payroll/exit.ts'
import { templateForTrigger, resolveAssignees } from '../work/templates.ts'
import { instantiateTemplate } from '../work/tasks.ts'
import { notify } from '../comms/index.ts'
import { putDocument, type DocumentMeta } from '../documents/index.ts'
import { PdfPage, renderPdf, PAGE_HEIGHT } from '../pdf/document.ts'
import { today as localToday } from '../lib/timezone.ts'

/** The company calendar used when a caller does not pass one (the product is built for India). */
const DEFAULT_COMPANY_ZONE = 'Asia/Kolkata'

export class ExitWorkflowError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'ExitWorkflowError' }
}

const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const addDays = (d: string, n: number): string => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10) }

// ── resignation ──────────────────────────────────────────────────────────────

export interface Resignation {
  id: string; employee_id: string; submitted_on: string; requested_last_day: string; reason: string; reason_category: string
  status: string; separation_id: string | null; decided_at: string | null; decision_note: string | null
  /** Derived from the record: the notice the contract asks for, and the earliest day it allows. */
  notice_period_days: number; earliest_last_day: string
}
const RES_COLS = `r.id, r.employee_id, r.submitted_on::text, r.requested_last_day::text, r.reason, r.reason_category, r.status, r.separation_id,
  r.decided_at::text, r.decision_note, e.notice_period_days, (r.submitted_on + e.notice_period_days)::text AS earliest_last_day`
const RES_FROM = `FROM resignations r JOIN employees e ON (e.tenant_id, e.id) = (r.tenant_id, r.employee_id)`

export async function getResignation(tx: PoolClient, id: string): Promise<Resignation | null> {
  const { rows } = await tx.query<Resignation>(`SELECT ${RES_COLS} ${RES_FROM} WHERE r.id = $1`, [id])
  return rows[0] ?? null
}

export async function listResignations(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<Resignation[]> {
  const { rows } = await tx.query<Resignation>(
    `SELECT ${RES_COLS} ${RES_FROM}
      WHERE ($1::uuid[] IS NULL OR r.employee_id = ANY($1)) AND ($2::uuid IS NULL OR r.employee_id = $2) AND ($3::text IS NULL OR r.status = $3)
      ORDER BY r.submitted_on DESC, r.created_at DESC LIMIT 200`, [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])
  return rows
}

/** The employee resigns. The requested last day may be earlier than notice allows — HR decides whether to waive. */
export async function submitResignation(
  tx: PoolClient,
  // `today` is the COMPANY's calendar date. It was read from the database (CURRENT_DATE, UTC): for the
  // 5.5 hours after midnight in India that is still yesterday, so a last day already past was accepted
  // and the resignation was stamped submitted a day early, with notice counted from it. Business dates
  // follow the company's calendar; timestamps stay UTC instants.
  args: { employeeId: string; requestedLastDay: string; reason: string; reasonCategory?: Resignation['reason_category']; today?: string },
): Promise<Resignation> {
  const tid = await tenantId(tx)
  const emp = (await tx.query<{ status: string; notice_period_days: number }>(`SELECT status, notice_period_days FROM employees WHERE id = $1`, [args.employeeId])).rows[0]
  if (!emp) throw new ExitWorkflowError('NOT_FOUND', 'no such employee')
  if (emp.status === 'exited') throw new ExitWorkflowError('ALREADY_EXITED', 'this employee has already left')
  if (!args.reason?.trim()) throw new ExitWorkflowError('VALIDATION_FAILED', 'a reason is required')
  const today = args.today ?? localToday(DEFAULT_COMPANY_ZONE)
  if (args.requestedLastDay < today) throw new ExitWorkflowError('VALIDATION_FAILED', 'the last day cannot be in the past')
  const open = await tx.query(`SELECT 1 FROM resignations WHERE employee_id = $1 AND status = 'submitted'`, [args.employeeId])
  if (open.rowCount) throw new ExitWorkflowError('RESIGNATION_OPEN', 'a resignation is already awaiting HR')
  const sep = await tx.query(`SELECT 1 FROM employee_separations WHERE employee_id = $1 AND status IN ('initiated','in_payroll')`, [args.employeeId])
  if (sep.rowCount) throw new ExitWorkflowError('SEPARATION_OPEN', 'an exit is already in progress for this employee')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO resignations (tenant_id, employee_id, submitted_on, requested_last_day, reason, reason_category) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tid, args.employeeId, today, args.requestedLastDay, args.reason.trim().slice(0, 4000), args.reasonCategory ?? 'other'])
  // the manager and HR hear about it
  const people = await tx.query<{ id: string }>(
    `SELECT u.id FROM app_users u WHERE u.status = 'active' AND (
        u.employee_id = (SELECT manager_employee_id FROM employee_assignments a WHERE a.employee_id = $1 AND a.superseded_at IS NULL AND (a.effective_to IS NULL OR a.effective_to > CURRENT_DATE) ORDER BY a.effective_from DESC LIMIT 1)
        OR EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role IN ('hr_admin')))`, [args.employeeId])
  for (const p of people.rows) {
    await notify(tx, { userId: p.id, eventType: 'exit.resignation.submitted', title: 'A resignation has been submitted',
      body: `Requested last day ${args.requestedLastDay}`, entityType: 'resignation', entityId: rows[0]!.id, dedupeKey: `resignation:${rows[0]!.id}:${p.id}` })
  }
  return (await getResignation(tx, rows[0]!.id))!
}

export async function withdrawResignation(tx: PoolClient, id: string, employeeId: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE resignations SET status = 'withdrawn', decided_at = now() WHERE id = $1 AND employee_id = $2 AND status = 'submitted'`, [id, employeeId])
  if (!rowCount) throw new ExitWorkflowError('RESIGNATION_NOT_OPEN', 'only a resignation still awaiting HR can be withdrawn')
}

/**
 * HR accepts: the separation is created with the last working day HR agrees
 * (the requested one, or the notice-complete one), notice waived or charged,
 * the five clearances opened, and the offboarding checklist started.
 */
export async function acceptResignation(
  tx: PoolClient,
  args: { resignationId: string; lastWorkingDay?: string; noticeWaived?: boolean; note?: string; actorUserId: string },
): Promise<{ resignation: Resignation; separation: Separation; tasks: number }> {
  const r = await getResignation(tx, args.resignationId)
  if (!r) throw new ExitWorkflowError('NOT_FOUND', 'no such resignation')
  if (r.status !== 'submitted') throw new ExitWorkflowError('RESIGNATION_NOT_OPEN', `this resignation is ${r.status}`)
  const lastDay = args.lastWorkingDay ?? (r.requested_last_day >= r.earliest_last_day ? r.requested_last_day : r.earliest_last_day)
  const separation = await initiateSeparation(tx, {
    employeeId: r.employee_id, reason: 'resignation', lastWorkingDay: lastDay, initiatedOn: r.submitted_on,
    noticeDaysRequired: r.notice_period_days, noticeWaived: args.noticeWaived ?? lastDay >= r.earliest_last_day,
    note: args.note ?? r.reason, actorUserId: args.actorUserId,
  })
  await tx.query(`UPDATE employee_separations SET resignation_id = $2 WHERE id = $1`, [separation.id, r.id])
  await tx.query(`UPDATE resignations SET status = 'accepted', separation_id = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4 WHERE id = $1`,
    [r.id, separation.id, args.actorUserId, args.note ?? null])
  const tasks = await openClearances(tx, separation, lastDay)
  const user = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [r.employee_id])).rows[0]?.id
  if (user) await notify(tx, { userId: user, eventType: 'exit.resignation.accepted', title: 'Your resignation has been accepted', body: `Last working day ${lastDay}`, entityType: 'separation', entityId: separation.id, dedupeKey: `resignation-accepted:${r.id}` })
  return { resignation: (await getResignation(tx, r.id))!, separation, tasks }
}

export async function declineResignation(tx: PoolClient, id: string, note: string, actorUserId: string): Promise<void> {
  if (!note?.trim()) throw new ExitWorkflowError('VALIDATION_FAILED', 'say why (retained, counter-offer, …)')
  const { rows } = await tx.query<{ employee_id: string }>(
    `UPDATE resignations SET status = 'declined', decided_by_user_id = $2, decided_at = now(), decision_note = $3 WHERE id = $1 AND status = 'submitted' RETURNING employee_id`, [id, actorUserId, note.trim()])
  if (!rows[0]) throw new ExitWorkflowError('RESIGNATION_NOT_OPEN', 'only a resignation still awaiting HR can be declined')
}

// ── clearance ────────────────────────────────────────────────────────────────

export const CLEARANCE_AREAS = ['manager', 'it', 'finance', 'admin', 'hr'] as const
export type ClearanceArea = typeof CLEARANCE_AREAS[number]
export interface Clearance { id: string; area: ClearanceArea; status: string; note: string | null; recovery_paise: string; cleared_by_user_id: string | null; cleared_at: string | null }

/** Opens the five clearances and, if the company has an offboarding checklist, its tasks. Idempotent. */
export async function openClearances(tx: PoolClient, separation: Separation, lastWorkingDay: string): Promise<number> {
  const tid = await tenantId(tx)
  for (const area of CLEARANCE_AREAS) {
    await tx.query(`INSERT INTO exit_clearances (tenant_id, separation_id, area) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tid, separation.id, area])
  }
  const template = await templateForTrigger(tx, 'offboarding')
  if (!template) return 0
  const already = await tx.query(`SELECT 1 FROM tasks WHERE subject_employee_id = $1 AND source_type = 'offboarding' LIMIT 1`, [separation.employee_id])
  if (already.rowCount) return 0
  const resolve = await resolveAssignees(tx, separation.employee_id)
  const ids = await instantiateTemplate(tx, { templateId: template.id, subjectEmployeeId: separation.employee_id, anchorDate: lastWorkingDay, sourceType: 'offboarding', resolveAssignee: resolve })
  return ids.length
}

export async function listClearances(tx: PoolClient, separationId: string): Promise<Clearance[]> {
  const { rows } = await tx.query<Clearance>(
    `SELECT id, area, status, note, recovery_paise::text, cleared_by_user_id, cleared_at::text FROM exit_clearances WHERE separation_id = $1
      ORDER BY array_position($2::text[], area)`, [separationId, [...CLEARANCE_AREAS]])
  return rows
}

/**
 * One area signs off — cleared, or cleared with a recovery (the unreturned
 * laptop, the outstanding advance). Recoveries are summed onto the
 * separation, which the F&F deducts. HR's clearance is last and requires the
 * other four; it marks the separation cleared.
 */
export async function clearArea(
  tx: PoolClient, args: { separationId: string; area: ClearanceArea; status: 'cleared' | 'recovery'; note?: string | null; recoveryPaise?: number; actorUserId: string },
): Promise<{ clearances: Clearance[]; allCleared: boolean }> {
  if (!CLEARANCE_AREAS.includes(args.area)) throw new ExitWorkflowError('VALIDATION_FAILED', `area must be one of ${CLEARANCE_AREAS.join(', ')}`)
  const recovery = args.status === 'recovery' ? Math.round(args.recoveryPaise ?? 0) : 0
  if (args.status === 'recovery' && (recovery <= 0 || !args.note?.trim())) throw new ExitWorkflowError('VALIDATION_FAILED', 'a recovery needs an amount and a note saying what for')
  const sep = (await tx.query<{ status: string }>(`SELECT status FROM employee_separations WHERE id = $1`, [args.separationId])).rows[0]
  if (!sep) throw new ExitWorkflowError('NOT_FOUND', 'no such separation')
  if (sep.status !== 'initiated') throw new ExitWorkflowError('SEPARATION_NOT_OPEN', `the separation is ${sep.status}; clearance is closed`)
  if (args.area !== 'hr' && args.area !== 'finance') {
    // An area signs only once every returnable item it is responsible for is back (or written off as a recovery).
    const emp = (await tx.query<{ employee_id: string }>(`SELECT employee_id FROM employee_separations WHERE id = $1`, [args.separationId])).rows[0]!
    const held = (await openReturnables(tx, emp.employee_id)).filter((h) => h.area === args.area)
    if (held.length && args.status === 'cleared') throw new ExitWorkflowError('ASSETS_OUTSTANDING', `still holding: ${held.map((h) => `${h.name} (${h.tag})`).join(', ')} — take them back or clear with a recovery`)
  }
  if (args.area === 'hr') {
    const pending = await tx.query(`SELECT area FROM exit_clearances WHERE separation_id = $1 AND area <> 'hr' AND status = 'pending'`, [args.separationId])
    if (pending.rowCount) throw new ExitWorkflowError('CLEARANCE_PENDING', `HR signs off last; still pending: ${pending.rows.map((r: { area: string }) => r.area).join(', ')}`)
  }
  await tx.query(
    `UPDATE exit_clearances SET status = $3, note = $4, recovery_paise = $5, cleared_by_user_id = $6, cleared_at = now()
      WHERE separation_id = $1 AND area = $2`, [args.separationId, args.area, args.status, args.note?.trim() || null, recovery, args.actorUserId])
  // recoveries roll up onto the separation for the F&F
  await tx.query(
    `UPDATE employee_separations s SET recoveries_paise = (SELECT coalesce(sum(recovery_paise),0) FROM exit_clearances c WHERE c.separation_id = s.id),
        recoveries_note = (SELECT string_agg(area || ': ' || note, '; ') FROM exit_clearances c WHERE c.separation_id = s.id AND c.recovery_paise > 0)
      WHERE s.id = $1`, [args.separationId])
  const clearances = await listClearances(tx, args.separationId)
  const allCleared = clearances.every((c) => c.status !== 'pending')
  if (allCleared) await tx.query(`UPDATE employee_separations SET cleared_at = now(), cleared_by_user_id = $2 WHERE id = $1 AND cleared_at IS NULL`, [args.separationId, args.actorUserId])
  return { clearances, allCleared }
}

// ── exit interview ───────────────────────────────────────────────────────────

export interface ExitInterview { separation_id: string; conducted_on: string | null; would_rejoin: boolean | null; would_recommend: boolean | null; ratings: Record<string, number>; primary_reason: string | null; feedback: string | null }

export async function recordExitInterview(
  tx: PoolClient, args: { separationId: string; conductedByUserId: string; conductedOn?: string; wouldRejoin?: boolean; wouldRecommend?: boolean; ratings?: Record<string, number>; primaryReason?: string; feedback?: string },
): Promise<ExitInterview> {
  const tid = await tenantId(tx)
  for (const [k, v] of Object.entries(args.ratings ?? {})) {
    if (!Number.isInteger(v) || v < 1 || v > 5) throw new ExitWorkflowError('VALIDATION_FAILED', `rating "${k}" must be 1–5`)
  }
  const { rows } = await tx.query<ExitInterview>(
    `INSERT INTO exit_interviews (tenant_id, separation_id, conducted_by_user_id, conducted_on, would_rejoin, would_recommend, ratings, primary_reason, feedback)
     VALUES ($1,$2,$3,coalesce($4::date, CURRENT_DATE),$5,$6,$7::jsonb,$8,$9)
     ON CONFLICT (tenant_id, separation_id) DO UPDATE SET conducted_by_user_id = EXCLUDED.conducted_by_user_id, conducted_on = EXCLUDED.conducted_on,
       would_rejoin = EXCLUDED.would_rejoin, would_recommend = EXCLUDED.would_recommend, ratings = EXCLUDED.ratings, primary_reason = EXCLUDED.primary_reason, feedback = EXCLUDED.feedback
     RETURNING separation_id, conducted_on::text, would_rejoin, would_recommend, ratings, primary_reason, feedback`,
    [tid, args.separationId, args.conductedByUserId, args.conductedOn ?? null, args.wouldRejoin ?? null, args.wouldRecommend ?? null,
     JSON.stringify(args.ratings ?? {}), args.primaryReason?.trim() || null, args.feedback?.trim().slice(0, 8000) || null])
  return rows[0]!
}

export async function getExitInterview(tx: PoolClient, separationId: string): Promise<ExitInterview | null> {
  const { rows } = await tx.query<ExitInterview>(
    `SELECT separation_id, conducted_on::text, would_rejoin, would_recommend, ratings, primary_reason, feedback FROM exit_interviews WHERE separation_id = $1`, [separationId])
  return rows[0] ?? null
}

// ── relieving letter ─────────────────────────────────────────────────────────

/**
 * The relieving-cum-experience letter, once the settlement is paid. Stored
 * as the employee's document (category 'relieving') and linked on the
 * separation; issuing again returns the existing letter.
 */
export async function issueRelievingLetter(tx: PoolClient, args: { separationId: string; actorUserId: string; signatory?: string; today?: string }): Promise<DocumentMeta> {
  const { rows } = await tx.query<{
    employee_id: string; status: string; last_working_day: string; letter: string | null
    employee_number: string; first_name: string; last_name: string | null; date_of_joining: string; company: string
    designation: string | null; department: string | null
  }>(
    `SELECT s.employee_id, s.status, s.last_working_day::text, s.relieving_letter_document_id AS letter,
            e.employee_number, e.first_name, e.last_name, e.date_of_joining::text, t.display_name AS company,
            a.designation, a.department
       FROM employee_separations s
       JOIN employees e ON (e.tenant_id, e.id) = (s.tenant_id, s.employee_id)
       JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN LATERAL (SELECT designation, department FROM employee_assignments a WHERE a.employee_id = e.id AND a.superseded_at IS NULL ORDER BY a.effective_from DESC LIMIT 1) a ON true
      WHERE s.id = $1`, [args.separationId])
  const s = rows[0]
  if (!s) throw new ExitWorkflowError('NOT_FOUND', 'no such separation')
  if (s.letter) {
    const existing = (await tx.query<DocumentMeta>(`SELECT * FROM documents WHERE id = $1`, [s.letter])).rows[0]
    if (existing) return existing
  }
  if (s.status !== 'settled') throw new ExitWorkflowError('NOT_SETTLED', 'the relieving letter is issued after the full and final settlement is paid')
  const name = `${s.first_name} ${s.last_name ?? ''}`.trim()
  const fmt = (d: string): string => new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
  const page = new PdfPage()
  let y = PAGE_HEIGHT - 72
  page.text(s.company, 72, y, { font: 'bold', size: 16 }); y -= 36
  page.text(`Date: ${fmt(args.today ?? localToday(DEFAULT_COMPANY_ZONE))}`, 72, y); y -= 28
  page.text('TO WHOMSOEVER IT MAY CONCERN', 72, y, { font: 'bold', size: 12 }); y -= 28
  page.text('RELIEVING AND EXPERIENCE LETTER', 72, y, { font: 'bold', size: 12 }); y -= 32
  const lines = [
    `This is to certify that ${name} (Employee No. ${s.employee_number}) was employed with ${s.company}`,
    `from ${fmt(s.date_of_joining)} to ${fmt(s.last_working_day)}${s.designation ? `, last holding the position of ${s.designation}` : ''}${s.department ? ` in the ${s.department} department` : ''}.`,
    '',
    `${s.first_name} has been relieved of all duties and responsibilities with effect from the close of`,
    `business on ${fmt(s.last_working_day)}, and the full and final settlement of dues has been completed.`,
    '',
    `During the period of employment we found ${s.first_name} to be sincere and hardworking. We wish`,
    `${s.first_name} success in all future endeavours.`,
  ]
  for (const l of lines) { page.text(l, 72, y, { size: 11 }); y -= 18 }
  y -= 30
  page.text(`For ${s.company}`, 72, y, { font: 'bold' }); y -= 48
  page.text(args.signatory ?? 'Authorised Signatory', 72, y)
  page.text('This letter is system-generated and valid without a physical signature.', 72, 60, { size: 8, grey: 0.5 })
  const bytes = renderPdf(page, `Relieving letter - ${name}`)
  const doc = await putDocument(tx, {
    ownerType: 'employee', ownerId: s.employee_id, fileName: `relieving-letter-${s.employee_number}.pdf`, contentType: 'application/pdf',
    bytes, category: 'relieving', isConfidential: true, uploadedByUserId: args.actorUserId,
  })
  await tx.query(`UPDATE employee_separations SET relieving_letter_document_id = $2 WHERE id = $1`, [args.separationId, doc.id])
  return doc
}

/** Everything about one person's exit, for the screen. */
export async function exitOverview(tx: PoolClient, employeeId: string): Promise<{
  separation: Separation | null; resignation: Resignation | null; clearances: Clearance[]; interview: ExitInterview | null
  blockingTasks: number
}> {
  const separation = await getSeparation(tx, employeeId)
  const resignations = await listResignations(tx, { employeeId })
  // The one that matters: still open, else the one that became the exit, else the last decision.
  const rank: Record<string, number> = { submitted: 0, accepted: 1, declined: 2, withdrawn: 3 }
  const resignation = [...resignations].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9))[0] ?? null
  const clearances = separation ? await listClearances(tx, separation.id) : []
  const interview = separation ? await getExitInterview(tx, separation.id) : null
  const blocking = separation ? (await tx.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM tasks WHERE subject_employee_id = $1 AND source_type = 'offboarding' AND blocks_completion AND status <> 'done'`, [employeeId])).rows[0]!.n : '0'
  return { separation, resignation, clearances, interview, blockingTasks: Number(blocking) }
}
