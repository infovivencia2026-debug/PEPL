/**
 * Recruitment, from requisition to the first day.
 *
 * Every step is a state change on one of four records — requisition,
 * candidate, interview, offer — and the last step, conversion, is the one
 * that touches the rest of the system: it creates the employee, the first
 * assignment, the compensation, the login invite and the onboarding
 * checklist from the offer, so a joiner's record is complete on day one and
 * nobody retypes a salary. Requisitions and offers above a threshold go
 * through the approval engine like everything else.
 */
import type { PoolClient } from 'pg'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { changeAssignment, changeCompensation } from './history.ts'
import { updateEmployee } from './profile.ts'
import { inviteEmployee } from './onboard.ts'
import { templateForTrigger, resolveAssignees } from '../work/templates.ts'
import { instantiateTemplate } from '../work/tasks.ts'
import { notify } from '../comms/index.ts'

export class RecruitError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RecruitError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// ── requisitions ─────────────────────────────────────────────────────────────

export interface Requisition {
  id: string; title: string; department: string | null; location_code: string | null; grade_code: string | null; designation: string | null
  headcount: number; employment_type: string; min_ctc_paise: string | null; max_ctc_paise: string | null; justification: string | null
  hiring_manager_employee_id: string | null; status: string; approval_request_id: string | null; created_at: string
  /** Derived: candidates by stage and hires so far. */
  candidates: number; hired: number
}
const REQ_COLS = `r.id, r.title, r.department, r.location_code, r.grade_code, r.designation, r.headcount, r.employment_type,
  r.min_ctc_paise::text, r.max_ctc_paise::text, r.justification, r.hiring_manager_employee_id, r.status, r.approval_request_id, r.created_at::text,
  (SELECT count(*)::int FROM candidates c WHERE c.requisition_id = r.id AND c.stage NOT IN ('rejected','withdrawn')) AS candidates,
  (SELECT count(*)::int FROM candidates c WHERE c.requisition_id = r.id AND c.stage = 'joined') AS hired`

export async function listRequisitions(tx: PoolClient, status?: string): Promise<Requisition[]> {
  const { rows } = await tx.query<Requisition>(`SELECT ${REQ_COLS} FROM job_requisitions r WHERE ($1::text IS NULL OR r.status = $1) ORDER BY r.created_at DESC LIMIT 200`, [status ?? null])
  return rows
}
export async function getRequisition(tx: PoolClient, id: string): Promise<Requisition | null> {
  const { rows } = await tx.query<Requisition>(`SELECT ${REQ_COLS} FROM job_requisitions r WHERE r.id = $1`, [id])
  return rows[0] ?? null
}

export async function raiseRequisition(
  tx: PoolClient,
  args: { title: string; department?: string | null; locationCode?: string | null; gradeCode?: string | null; designation?: string | null; headcount?: number
    employmentType?: string; minCtcPaise?: number | null; maxCtcPaise?: number | null; justification?: string | null; hiringManagerEmployeeId?: string | null
    requestedByUserId: string; fallbackChain: ChainCode },
): Promise<{ requisition: Requisition; approvalRequestId: string }> {
  const tid = await tenantId(tx)
  if (!args.title?.trim()) throw new RecruitError('VALIDATION_FAILED', 'a requisition needs a title')
  if (args.minCtcPaise && args.maxCtcPaise && args.maxCtcPaise < args.minCtcPaise) throw new RecruitError('VALIDATION_FAILED', 'max CTC is below min CTC')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO job_requisitions (tenant_id, title, department, location_code, grade_code, designation, headcount, employment_type, min_ctc_paise, max_ctc_paise, justification, hiring_manager_employee_id, requested_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [tid, args.title.trim().slice(0, 160), args.department ?? null, args.locationCode ?? null, args.gradeCode ?? null, args.designation ?? null, args.headcount ?? 1,
     args.employmentType ?? 'permanent', args.minCtcPaise ?? null, args.maxCtcPaise ?? null, args.justification?.trim() || null, args.hiringManagerEmployeeId ?? null, args.requestedByUserId])
  const id = rows[0]!.id
  // the subject is the hiring manager if named, else the requester's own employee record is unknown here → use the manager or a placeholder-free path
  const subject = args.hiringManagerEmployeeId ?? (await tx.query<{ employee_id: string | null }>(`SELECT employee_id FROM app_users WHERE id = $1`, [args.requestedByUserId])).rows[0]?.employee_id
  if (!subject) throw new RecruitError('VALIDATION_FAILED', 'name a hiring manager (the requester has no employee record to route approval by)')
  const approval = await raiseWithPolicy(tx, {
    entityType: 'requisition', entityId: id, requestedByUserId: args.requestedByUserId, subjectEmployeeId: subject,
    magnitude: (args.maxCtcPaise ?? 0) / 100 * (args.headcount ?? 1), fallback: args.fallbackChain,
    title: `Hiring · ${args.title.trim()} × ${args.headcount ?? 1}`,
  })
  await tx.query(`UPDATE job_requisitions SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleRequisitionDecision(tx, { requisitionId: id, status: 'approved' })
  return { requisition: (await getRequisition(tx, id))!, approvalRequestId: approval.requestId }
}

/** Approved → open for candidates. */
export async function settleRequisitionDecision(tx: PoolClient, args: { requisitionId?: string; approvalRequestId?: string; status: 'approved' | 'rejected' }): Promise<{ changed: boolean; requisitionId?: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE job_requisitions SET status = $2, decided_at = now()
      WHERE ((($1::uuid IS NOT NULL) AND id = $1) OR (($3::uuid IS NOT NULL) AND approval_request_id = $3)) AND status = 'pending' RETURNING id`,
    [args.requisitionId ?? null, args.status === 'approved' ? 'open' : 'rejected', args.approvalRequestId ?? null])
  return { changed: rows.length > 0, requisitionId: rows[0]?.id }
}

export async function setRequisitionStatus(tx: PoolClient, id: string, status: 'open' | 'on_hold' | 'cancelled'): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE job_requisitions SET status = $2 WHERE id = $1 AND status IN ('open','on_hold')`, [id, status])
  if (!rowCount) throw new RecruitError('REQUISITION_NOT_OPEN', 'only an open or on-hold requisition can change status')
}

// ── candidates ───────────────────────────────────────────────────────────────

export interface Candidate {
  id: string; requisition_id: string; first_name: string; last_name: string | null; email: string; phone: string | null; source: string | null
  referred_by_employee_id: string | null; resume_document_id: string | null; current_ctc_paise: string | null; expected_ctc_paise: string | null; notice_days: number | null
  stage: string; rejection_reason: string | null; notes: string | null; employee_id: string | null; created_at: string; updated_at: string
}
const CAND_COLS = `id, requisition_id, first_name, last_name, email, phone, source, referred_by_employee_id, resume_document_id,
  current_ctc_paise::text, expected_ctc_paise::text, notice_days, stage, rejection_reason, notes, employee_id, created_at::text, updated_at::text`
export const STAGES = ['applied', 'screening', 'interview', 'offer', 'offered', 'accepted', 'joined', 'rejected', 'withdrawn'] as const

export async function listCandidates(tx: PoolClient, args: { requisitionId?: string; stage?: string; q?: string }): Promise<Candidate[]> {
  const { rows } = await tx.query<Candidate>(
    `SELECT ${CAND_COLS} FROM candidates
      WHERE ($1::uuid IS NULL OR requisition_id = $1) AND ($2::text IS NULL OR stage = $2)
        AND ($3::text IS NULL OR lower(first_name || ' ' || coalesce(last_name,'') || ' ' || email) LIKE '%' || lower($3) || '%')
      ORDER BY updated_at DESC LIMIT 500`, [args.requisitionId ?? null, args.stage ?? null, args.q?.trim() || null])
  return rows
}
export async function getCandidate(tx: PoolClient, id: string): Promise<Candidate | null> {
  const { rows } = await tx.query<Candidate>(`SELECT ${CAND_COLS} FROM candidates WHERE id = $1`, [id])
  return rows[0] ?? null
}

export async function addCandidate(
  tx: PoolClient,
  args: { requisitionId: string; firstName: string; lastName?: string | null; email: string; phone?: string | null; source?: string | null; referredByEmployeeId?: string | null
    resumeDocumentId?: string | null; currentCtcPaise?: number | null; expectedCtcPaise?: number | null; noticeDays?: number | null; notes?: string | null },
): Promise<Candidate> {
  const tid = await tenantId(tx)
  const req = await getRequisition(tx, args.requisitionId)
  if (!req) throw new RecruitError('NOT_FOUND', 'no such requisition')
  if (req.status !== 'open') throw new RecruitError('REQUISITION_NOT_OPEN', `the requisition is ${req.status}; candidates can be added to an open one`)
  if (!args.firstName?.trim()) throw new RecruitError('VALIDATION_FAILED', 'first name is required')
  const email = args.email.trim().toLowerCase()
  if (!EMAIL.test(email)) throw new RecruitError('VALIDATION_FAILED', 'email must be an address')
  const dup = await tx.query(`SELECT 1 FROM candidates WHERE requisition_id = $1 AND lower(email) = $2`, [args.requisitionId, email])
  if (dup.rowCount) throw new RecruitError('CANDIDATE_EXISTS', 'this person has already applied to this requisition')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO candidates (tenant_id, requisition_id, first_name, last_name, email, phone, source, referred_by_employee_id, resume_document_id, current_ctc_paise, expected_ctc_paise, notice_days, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [tid, args.requisitionId, args.firstName.trim(), args.lastName?.trim() || null, email, args.phone?.trim() || null, args.source?.trim() || null, args.referredByEmployeeId ?? null,
     args.resumeDocumentId ?? null, args.currentCtcPaise ?? null, args.expectedCtcPaise ?? null, args.noticeDays ?? null, args.notes?.trim() || null])
  return (await getCandidate(tx, rows[0]!.id))!
}

const FORWARD: Record<string, string[]> = {
  applied: ['screening', 'interview', 'rejected', 'withdrawn'],
  screening: ['interview', 'rejected', 'withdrawn'],
  interview: ['offer', 'rejected', 'withdrawn'],
  offer: ['rejected', 'withdrawn'],            // 'offered' comes from sending the offer
  offered: ['withdrawn'],                      // 'accepted' / 'declined' come from the offer response
  accepted: ['withdrawn'],                     // 'joined' comes from conversion
}

export async function moveCandidate(tx: PoolClient, id: string, stage: string, reason?: string | null): Promise<Candidate> {
  const c = await getCandidate(tx, id)
  if (!c) throw new RecruitError('NOT_FOUND', 'no such candidate')
  if (!(FORWARD[c.stage] ?? []).includes(stage)) throw new RecruitError('BAD_STAGE_MOVE', `a candidate at "${c.stage}" cannot move to "${stage}" here`)
  if (stage === 'rejected' && !reason?.trim()) throw new RecruitError('VALIDATION_FAILED', 'a rejection needs a reason')
  await tx.query(`UPDATE candidates SET stage = $2, rejection_reason = $3, updated_at = now() WHERE id = $1`, [id, stage, stage === 'rejected' ? reason!.trim() : null])
  return (await getCandidate(tx, id))!
}

// ── interviews ───────────────────────────────────────────────────────────────

export interface Interview { id: string; candidate_id: string; round: string; scheduled_at: string; duration_min: number; mode: string; location: string | null; interviewer_user_ids: string[]; status: string; score: number | null; recommendation: string | null; feedback: string | null }
const INT_COLS = `id, candidate_id, round, scheduled_at::text, duration_min, mode, location, interviewer_user_ids, status, score, recommendation, feedback`

export async function scheduleInterview(
  tx: PoolClient, args: { candidateId: string; round: string; scheduledAt: string; durationMin?: number; mode?: Interview['mode']; location?: string | null; interviewerUserIds: string[] },
): Promise<Interview> {
  const tid = await tenantId(tx)
  const c = await getCandidate(tx, args.candidateId)
  if (!c) throw new RecruitError('NOT_FOUND', 'no such candidate')
  if (!['screening', 'interview', 'offer'].includes(c.stage)) throw new RecruitError('BAD_STAGE_MOVE', `a candidate at "${c.stage}" is not being interviewed`)
  if (!args.interviewerUserIds?.length) throw new RecruitError('VALIDATION_FAILED', 'at least one interviewer')
  const { rows } = await tx.query<Interview>(
    `INSERT INTO interviews (tenant_id, candidate_id, round, scheduled_at, duration_min, mode, location, interviewer_user_ids)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::uuid[]) RETURNING ${INT_COLS}`,
    [tid, args.candidateId, args.round.trim().slice(0, 80), args.scheduledAt, args.durationMin ?? 45, args.mode ?? 'video', args.location?.trim() || null, args.interviewerUserIds])
  if (c.stage === 'screening') await tx.query(`UPDATE candidates SET stage = 'interview', updated_at = now() WHERE id = $1`, [c.id])
  for (const u of args.interviewerUserIds) {
    await notify(tx, { userId: u, eventType: 'recruit.interview.scheduled', title: `Interview: ${c.first_name} ${c.last_name ?? ''} · ${args.round}`,
      body: new Date(args.scheduledAt).toLocaleString('en-IN'), entityType: 'interview', entityId: rows[0]!.id, dedupeKey: `interview:${rows[0]!.id}:${u}` })
  }
  return rows[0]!
}

export async function recordInterview(
  tx: PoolClient, args: { interviewId: string; actorUserId: string; status: 'completed' | 'cancelled' | 'no_show'; score?: number; recommendation?: Interview['recommendation']; feedback?: string },
): Promise<Interview> {
  const iv = (await tx.query<Interview>(`SELECT ${INT_COLS} FROM interviews WHERE id = $1`, [args.interviewId])).rows[0]
  if (!iv) throw new RecruitError('NOT_FOUND', 'no such interview')
  if (args.status === 'completed' && !iv.interviewer_user_ids.includes(args.actorUserId)) throw new RecruitError('NOT_INTERVIEWER', 'only an interviewer records the outcome')
  if (args.status === 'completed' && (args.score === undefined || !args.recommendation)) throw new RecruitError('VALIDATION_FAILED', 'a completed interview needs a score (1–5) and a recommendation')
  const { rows } = await tx.query<Interview>(
    `UPDATE interviews SET status = $2, score = $3, recommendation = $4, feedback = $5 WHERE id = $1 RETURNING ${INT_COLS}`,
    [args.interviewId, args.status, args.score ?? null, args.recommendation ?? null, args.feedback?.trim().slice(0, 4000) || null])
  return rows[0]!
}

export async function listInterviews(tx: PoolClient, args: { candidateId?: string; interviewerUserId?: string; upcoming?: boolean }): Promise<Interview[]> {
  const { rows } = await tx.query<Interview>(
    `SELECT ${INT_COLS} FROM interviews
      WHERE ($1::uuid IS NULL OR candidate_id = $1) AND ($2::uuid IS NULL OR $2 = ANY(interviewer_user_ids)) AND (NOT $3 OR (status = 'scheduled' AND scheduled_at >= now()))
      ORDER BY scheduled_at`, [args.candidateId ?? null, args.interviewerUserId ?? null, args.upcoming ?? false])
  return rows
}

// ── offers ───────────────────────────────────────────────────────────────────

export interface Offer {
  id: string; candidate_id: string; designation: string; department: string | null; location_code: string | null; grade_code: string | null
  annual_ctc_paise: string; components: Record<string, number>; structure_code: string | null; joining_date: string; valid_until: string
  employment_type: string; probation_months: number; notice_period_days: number; status: string; approval_request_id: string | null; letter_document_id: string | null
  sent_at: string | null; responded_at: string | null; created_at: string
}
const OFFER_COLS = `id, candidate_id, designation, department, location_code, grade_code, annual_ctc_paise::text, components, structure_code, joining_date::text, valid_until::text,
  employment_type, probation_months, notice_period_days, status, approval_request_id, letter_document_id, sent_at::text, responded_at::text, created_at::text`

export async function getOffer(tx: PoolClient, id: string): Promise<Offer | null> {
  const { rows } = await tx.query<Offer>(`SELECT ${OFFER_COLS} FROM offers WHERE id = $1`, [id])
  return rows[0] ?? null
}
export async function offersFor(tx: PoolClient, candidateId: string): Promise<Offer[]> {
  const { rows } = await tx.query<Offer>(`SELECT ${OFFER_COLS} FROM offers WHERE candidate_id = $1 ORDER BY created_at DESC`, [candidateId])
  return rows
}

/** An offer within the requisition's band is approved by the chain; the policy engine may add steps above a size. */
export async function makeOffer(
  tx: PoolClient,
  args: { candidateId: string; designation: string; department?: string | null; locationCode?: string | null; gradeCode?: string | null; annualCtcPaise: number
    components?: Record<string, number>; structureCode?: string | null; joiningDate: string; validUntil: string; employmentType?: string; probationMonths?: number; noticePeriodDays?: number
    createdByUserId: string; fallbackChain: ChainCode },
): Promise<{ offer: Offer; approvalRequestId: string }> {
  const tid = await tenantId(tx)
  const c = await getCandidate(tx, args.candidateId)
  if (!c) throw new RecruitError('NOT_FOUND', 'no such candidate')
  if (!['interview', 'offer'].includes(c.stage)) throw new RecruitError('BAD_STAGE_MOVE', `an offer is made after interviews; the candidate is at "${c.stage}"`)
  const req = (await getRequisition(tx, c.requisition_id))!
  if (req.max_ctc_paise && args.annualCtcPaise > Number(req.max_ctc_paise)) throw new RecruitError('OVER_BAND', `the requisition's band tops out at ₹${(Number(req.max_ctc_paise) / 100).toLocaleString('en-IN')}`)
  if (args.validUntil < new Date().toISOString().slice(0, 10)) throw new RecruitError('VALIDATION_FAILED', 'the offer would already be expired')
  const live = await tx.query(`SELECT 1 FROM offers WHERE candidate_id = $1 AND status IN ('pending_approval','approved','sent','accepted')`, [c.id])
  if (live.rowCount) throw new RecruitError('OFFER_OPEN', 'this candidate already has a live offer; withdraw it first')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO offers (tenant_id, candidate_id, designation, department, location_code, grade_code, annual_ctc_paise, components, structure_code, joining_date, valid_until, employment_type, probation_months, notice_period_days, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [tid, c.id, args.designation.trim(), args.department ?? req.department, args.locationCode ?? req.location_code, args.gradeCode ?? req.grade_code, args.annualCtcPaise,
     JSON.stringify(args.components ?? {}), args.structureCode ?? null, args.joiningDate, args.validUntil, args.employmentType ?? req.employment_type, args.probationMonths ?? 6, args.noticePeriodDays ?? 30, args.createdByUserId])
  const id = rows[0]!.id
  const subject = req.hiring_manager_employee_id ?? (await tx.query<{ employee_id: string | null }>(`SELECT employee_id FROM app_users WHERE id = $1`, [args.createdByUserId])).rows[0]?.employee_id
  if (!subject) throw new RecruitError('VALIDATION_FAILED', 'the requisition needs a hiring manager to route the offer approval')
  const approval = await raiseWithPolicy(tx, {
    entityType: 'offer', entityId: id, requestedByUserId: args.createdByUserId, subjectEmployeeId: subject,
    magnitude: args.annualCtcPaise / 100, fallback: args.fallbackChain,
    title: `Offer · ${c.first_name} ${c.last_name ?? ''} · ${args.designation} · ₹${(args.annualCtcPaise / 100).toLocaleString('en-IN')}`,
  })
  await tx.query(`UPDATE offers SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  await tx.query(`UPDATE candidates SET stage = 'offer', updated_at = now() WHERE id = $1`, [c.id])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleOfferDecision(tx, { offerId: id, status: 'approved' })
  return { offer: (await getOffer(tx, id))!, approvalRequestId: approval.requestId }
}

export async function settleOfferDecision(tx: PoolClient, args: { offerId?: string; approvalRequestId?: string; status: 'approved' | 'rejected' }): Promise<{ changed: boolean; offerId?: string }> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE offers SET status = $2 WHERE ((($1::uuid IS NOT NULL) AND id = $1) OR (($3::uuid IS NOT NULL) AND approval_request_id = $3)) AND status = 'pending_approval' RETURNING id`,
    [args.offerId ?? null, args.status, args.approvalRequestId ?? null])
  return { changed: rows.length > 0, offerId: rows[0]?.id }
}

/** Sent to the candidate: the stage becomes "offered". The letter itself is the UI's mail-merge; its document id is recorded here. */
export async function sendOffer(tx: PoolClient, id: string, letterDocumentId?: string | null): Promise<Offer> {
  const { rows } = await tx.query<{ candidate_id: string }>(
    `UPDATE offers SET status = 'sent', sent_at = now(), letter_document_id = coalesce($2, letter_document_id) WHERE id = $1 AND status = 'approved' RETURNING candidate_id`, [id, letterDocumentId ?? null])
  if (!rows[0]) throw new RecruitError('OFFER_NOT_APPROVED', 'only an approved offer can be sent')
  await tx.query(`UPDATE candidates SET stage = 'offered', updated_at = now() WHERE id = $1`, [rows[0].candidate_id])
  return (await getOffer(tx, id))!
}

export async function respondToOffer(tx: PoolClient, id: string, response: 'accepted' | 'declined'): Promise<Offer> {
  const { rows } = await tx.query<{ candidate_id: string }>(
    `UPDATE offers SET status = $2, responded_at = now() WHERE id = $1 AND status = 'sent' RETURNING candidate_id`, [id, response])
  if (!rows[0]) throw new RecruitError('OFFER_NOT_SENT', 'only a sent offer can be answered')
  await tx.query(`UPDATE candidates SET stage = $2, updated_at = now() WHERE id = $1`, [rows[0].candidate_id, response === 'accepted' ? 'accepted' : 'interview'])
  return (await getOffer(tx, id))!
}

export async function withdrawOffer(tx: PoolClient, id: string): Promise<void> {
  const { rows } = await tx.query<{ candidate_id: string }>(
    `UPDATE offers SET status = 'withdrawn' WHERE id = $1 AND status IN ('pending_approval','approved','sent') RETURNING candidate_id`, [id])
  if (!rows[0]) throw new RecruitError('OFFER_NOT_LIVE', 'this offer is not live')
  await tx.query(`UPDATE approval_requests SET status = 'withdrawn' WHERE id = (SELECT approval_request_id FROM offers WHERE id = $1) AND status = 'pending'`, [id])
  await tx.query(`UPDATE candidates SET stage = 'interview', updated_at = now() WHERE id = $1 AND stage IN ('offer','offered')`, [rows[0].candidate_id])
}

// ── conversion ───────────────────────────────────────────────────────────────

/**
 * The accepted candidate becomes an employee. One transaction: employee row
 * (number given or generated), personal details from the candidate, first
 * assignment and compensation from the offer, login invite to the candidate's
 * email, onboarding checklist. Fills the requisition when headcount is met.
 */
export async function convertToEmployee(
  tx: PoolClient,
  args: { offerId: string; employeeNumber?: string; actorUserId: string; ip?: string },
): Promise<{ employeeId: string; employeeNumber: string; inviteToken: string; tasks: number; requisitionFilled: boolean }> {
  const tid = await tenantId(tx)
  const offer = await getOffer(tx, args.offerId)
  if (!offer) throw new RecruitError('NOT_FOUND', 'no such offer')
  if (offer.status !== 'accepted') throw new RecruitError('OFFER_NOT_ACCEPTED', 'only an accepted offer converts to an employee')
  const c = (await getCandidate(tx, offer.candidate_id))!
  if (c.employee_id) throw new RecruitError('ALREADY_CONVERTED', 'this candidate is already an employee')
  const taken = await tx.query(`SELECT 1 FROM app_users WHERE lower(email) = $1`, [c.email])
  if (taken.rowCount) throw new RecruitError('EMAIL_TAKEN', `${c.email} already has a login in this company`)

  const employeeNumber = args.employeeNumber?.trim() || await nextEmployeeNumber(tx)
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining, work_email, phone, employment_type, probation_end, notice_period_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CASE WHEN $9::int > 0 THEN ($5::date + ($9 || ' months')::interval)::date END, $10) RETURNING id`,
    [tid, employeeNumber, c.first_name, c.last_name, offer.joining_date, c.email, c.phone, offer.probation_months > 0 ? 'probation' : offer.employment_type, offer.probation_months, offer.notice_period_days])
  const employeeId = rows[0]!.id
  const req = (await getRequisition(tx, c.requisition_id))!
  await changeAssignment(tx, {
    employeeId, department: offer.department ?? req.department ?? 'Unassigned', designation: offer.designation,
    managerEmployeeId: req.hiring_manager_employee_id ?? null, locationCode: offer.location_code ?? null, gradeCode: offer.grade_code ?? null,
    effectiveFrom: offer.joining_date, reason: 'joined', actorUserId: args.actorUserId,
  })
  await changeCompensation(tx, {
    employeeId, annualCtcPaise: Number(offer.annual_ctc_paise), components: offer.components, structureCode: offer.structure_code ?? undefined,
    effectiveFrom: offer.joining_date, reason: 'offer accepted', actorUserId: args.actorUserId,
  })
  await updateEmployee(tx, employeeId, { personalEmail: c.email })
  const invite = await inviteEmployee(tx, { employeeId, email: c.email, issuedByUserId: args.actorUserId, ip: args.ip })
  let tasks = 0
  const template = await templateForTrigger(tx, 'onboarding')
  if (template) {
    const resolve = await resolveAssignees(tx, employeeId)
    tasks = (await instantiateTemplate(tx, { templateId: template.id, subjectEmployeeId: employeeId, anchorDate: offer.joining_date, sourceType: 'onboarding', resolveAssignee: resolve })).length
  }
  await tx.query(`UPDATE candidates SET stage = 'joined', employee_id = $2, updated_at = now() WHERE id = $1`, [c.id, employeeId])
  const hired = Number((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM candidates WHERE requisition_id = $1 AND stage = 'joined'`, [req.id])).rows[0]!.n)
  const filled = hired >= req.headcount
  if (filled) await tx.query(`UPDATE job_requisitions SET status = 'filled' WHERE id = $1 AND status = 'open'`, [req.id])
  return { employeeId, employeeNumber, inviteToken: invite.token, tasks, requisitionFilled: filled }
}

/** EMP-0001 style, from a per-tenant counter table — never MAX() over an RLS-filtered view. */
async function nextEmployeeNumber(tx: PoolClient): Promise<string> {
  const tid = await tenantId(tx)
  const { rows } = await tx.query<{ next: number }>(
    `INSERT INTO employee_number_counters (tenant_id, next) VALUES ($1, 2) ON CONFLICT (tenant_id) DO UPDATE SET next = employee_number_counters.next + 1 RETURNING next - 1 AS next`, [tid])
  let n = rows[0]!.next
  // skip numbers already taken by manually numbered employees
  for (;;) {
    const candidate = `EMP-${String(n).padStart(4, '0')}`
    const clash = await tx.query(`SELECT 1 FROM employees WHERE employee_number = $1`, [candidate])
    if (!clash.rowCount) return candidate
    n = (await tx.query<{ next: number }>(`UPDATE employee_number_counters SET next = next + 1 WHERE tenant_id = $1 RETURNING next - 1 AS next`, [tid])).rows[0]!.next
  }
}
