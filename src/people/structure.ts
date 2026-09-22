/**
 * Org chart, positions, transfers, profile change requests.
 *
 * The chart is derived from manager_employee_id on the current assignment —
 * never stored, so it cannot drift. A position is a budgeted seat; vacancy is
 * seats minus the people currently assigned to it. A transfer is an approved,
 * effective-dated changeAssignment(). A profile change request is an
 * employee's proposed edit that HR approves into updateEmployee().
 */
import type { PoolClient } from 'pg'
import type { ResolvedConfig } from '../config/resolver.ts'
import { raiseWithPolicy } from '../approvals/policy.ts'
import type { ChainCode } from '../approvals/index.ts'
import { changeAssignment } from './history.ts'
import { updateEmployee, currentPosting, type EmployeePatch, SELF_EDITABLE } from './profile.ts'
import { notify } from '../comms/index.ts'

export class StructureError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'StructureError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
const userOf = async (tx: PoolClient, employeeId: string): Promise<string | null> => (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [employeeId])).rows[0]?.id ?? null

// ── org chart ────────────────────────────────────────────────────────────────

export interface ChartNode { employeeId: string; name: string; employeeNumber: string; designation: string | null; department: string | null; location: string | null; managerEmployeeId: string | null; directReports: number; reports: ChartNode[] }

/** The whole company as a forest (people with no manager are roots), or the subtree under one person. */
export async function orgChart(tx: PoolClient, args: { rootEmployeeId?: string | null; depth?: number }): Promise<{ roots: ChartNode[]; total: number; unplaced: number }> {
  const { rows } = await tx.query<{ id: string; name: string; employee_number: string; designation: string | null; department: string | null; location: string | null; manager: string | null }>(
    `SELECT e.id, concat_ws(' ', e.first_name, e.last_name) AS name, e.employee_number, a.designation, a.department, a.location_code AS location, a.manager_employee_id AS manager
       FROM employees e LEFT JOIN LATERAL (SELECT designation, department, location_code, manager_employee_id FROM employee_assignments x WHERE x.employee_id = e.id AND x.superseded_at IS NULL AND x.effective_from <= CURRENT_DATE AND (x.effective_to IS NULL OR x.effective_to >= CURRENT_DATE) ORDER BY effective_from DESC LIMIT 1) a ON true
      WHERE e.status = 'active' AND e.erased_at IS NULL ORDER BY name`)
  const byManager = new Map<string | null, typeof rows>()
  for (const r of rows) { const k = r.manager && rows.some((x) => x.id === r.manager) ? r.manager : null; const list = byManager.get(k) ?? []; list.push(r); byManager.set(k, list) }
  const maxDepth = args.depth ?? 12
  const build = (r: typeof rows[number], d: number): ChartNode => {
    const kids = byManager.get(r.id) ?? []
    return { employeeId: r.id, name: r.name, employeeNumber: r.employee_number, designation: r.designation, department: r.department, location: r.location, managerEmployeeId: r.manager, directReports: kids.length, reports: d < maxDepth ? kids.map((k) => build(k, d + 1)) : [] }
  }
  if (args.rootEmployeeId) {
    const root = rows.find((r) => r.id === args.rootEmployeeId)
    if (!root) throw new StructureError('NOT_FOUND', 'no such active employee')
    return { roots: [build(root, 0)], total: rows.length, unplaced: 0 }
  }
  const roots = (byManager.get(null) ?? []).map((r) => build(r, 0))
  // people whose manager left (manager id points at nobody active) sit at the top too — flagged as unplaced
  const unplaced = (byManager.get(null) ?? []).filter((r) => r.manager !== null).length
  return { roots, total: rows.length, unplaced }
}

/** Manager → skip → … up to the top, for a person's breadcrumb. */
export async function reportingLine(tx: PoolClient, employeeId: string): Promise<Array<{ employeeId: string; name: string; designation: string | null }>> {
  const out: Array<{ employeeId: string; name: string; designation: string | null }> = []
  let cur: string | null = employeeId
  const seen = new Set<string>()
  while (cur && !seen.has(cur) && out.length < 20) {
    seen.add(cur)
    const p = await currentPosting(tx, cur)
    if (!p?.manager_employee_id) break
    const m = (await tx.query<{ name: string }>(`SELECT concat_ws(' ', first_name, last_name) AS name FROM employees WHERE id = $1 AND status = 'active'`, [p.manager_employee_id])).rows[0]
    if (!m) break
    const mp = await currentPosting(tx, p.manager_employee_id)
    out.push({ employeeId: p.manager_employee_id, name: m.name, designation: mp?.designation ?? null })
    cur = p.manager_employee_id
  }
  return out
}

// ── positions ────────────────────────────────────────────────────────────────

export interface Position { id: string; code: string; title: string; department: string; designation: string; location_code: string | null; grade_code: string | null; reports_to_position_id: string | null; seats: number; status: string; filled: number }
const POS_COLS = `p.id, p.code, p.title, p.department, p.designation, p.location_code, p.grade_code, p.reports_to_position_id, p.seats, p.status,
  (SELECT count(*)::int FROM employee_assignments a JOIN employees e ON e.id = a.employee_id WHERE a.position_id = p.id AND a.superseded_at IS NULL AND a.effective_to IS NULL AND e.status = 'active') AS filled`

export async function upsertPosition(tx: PoolClient, args: { code: string; title: string; department: string; designation: string; locationCode?: string | null; gradeCode?: string | null; reportsToPositionId?: string | null; seats?: number }): Promise<Position> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '-').slice(0, 32)
  if (!code || !args.title?.trim() || !args.department?.trim() || !args.designation?.trim()) throw new StructureError('VALIDATION_FAILED', 'code, title, department and designation are required')
  const seats = args.seats ?? 1
  if (!Number.isInteger(seats) || seats < 0 || seats > 10_000) throw new StructureError('VALIDATION_FAILED', 'seats is a whole number')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO positions (tenant_id, code, title, department, designation, location_code, grade_code, reports_to_position_id, seats) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (tenant_id, code) DO UPDATE SET title = EXCLUDED.title, department = EXCLUDED.department, designation = EXCLUDED.designation, location_code = EXCLUDED.location_code, grade_code = EXCLUDED.grade_code, reports_to_position_id = EXCLUDED.reports_to_position_id, seats = EXCLUDED.seats, status = 'active' RETURNING id`,
    [tid, code, args.title.trim(), args.department.trim(), args.designation.trim(), args.locationCode ?? null, args.gradeCode ?? null, args.reportsToPositionId ?? null, seats])
  return (await tx.query<Position>(`SELECT ${POS_COLS} FROM positions p WHERE p.id = $1`, [rows[0]!.id])).rows[0]!
}
export async function listPositions(tx: PoolClient, args: { status?: string; department?: string; vacantOnly?: boolean }): Promise<Position[]> {
  const rows = (await tx.query<Position>(`SELECT ${POS_COLS} FROM positions p WHERE ($1::text IS NULL OR p.status = $1) AND ($2::text IS NULL OR p.department = $2) ORDER BY p.department, p.title`, [args.status ?? null, args.department ?? null])).rows
  return args.vacantOnly ? rows.filter((p) => p.filled < p.seats) : rows
}
export async function setPositionStatus(tx: PoolClient, id: string, status: 'active' | 'frozen' | 'closed'): Promise<Position> {
  const p = (await tx.query<Position>(`SELECT ${POS_COLS} FROM positions p WHERE p.id = $1`, [id])).rows[0]
  if (!p) throw new StructureError('NOT_FOUND', 'no such position')
  if (status === 'closed' && p.filled > 0) throw new StructureError('POSITION_OCCUPIED', `${p.filled} person(s) hold this position`)
  await tx.query(`UPDATE positions SET status = $2 WHERE id = $1`, [id, status])
  return (await tx.query<Position>(`SELECT ${POS_COLS} FROM positions p WHERE p.id = $1`, [id])).rows[0]!
}
/** Seat a person in a position (the assignment row points at it). Refuses when full. */
export async function seatEmployee(tx: PoolClient, args: { employeeId: string; positionId: string | null }): Promise<void> {
  if (args.positionId) {
    const p = (await tx.query<Position>(`SELECT ${POS_COLS} FROM positions p WHERE p.id = $1`, [args.positionId])).rows[0]
    if (!p) throw new StructureError('NOT_FOUND', 'no such position')
    if (p.status !== 'active') throw new StructureError('POSITION_STATE', `the position is ${p.status}`)
    const already = (await tx.query(`SELECT 1 FROM employee_assignments WHERE employee_id = $1 AND position_id = $2 AND superseded_at IS NULL AND effective_to IS NULL`, [args.employeeId, args.positionId])).rowCount
    if (!already && p.filled >= p.seats) throw new StructureError('POSITION_FULL', `all ${p.seats} seat(s) are taken`)
  }
  const r = await tx.query(`UPDATE employee_assignments SET position_id = $2 WHERE employee_id = $1 AND superseded_at IS NULL AND effective_to IS NULL`, [args.employeeId, args.positionId])
  if (!r.rowCount) throw new StructureError('NOT_FOUND', 'the employee has no current assignment')
}
export async function headcountByPosition(tx: PoolClient): Promise<{ seats: number; filled: number; vacant: number; byDepartment: Array<{ department: string; seats: number; filled: number }> }> {
  const rows = await listPositions(tx, { status: 'active' })
  const dept = new Map<string, { seats: number; filled: number }>()
  for (const p of rows) { const d = dept.get(p.department) ?? { seats: 0, filled: 0 }; d.seats += p.seats; d.filled += p.filled; dept.set(p.department, d) }
  const seats = rows.reduce((s, p) => s + p.seats, 0), filled = rows.reduce((s, p) => s + p.filled, 0)
  return { seats, filled, vacant: Math.max(0, seats - filled), byDepartment: [...dept].map(([department, d]) => ({ department, ...d })) }
}

// ── transfers ────────────────────────────────────────────────────────────────

export interface Transfer { id: string; employee_id: string; effective_from: string; department: string | null; designation: string | null; location_code: string | null; manager_employee_id: string | null; position_id: string | null; reason: string; status: string; approval_request_id: string | null; applied_at: string | null }
const T_COLS = `id, employee_id, effective_from::text, department, designation, location_code, manager_employee_id, position_id, reason, status, approval_request_id, applied_at::text`

export async function requestTransfer(
  tx: PoolClient, cfg: ResolvedConfig,
  args: { employeeId: string; effectiveFrom: string; department?: string | null; designation?: string | null; locationCode?: string | null; managerEmployeeId?: string | null; positionId?: string | null; reason: string; requestedByUserId: string },
): Promise<Transfer> {
  const tid = await tenantId(tx)
  if (!args.reason?.trim()) throw new StructureError('VALIDATION_FAILED', 'a transfer states its reason')
  if (![args.department, args.designation, args.locationCode, args.managerEmployeeId, args.positionId].some((v) => v)) throw new StructureError('VALIDATION_FAILED', 'nothing changes in this transfer')
  if (args.managerEmployeeId === args.employeeId) throw new StructureError('VALIDATION_FAILED', 'a person cannot report to themself')
  if ((await tx.query(`SELECT 1 FROM transfer_requests WHERE employee_id = $1 AND status IN ('pending','approved')`, [args.employeeId])).rowCount) throw new StructureError('TRANSFER_OPEN', 'a transfer is already in flight for this person')
  const { rows } = await tx.query<Transfer>(
    `INSERT INTO transfer_requests (tenant_id, employee_id, effective_from, department, designation, location_code, manager_employee_id, position_id, reason, requested_by_user_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING ${T_COLS}`,
    [tid, args.employeeId, args.effectiveFrom, args.department ?? null, args.designation ?? null, args.locationCode ?? null, args.managerEmployeeId ?? null, args.positionId ?? null, args.reason.trim(), args.requestedByUserId])
  const approval = await raiseWithPolicy(tx, { entityType: 'transfer', entityId: rows[0]!.id, requestedByUserId: args.requestedByUserId, subjectEmployeeId: args.employeeId, magnitude: 1,
    fallback: cfg.get<string>('people.transfer_approval_chain') as ChainCode, title: `Transfer · ${[args.department, args.locationCode, args.designation].filter(Boolean).join(' / ') || 'reporting change'} · from ${args.effectiveFrom}` })
  await tx.query(`UPDATE transfer_requests SET approval_request_id = $2 WHERE id = $1`, [rows[0]!.id, approval.requestId])
  const st = (await tx.query<{ status: string }>(`SELECT status FROM approval_requests WHERE id = $1`, [approval.requestId])).rows[0]
  if (st?.status === 'approved') await settleTransferDecision(tx, { approvalRequestId: approval.requestId, status: 'approved', actorUserId: args.requestedByUserId })
  return (await tx.query<Transfer>(`SELECT ${T_COLS} FROM transfer_requests WHERE id = $1`, [rows[0]!.id])).rows[0]!
}

/** Approved: applied at once when the date has come, else left 'approved' for the nightly job. */
export async function settleTransferDecision(tx: PoolClient, args: { approvalRequestId: string; status: 'approved' | 'rejected'; actorUserId: string }): Promise<{ changed: boolean }> {
  const { rows } = await tx.query<Transfer>(`UPDATE transfer_requests SET status = $2 WHERE approval_request_id = $1 AND status = 'pending' RETURNING ${T_COLS}`, [args.approvalRequestId, args.status])
  if (!rows[0]) return { changed: false }
  if (args.status === 'approved' && rows[0].effective_from <= new Date().toISOString().slice(0, 10)) await applyTransfer(tx, rows[0], args.actorUserId)
  return { changed: true }
}
async function applyTransfer(tx: PoolClient, t: Transfer, actorUserId?: string): Promise<void> {
  const cur = await currentPosting(tx, t.employee_id, t.effective_from)
  await changeAssignment(tx, {
    employeeId: t.employee_id, department: t.department ?? cur?.department ?? '—', designation: t.designation ?? cur?.designation ?? '—',
    managerEmployeeId: t.manager_employee_id ?? undefined, locationCode: t.location_code ?? undefined, effectiveFrom: t.effective_from, reason: `transfer: ${t.reason}`, actorUserId,
  })
  if (t.position_id) await seatEmployee(tx, { employeeId: t.employee_id, positionId: t.position_id })
  await tx.query(`UPDATE transfer_requests SET status = 'applied', applied_at = now() WHERE id = $1`, [t.id])
  const u = await userOf(tx, t.employee_id)
  if (u) await notify(tx, { userId: u, eventType: 'people.transferred', title: `Your transfer is effective ${t.effective_from}`, body: [t.department, t.location_code, t.designation].filter(Boolean).join(' · ') || undefined, entityType: 'transfer', entityId: t.id, dedupeKey: `transfer:${t.id}` })
}
/** Nightly: approved transfers whose date has come. */
export async function applyDueTransfers(tx: PoolClient, today = new Date().toISOString().slice(0, 10), actorUserId?: string): Promise<number> {
  const { rows } = await tx.query<Transfer>(`SELECT ${T_COLS} FROM transfer_requests WHERE status = 'approved' AND effective_from <= $1::date`, [today])
  for (const t of rows) await applyTransfer(tx, t, actorUserId)
  return rows.length
}
export async function listTransfers(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<Transfer[]> {
  return (await tx.query<Transfer>(`SELECT ${T_COLS} FROM transfer_requests WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT 200`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])).rows
}

// ── profile change requests ──────────────────────────────────────────────────

export interface ChangeRequest { id: string; employee_id: string; changes: Record<string, unknown>; evidence_document_id: string | null; note: string | null; status: string; decided_by_user_id: string | null; decided_at: string | null; decision_note: string | null; created_at: string }
const CR_COLS = `id, employee_id, changes, evidence_document_id, note, status, decided_by_user_id, decided_at::text, decision_note, created_at::text`
/** Fields an employee may PROPOSE (HR approves); the self-editable ones need no request. */
export const REQUESTABLE: ReadonlyArray<keyof EmployeePatch> = ['firstName', 'lastName', 'dateOfBirth', 'gender', 'personalEmail', 'phone', 'address', 'emergencyContact']

export async function requestProfileChange(tx: PoolClient, args: { employeeId: string; changes: Partial<EmployeePatch>; evidenceDocumentId?: string | null; note?: string | null }): Promise<ChangeRequest> {
  const tid = await tenantId(tx)
  const keys = Object.keys(args.changes ?? {}) as (keyof EmployeePatch)[]
  if (!keys.length) throw new StructureError('VALIDATION_FAILED', 'nothing to change')
  const bad = keys.filter((k) => !REQUESTABLE.includes(k))
  if (bad.length) throw new StructureError('VALIDATION_FAILED', `cannot request: ${bad.join(', ')}`)
  if ((await tx.query(`SELECT 1 FROM profile_change_requests WHERE employee_id = $1 AND status = 'pending'`, [args.employeeId])).rowCount) throw new StructureError('CHANGE_REQUEST_OPEN', 'you already have a change awaiting HR')
  const { rows } = await tx.query<ChangeRequest>(`INSERT INTO profile_change_requests (tenant_id, employee_id, changes, evidence_document_id, note) VALUES ($1,$2,$3::jsonb,$4,$5) RETURNING ${CR_COLS}`,
    [tid, args.employeeId, JSON.stringify(args.changes), args.evidenceDocumentId ?? null, args.note?.trim() || null])
  for (const h of (await tx.query<{ user_id: string }>(`SELECT user_id FROM user_roles WHERE role = 'hr_admin'`)).rows) {
    await notify(tx, { userId: h.user_id, eventType: 'profile.change.requested', title: `Profile change to review (${keys.join(', ')})`, entityType: 'profile_change_request', entityId: rows[0]!.id, dedupeKey: `pcr:${rows[0]!.id}:${h.user_id}` })
  }
  return rows[0]!
}
export async function decideProfileChange(tx: PoolClient, args: { requestId: string; approve: boolean; actorUserId: string; note?: string | null }): Promise<ChangeRequest> {
  const r = (await tx.query<ChangeRequest>(`SELECT ${CR_COLS} FROM profile_change_requests WHERE id = $1 FOR UPDATE`, [args.requestId])).rows[0]
  if (!r) throw new StructureError('NOT_FOUND', 'no such request')
  if (r.status !== 'pending') throw new StructureError('CHANGE_REQUEST_DECIDED', `already ${r.status}`)
  if (!args.approve && !args.note?.trim()) throw new StructureError('VALIDATION_FAILED', 'say why it is refused')
  if (args.approve) await updateEmployee(tx, r.employee_id, r.changes as EmployeePatch)
  const { rows } = await tx.query<ChangeRequest>(`UPDATE profile_change_requests SET status = $2, decided_by_user_id = $3, decided_at = now(), decision_note = $4 WHERE id = $1 RETURNING ${CR_COLS}`,
    [r.id, args.approve ? 'approved' : 'rejected', args.actorUserId, args.note?.trim() || null])
  const u = await userOf(tx, r.employee_id)
  if (u) await notify(tx, { userId: u, eventType: 'profile.change.decided', title: args.approve ? 'Your profile change was applied' : 'Your profile change was not accepted', body: args.note ?? undefined, entityType: 'profile_change_request', entityId: r.id, dedupeKey: `pcr:decided:${r.id}` })
  return rows[0]!
}
export async function listProfileChanges(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; status?: string }): Promise<ChangeRequest[]> {
  return (await tx.query<ChangeRequest>(`SELECT ${CR_COLS} FROM profile_change_requests WHERE ($1::uuid[] IS NULL OR employee_id = ANY($1)) AND ($2::uuid IS NULL OR employee_id = $2) AND ($3::text IS NULL OR status = $3) ORDER BY created_at DESC LIMIT 200`,
    [args.employeeIds ?? null, args.employeeId ?? null, args.status ?? null])).rows
}
export { SELF_EDITABLE }
