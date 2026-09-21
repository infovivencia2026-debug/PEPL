/**
 * Work-from-home and field duty.
 *
 * A remote request covers a date range with a kind (wfh | field). Approved
 * through the engine (or on the spot when the company does not require
 * approval for WFH), it changes how those days are read: the geofence is
 * not enforced on a punch, and the day is marked remote or on duty when the
 * person punches — or, for a field day with a visit logged, when the visit
 * starts. A monthly WFH cap is a setting.
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { applyCorrection, type DayPolicy } from './index.ts'

export class RemoteError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'RemoteError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export interface RemoteRequest {
  id: string; employee_id: string; kind: 'wfh' | 'field'; starts_on: string; ends_on: string; place: string | null; reason: string | null
  status: string; approval_request_id: string | null; created_at: string; decided_at: string | null
}
const COLS = `id, employee_id, kind, starts_on::text, ends_on::text, place, reason, status, approval_request_id, created_at::text, decided_at::text`

export async function listRemoteRequests(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string; from?: string; to?: string }): Promise<RemoteRequest[]> {
  const { rows } = await tx.query<RemoteRequest>(
    `SELECT ${COLS} FROM remote_requests
      WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR status = $3)
        AND ($4::date IS NULL OR ends_on >= $4) AND ($5::date IS NULL OR starts_on <= $5)
      ORDER BY starts_on DESC LIMIT 200`, [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null, args.from ?? null, args.to ?? null])
  return rows
}

/** The approved remote mode covering a date, if any. */
export async function remoteModeOn(tx: PoolClient, employeeId: string, date: string): Promise<'wfh' | 'field' | null> {
  const { rows } = await tx.query<{ kind: 'wfh' | 'field' }>(
    `SELECT kind FROM remote_requests WHERE employee_id = $1 AND status = 'approved' AND $2::date BETWEEN starts_on AND ends_on LIMIT 1`, [employeeId, date])
  return rows[0]?.kind ?? null
}

export async function requestRemote(
  tx: PoolClient, cfg: ResolvedConfig,
  args: { employeeId: string; requestedByUserId: string; kind: 'wfh' | 'field'; startsOn: string; endsOn: string; place?: string | null; reason?: string | null },
): Promise<{ request: RemoteRequest; approvalRequestId: string | null }> {
  const tid = await tenantId(tx)
  if (!['wfh', 'field'].includes(args.kind)) throw new RemoteError('VALIDATION_FAILED', 'kind must be wfh or field')
  if (args.endsOn < args.startsOn) throw new RemoteError('VALIDATION_FAILED', 'the range ends before it starts')
  const days = Math.round((Date.parse(args.endsOn) - Date.parse(args.startsOn)) / 86_400_000) + 1
  if (days > 62) throw new RemoteError('VALIDATION_FAILED', 'request at most two months at a time')
  if (args.kind === 'field' && !args.place?.trim()) throw new RemoteError('VALIDATION_FAILED', 'field duty needs the place (client, school, site)')
  const overlap = await tx.query(
    `SELECT 1 FROM remote_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND starts_on <= $3 AND ends_on >= $2`, [args.employeeId, args.startsOn, args.endsOn])
  if (overlap.rowCount) throw new RemoteError('REMOTE_OVERLAP', 'a request already covers part of these dates')
  if (args.kind === 'wfh') {
    if (cfg.get<boolean>('attendance.remote_enabled') === false) throw new RemoteError('REMOTE_NOT_ALLOWED', 'working from home is switched off for this company')
    const cap = cfg.get<number>('attendance.wfh_max_days_per_month')
    if (cap > 0) {
      const { rows } = await tx.query<{ used: string }>(
        `SELECT coalesce(sum(least(ends_on, (date_trunc('month', $2::date) + interval '1 month - 1 day')::date) - greatest(starts_on, date_trunc('month', $2::date)::date) + 1), 0)::text AS used
           FROM remote_requests WHERE employee_id = $1 AND kind = 'wfh' AND status IN ('pending','approved')
            AND starts_on <= (date_trunc('month', $2::date) + interval '1 month - 1 day')::date AND ends_on >= date_trunc('month', $2::date)::date`,
        [args.employeeId, args.startsOn])
      if (Number(rows[0]!.used) + days > cap) throw new RemoteError('WFH_CAP', `this company allows ${cap} work-from-home days a month; ${rows[0]!.used} already requested`)
    }
  }
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO remote_requests (tenant_id, employee_id, kind, starts_on, ends_on, place, reason, requested_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [tid, args.employeeId, args.kind, args.startsOn, args.endsOn, args.place?.trim() || (args.kind === 'wfh' ? 'Home' : null), args.reason?.trim() || null, args.requestedByUserId])
  const id = rows[0]!.id
  const needsApproval = args.kind === 'field' || cfg.get<boolean>('attendance.wfh_requires_approval')
  if (!needsApproval) {
    await tx.query(`UPDATE remote_requests SET status = 'approved', decided_at = now() WHERE id = $1`, [id])
    return { request: (await get(tx, id))!, approvalRequestId: null }
  }
  const approval = await raiseWithPolicy(tx, {
    entityType: 'remote', entityId: id, requestedByUserId: args.requestedByUserId, subjectEmployeeId: args.employeeId,
    magnitude: days, fallback: cfg.get<string>('attendance.remote_approval_chain') as ChainCode,
    title: `${args.kind === 'wfh' ? 'Work from home' : 'Field duty'} · ${args.startsOn}${days > 1 ? ` to ${args.endsOn}` : ''}`,
  })
  await tx.query(`UPDATE remote_requests SET approval_request_id = $2 WHERE id = $1`, [id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleRemoteDecision(tx, { approvalRequestId: approval.requestId, status: 'approved' })
  return { request: (await get(tx, id))!, approvalRequestId: approval.requestId }
}

async function get(tx: PoolClient, id: string): Promise<RemoteRequest | null> {
  const { rows } = await tx.query<RemoteRequest>(`SELECT ${COLS} FROM remote_requests WHERE id = $1`, [id])
  return rows[0] ?? null
}
export { get as getRemoteRequest }

export async function settleRemoteDecision(tx: PoolClient, args: { approvalRequestId: string; status: 'approved' | 'rejected' }): Promise<{ changed: boolean }> {
  const { rowCount } = await tx.query(`UPDATE remote_requests SET status = $2, decided_at = now() WHERE approval_request_id = $1 AND status = 'pending'`, [args.approvalRequestId, args.status])
  return { changed: (rowCount ?? 0) > 0 }
}

export async function cancelRemote(tx: PoolClient, id: string, employeeId: string): Promise<void> {
  const { rowCount } = await tx.query(`UPDATE remote_requests SET status = 'cancelled', decided_at = now() WHERE id = $1 AND employee_id = $2 AND status IN ('pending','approved')`, [id, employeeId])
  if (!rowCount) throw new RemoteError('NOT_FOUND', 'no such open request of yours')
  await tx.query(`UPDATE approval_requests SET status = 'withdrawn' WHERE id = (SELECT approval_request_id FROM remote_requests WHERE id = $1) AND status = 'pending'`, [id])
}

/** After a punch on an approved remote day: the day carries the mode. */
export async function markModeOnDay(tx: PoolClient, args: { employeeId: string; workDate: string; mode: 'wfh' | 'field'; actorUserId?: string; policy?: DayPolicy }): Promise<void> {
  await applyCorrection(tx, {
    employeeId: args.employeeId, workDate: args.workDate, action: args.mode === 'wfh' ? 'mark_remote' : 'mark_field_duty', after: {},
    reason: args.mode === 'wfh' ? 'approved work from home' : 'approved field duty', actorUserId: args.actorUserId, policy: args.policy,
  })
}

// ── field visits ─────────────────────────────────────────────────────────────

export interface FieldVisit {
  id: string; employee_id: string; work_date: string; place: string; contact: string | null; purpose: string; started_at: string; ended_at: string | null
  start_lat: number | null; start_lng: number | null; end_lat: number | null; end_lng: number | null; outcome: string | null; next_step: string | null; project_id: string | null
}
const VISIT_COLS = `id, employee_id, work_date::text, place, contact, purpose, started_at::text, ended_at::text, start_lat, start_lng, end_lat, end_lng, outcome, next_step, project_id`

export async function startVisit(
  tx: PoolClient, args: { employeeId: string; workDate: string; place: string; contact?: string | null; purpose: string; geo?: { lat: number; lng: number } | null; projectId?: string | null },
): Promise<FieldVisit> {
  const tid = await tenantId(tx)
  if (!args.place?.trim() || !args.purpose?.trim()) throw new RemoteError('VALIDATION_FAILED', 'place and purpose are required')
  const open = await tx.query(`SELECT 1 FROM field_visits WHERE employee_id = $1 AND ended_at IS NULL`, [args.employeeId])
  if (open.rowCount) throw new RemoteError('VISIT_OPEN', 'end the current visit before starting another')
  const { rows } = await tx.query<FieldVisit>(
    `INSERT INTO field_visits (tenant_id, employee_id, work_date, place, contact, purpose, start_lat, start_lng, project_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${VISIT_COLS}`,
    [tid, args.employeeId, args.workDate, args.place.trim(), args.contact?.trim() || null, args.purpose.trim(), args.geo?.lat ?? null, args.geo?.lng ?? null, args.projectId ?? null])
  return rows[0]!
}

export async function endVisit(
  tx: PoolClient, args: { visitId: string; employeeId: string; outcome: string; nextStep?: string | null; geo?: { lat: number; lng: number } | null; photoDocumentIds?: string[] },
): Promise<FieldVisit> {
  if (!args.outcome?.trim()) throw new RemoteError('VALIDATION_FAILED', 'say what came of the visit')
  const { rows } = await tx.query<FieldVisit>(
    `UPDATE field_visits SET ended_at = now(), outcome = $3, next_step = $4, end_lat = $5, end_lng = $6, photo_document_ids = $7::uuid[]
      WHERE id = $1 AND employee_id = $2 AND ended_at IS NULL RETURNING ${VISIT_COLS}`,
    [args.visitId, args.employeeId, args.outcome.trim(), args.nextStep?.trim() || null, args.geo?.lat ?? null, args.geo?.lng ?? null, args.photoDocumentIds ?? []])
  if (!rows[0]) throw new RemoteError('NOT_FOUND', 'no such open visit of yours')
  return rows[0]
}

export async function listVisits(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; from: string; to: string }): Promise<FieldVisit[]> {
  const { rows } = await tx.query<FieldVisit>(
    `SELECT ${VISIT_COLS} FROM field_visits WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND work_date BETWEEN $3::date AND $4::date
      ORDER BY started_at DESC LIMIT 500`, [args.employeeIds ?? null, args.employeeId ?? null, args.from, args.to])
  return rows
}
