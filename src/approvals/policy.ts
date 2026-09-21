/**
 * Which chain, and who sits on it — see 041_approval_policies.sql.
 *
 *   chooseChain      the most specific active policy for (entity, department,
 *                    magnitude); else the module's default setting
 *   resolveApprovers manager from the reporting line, dept_head from the
 *                    department master's `headUserId`, hr and finance from the
 *                    roles held — each redirected by an active delegation
 *   raiseWithPolicy  the two above, then approvals.raise()
 *   escalateStale    a job: a step pending past the company's limit is skipped
 *                    with escalated_at set, so the request reaches the next
 *                    person instead of dying in an inbox
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'
import { ApprovalError, CHAINS, raise, type ChainCode, type StepRole } from './index.ts'

export const POLICY_CHAINS: readonly ChainCode[] = Object.keys(CHAINS) as ChainCode[]

export interface Policy {
  id: string
  entity_type: string
  chain_code: ChainCode
  min_magnitude: string | null
  department_code: string | null
  status: 'active' | 'retired'
}

const COLUMNS = 'id, entity_type, chain_code, min_magnitude::text, department_code, status'

export async function listPolicies(tx: PoolClient, entityType?: string, includeRetired = false): Promise<Policy[]> {
  const { rows } = await tx.query<Policy>(
    `SELECT ${COLUMNS} FROM approval_policies
      WHERE ($1::text IS NULL OR entity_type = $1) AND ($2 OR status = 'active')
      ORDER BY entity_type, department_code NULLS LAST, min_magnitude DESC NULLS LAST`, [entityType ?? null, includeRetired])
  return rows
}

export async function createPolicy(
  tx: PoolClient,
  i: { entityType: string; chainCode: ChainCode; minMagnitude?: number | null; departmentCode?: string | null; actorUserId?: string },
): Promise<Policy> {
  if (!/^[a-z_]{2,40}$/.test(i.entityType)) throw new ApprovalError('VALIDATION_FAILED', 'entityType is a lower-case identifier, e.g. leave')
  if (!POLICY_CHAINS.includes(i.chainCode)) throw new ApprovalError('UNKNOWN_CHAIN', `chainCode must be one of ${POLICY_CHAINS.join(', ')}`)
  if (i.minMagnitude != null && !(Number(i.minMagnitude) >= 0)) throw new ApprovalError('VALIDATION_FAILED', 'minMagnitude must be a non-negative number')
  const dept = i.departmentCode?.trim().toUpperCase() || null
  if (dept) {
    const d = await tx.query(`SELECT 1 FROM org_units WHERE kind = 'department' AND code = $1 AND status = 'active'`, [dept])
    if (!d.rowCount) throw new ApprovalError('UNKNOWN_UNIT', `"${dept}" is not an active department`)
  }
  const dup = await tx.query(
    `SELECT 1 FROM approval_policies WHERE entity_type = $1 AND status = 'active'
        AND department_code IS NOT DISTINCT FROM $2 AND min_magnitude IS NOT DISTINCT FROM $3::numeric`,
    [i.entityType, dept, i.minMagnitude ?? null])
  if (dup.rowCount) throw new ApprovalError('POLICY_EXISTS', 'a policy with that scope and threshold already exists; retire it first')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { rows } = await tx.query<Policy>(
    `INSERT INTO approval_policies (tenant_id, entity_type, chain_code, min_magnitude, department_code, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING ${COLUMNS}`,
    [tid, i.entityType, i.chainCode, i.minMagnitude ?? null, dept, i.actorUserId ?? null])
  return rows[0]!
}

export async function retirePolicy(tx: PoolClient, id: string): Promise<Policy> {
  const { rows } = await tx.query<Policy>(
    `UPDATE approval_policies SET status = 'retired', retired_at = now() WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new ApprovalError('NOT_FOUND', 'no active policy with that id')
  return rows[0]
}

/**
 * Most specific wins: department over company-wide, then the largest
 * threshold the magnitude satisfies. Nothing matching → the fallback.
 */
export async function chooseChain(
  tx: PoolClient,
  args: { entityType: string; departmentCode?: string | null; magnitude?: number; fallback: ChainCode },
): Promise<{ chainCode: ChainCode; policyId: string | null }> {
  const { rows } = await tx.query<Policy>(
    `SELECT ${COLUMNS} FROM approval_policies
      WHERE entity_type = $1 AND status = 'active'
        AND (department_code IS NULL OR department_code = $2)
        AND (min_magnitude IS NULL OR min_magnitude <= $3::numeric)
      ORDER BY (department_code IS NOT NULL) DESC, min_magnitude DESC NULLS LAST
      LIMIT 1`,
    [args.entityType, args.departmentCode?.toUpperCase() ?? null, args.magnitude ?? 0])
  return rows[0] ? { chainCode: rows[0].chain_code, policyId: rows[0].id } : { chainCode: args.fallback, policyId: null }
}

export interface Resolved {
  approvers: Partial<Record<StepRole, string>>
  /** role → the person the step was redirected from, when a delegation applied */
  delegatedFrom: Partial<Record<StepRole, string>>
  departmentCode: string | null
}

/** Follows one hop of delegation active on `onDate`. One hop: a chain of delegations is a mess, not a policy. */
async function delegateOf(tx: PoolClient, userId: string | undefined, onDate: string): Promise<string | undefined> {
  if (!userId) return undefined
  const { rows } = await tx.query<{ to_user_id: string }>(
    `SELECT to_user_id FROM approval_delegations WHERE from_user_id = $1 AND $2::date BETWEEN from_date AND to_date
      ORDER BY created_at DESC LIMIT 1`, [userId, onDate])
  return rows[0]?.to_user_id
}

export async function resolveApprovers(tx: PoolClient, subjectEmployeeId: string, onDate = new Date().toISOString().slice(0, 10)): Promise<Resolved> {
  const { rows: a } = await tx.query<{ department: string | null; manager_user_id: string | null }>(
    `SELECT a.department,
            (SELECT u.id FROM app_users u WHERE (u.tenant_id, u.employee_id) = (a.tenant_id, a.manager_employee_id) LIMIT 1) AS manager_user_id
       FROM employee_assignments a
      WHERE a.employee_id = $1 AND a.superseded_at IS NULL AND (a.effective_to IS NULL OR a.effective_to > $2::date)
      ORDER BY a.effective_from DESC LIMIT 1`, [subjectEmployeeId, onDate])
  const departmentCode = a[0]?.department ?? null

  const roleUser = async (role: string): Promise<string | undefined> =>
    (await tx.query<{ user_id: string }>(`SELECT user_id FROM user_roles WHERE role = $1 ORDER BY user_id LIMIT 1`, [role])).rows[0]?.user_id
  const deptHead = departmentCode
    ? (await tx.query<{ head: string | null }>(
        `SELECT attributes ->> 'headUserId' AS head FROM org_units WHERE kind = 'department' AND code = $1`, [departmentCode])).rows[0]?.head ?? undefined
    : undefined

  const raw: Partial<Record<StepRole, string | undefined>> = {
    manager: a[0]?.manager_user_id ?? undefined,
    dept_head: deptHead,
    hr: await roleUser('hr_admin'),
    finance: await roleUser('finance'),
  }
  const approvers: Partial<Record<StepRole, string>> = {}
  const delegatedFrom: Partial<Record<StepRole, string>> = {}
  for (const role of Object.keys(raw) as StepRole[]) {
    const original = raw[role]
    if (!original) continue
    const delegate = await delegateOf(tx, original, onDate)
    approvers[role] = delegate ?? original
    if (delegate) delegatedFrom[role] = original
  }
  return { approvers, delegatedFrom, departmentCode }
}

export async function raiseWithPolicy(
  tx: PoolClient,
  args: {
    entityType: string; entityId: string; requestedByUserId: string; subjectEmployeeId: string
    title: string; magnitude?: number; fallback: ChainCode
  },
): Promise<{ requestId: string; chainCode: ChainCode; policyId: string | null; approvers: Partial<Record<StepRole, string>> }> {
  const resolved = await resolveApprovers(tx, args.subjectEmployeeId)
  const chain = await chooseChain(tx, { entityType: args.entityType, departmentCode: resolved.departmentCode, magnitude: args.magnitude, fallback: args.fallback })
  const requestId = await raise(tx, {
    entityType: args.entityType, entityId: args.entityId, requestedByUserId: args.requestedByUserId,
    subjectEmployeeId: args.subjectEmployeeId, chainCode: chain.chainCode, title: args.title, approvers: resolved.approvers,
  })
  for (const [role, from] of Object.entries(resolved.delegatedFrom)) {
    await tx.query(
      `UPDATE approval_steps SET delegated_from_user_id = $3 WHERE approval_request_id = $1 AND approver_role = $2`,
      [requestId, role, from])
  }
  return { requestId, ...chain, approvers: resolved.approvers }
}

// ---- delegations -----------------------------------------------------------
export interface Delegation { id: string; from_user_id: string; to_user_id: string; from_date: string; to_date: string; reason: string | null }
const D_COLS = 'id, from_user_id, to_user_id, from_date::text, to_date::text, reason'

export async function listDelegations(tx: PoolClient, userId?: string): Promise<Delegation[]> {
  const { rows } = await tx.query<Delegation>(
    `SELECT ${D_COLS} FROM approval_delegations WHERE $1::uuid IS NULL OR from_user_id = $1 OR to_user_id = $1 ORDER BY from_date DESC`, [userId ?? null])
  return rows
}

export async function createDelegation(
  tx: PoolClient,
  i: { fromUserId: string; toUserId: string; fromDate: string; toDate: string; reason?: string; actorUserId?: string },
): Promise<Delegation> {
  if (i.fromUserId === i.toUserId) throw new ApprovalError('VALIDATION_FAILED', 'you cannot delegate to yourself')
  if (i.toDate < i.fromDate) throw new ApprovalError('VALIDATION_FAILED', 'toDate is before fromDate')
  const span = (Date.parse(i.toDate) - Date.parse(i.fromDate)) / 86_400_000
  if (span > 90) throw new ApprovalError('VALIDATION_FAILED', 'a delegation runs at most 90 days; a longer absence is a reporting-line change')
  const target = await tx.query(`SELECT 1 FROM app_users WHERE id = $1 AND status = 'active'`, [i.toUserId])
  if (!target.rowCount) throw new ApprovalError('NOT_FOUND', 'the delegate is not an active user here')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { rows } = await tx.query<Delegation>(
    `INSERT INTO approval_delegations (tenant_id, from_user_id, to_user_id, from_date, to_date, reason, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING ${D_COLS}`,
    [tid, i.fromUserId, i.toUserId, i.fromDate, i.toDate, i.reason ?? null, i.actorUserId ?? null])
  return rows[0]!
}

export async function endDelegation(tx: PoolClient, id: string, fromUserId?: string): Promise<boolean> {
  const r = await tx.query(`DELETE FROM approval_delegations WHERE id = $1 AND ($2::uuid IS NULL OR from_user_id = $2)`, [id, fromUserId ?? null])
  return (r.rowCount ?? 0) > 0
}

/**
 * Steps pending longer than `afterDays` are skipped with escalated_at set and
 * the request advances. A step with nobody after it is left alone: skipping
 * the last approver would approve by neglect, which is worse than waiting.
 */
/**
 * Daily nudge for a step pending longer than `afterDays`; when it is the last
 * step of its chain, HR is copied, because nobody else can unblock it.
 * Returns the number of approvers reminded.
 */
export async function remindStale(tx: PoolClient, afterDays: number, now = new Date()): Promise<number> {
  if (afterDays <= 0) return 0
  const cutoff = new Date(now.getTime() - afterDays * 86_400_000).toISOString()
  const { rows } = await tx.query<{ request_id: string; step_no: number; approver: string; title: string; entity_type: string; is_last: boolean; age_days: number }>(
    `SELECT s.approval_request_id AS request_id, s.step_no, s.approver_user_id AS approver, r.title, r.entity_type,
            NOT EXISTS (SELECT 1 FROM approval_steps n WHERE n.approval_request_id = s.approval_request_id AND n.step_no > s.step_no AND n.status = 'pending') AS is_last,
            floor(extract(epoch FROM ($2::timestamptz - r.created_at)) / 86400)::int AS age_days
       FROM approval_steps s
       JOIN approval_requests r ON (r.tenant_id, r.id) = (s.tenant_id, s.approval_request_id)
      WHERE r.status = 'pending' AND s.status = 'pending' AND s.step_no = r.current_step AND s.approver_user_id IS NOT NULL
        AND r.created_at < $1::timestamptz
        AND (s.reminded_at IS NULL OR s.reminded_at < $2::timestamptz - interval '23 hours')`,
    [cutoff, now.toISOString()])
  const day = now.toISOString().slice(0, 10)
  for (const s of rows) {
    await notify(tx, { userId: s.approver, eventType: 'approval.reminder', title: `Waiting ${s.age_days} day(s): ${s.title}`,
      body: 'This approval is pending with you.', entityType: 'approval_request', entityId: s.request_id, dedupeKey: `remind:${s.request_id}:${s.step_no}:${day}` })
    if (s.is_last) {
      const { rows: hr } = await tx.query<{ user_id: string }>(`SELECT user_id FROM user_roles WHERE role = 'hr_admin' AND user_id <> $1`, [s.approver])
      for (const h of hr) {
        await notify(tx, { userId: h.user_id, eventType: 'approval.stuck', title: `Stuck ${s.age_days} day(s) at the last approver: ${s.title}`,
          body: 'Nobody after this approver can move it. Delegate or decide.', entityType: 'approval_request', entityId: s.request_id, dedupeKey: `stuck:${s.request_id}:${h.user_id}:${day}` })
      }
    }
    await tx.query(`UPDATE approval_steps SET reminded_at = $3 WHERE approval_request_id = $1 AND step_no = $2`, [s.request_id, s.step_no, now.toISOString()])
  }
  return rows.length
}

export async function escalateStale(tx: PoolClient, afterDays: number, now = new Date()): Promise<number> {
  if (afterDays <= 0) return 0
  const cutoff = new Date(now.getTime() - afterDays * 86_400_000).toISOString()
  const { rows } = await tx.query<{ request_id: string; step_no: number }>(
    `SELECT s.approval_request_id AS request_id, s.step_no
       FROM approval_steps s
       JOIN approval_requests r ON (r.tenant_id, r.id) = (s.tenant_id, s.approval_request_id)
      WHERE r.status = 'pending' AND s.status = 'pending' AND s.step_no = r.current_step
        AND r.created_at < $1::timestamptz
        AND EXISTS (SELECT 1 FROM approval_steps n WHERE n.approval_request_id = s.approval_request_id AND n.step_no > s.step_no AND n.status = 'pending')`,
    [cutoff])
  for (const s of rows) {
    await tx.query(
      `UPDATE approval_steps SET status = 'skipped', decided_at = now(), escalated_at = now()
        WHERE approval_request_id = $1 AND step_no = $2`, [s.request_id, s.step_no])
    const next = await tx.query<{ step_no: number }>(
      `SELECT step_no FROM approval_steps WHERE approval_request_id = $1 AND status = 'pending' ORDER BY step_no LIMIT 1`, [s.request_id])
    await tx.query(`UPDATE approval_requests SET current_step = $2 WHERE id = $1`, [s.request_id, next.rows[0]!.step_no])
  }
  return rows.length
}
