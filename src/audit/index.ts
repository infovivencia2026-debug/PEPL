/**
 * The company activity log.
 *
 * Emitted at the SERVICE boundary, inside the SAME transaction as the change:
 * an audit written after commit can be lost on a crash, and one written before
 * can describe a change that rolled back. Either produces a log nobody can rely
 * on, which is worse than no log at all.
 */
import type { PoolClient } from 'pg'

export class AuditError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AuditError'
  }
}

export type Severity = 'info' | 'notice' | 'warning' | 'critical'

interface ActionDef {
  category: string
  severity: Severity
  requiresReason?: boolean
}

/**
 * The closed vocabulary. A CI gate fails the build on an action not declared
 * here, so the log cannot fill up with free-text strings invented per route.
 */
export const ACTIONS: Readonly<Record<string, ActionDef>> = Object.freeze({
  'people.employee.created': { category: 'people', severity: 'info' },
  'people.employee.exited': { category: 'people', severity: 'notice' },
  'people.assignment.changed': { category: 'people', severity: 'info' },
  'people.compensation.changed': { category: 'people', severity: 'notice', requiresReason: true },
  'people.compensation.corrected': { category: 'people', severity: 'warning', requiresReason: true },

  'attendance.day.corrected': { category: 'attendance', severity: 'info', requiresReason: true },
  'attendance.period.closed': { category: 'attendance', severity: 'notice' },
  'attendance.period.reopened': { category: 'attendance', severity: 'warning', requiresReason: true },

  'leave.balance.adjusted': { category: 'leave', severity: 'warning', requiresReason: true },
  'leave.request.approved': { category: 'leave', severity: 'info' },

  'payroll.run.locked': { category: 'payroll', severity: 'critical' },
  'payroll.run.revised': { category: 'payroll', severity: 'critical', requiresReason: true },
  'payroll.bankfile.generated': { category: 'payroll', severity: 'critical' },
  'payroll.bankfile.downloaded': { category: 'payroll', severity: 'critical' },
  // A verified declaration lowers TDS from the next freeze: money, decided by a person.
  'tax_declaration.verified': { category: 'payroll', severity: 'notice' },
  'tax_declaration.rejected': { category: 'payroll', severity: 'info', requiresReason: true },
  // A statutory return leaves the building with UANs, PANs and pay in it.
  'payroll.filing.generated': { category: 'payroll', severity: 'critical' },
  'employee.statutory_ids.changed': { category: 'people', severity: 'notice' },

  'config.setting.changed': { category: 'config', severity: 'notice', requiresReason: false },
  'config.module.disabled': { category: 'config', severity: 'warning', requiresReason: true },

  'security.login.failed': { category: 'security', severity: 'notice' },
  'security.permission.denied': { category: 'security', severity: 'notice' },

  // READS of sensitive data are logged. This is the half usually skipped, and
  // the half that makes a breach investigation answerable at all.
  'access.tier3.revealed': { category: 'access', severity: 'warning' },
  'access.support.started': { category: 'access', severity: 'critical' },
  'access.record.viewed': { category: 'access', severity: 'notice' },

  'data.export.completed': { category: 'data', severity: 'warning' },
  'data.erasure.completed': { category: 'data', severity: 'critical', requiresReason: true },
  'data.retention.purged': { category: 'data', severity: 'notice' },
  'data.import.committed': { category: 'data', severity: 'notice' },

  'data.document.uploaded': { category: 'data', severity: 'info' },
  'data.document.downloaded': { category: 'data', severity: 'notice' },
  'data.document.deleted': { category: 'data', severity: 'warning', requiresReason: true },

  'comms.message.sent': { category: 'comms', severity: 'info' },
  'comms.conversation.created': { category: 'comms', severity: 'info' },
  'mail.message.sent': { category: 'comms', severity: 'notice' },
  'mail.account.connected': { category: 'comms', severity: 'notice' },
})

/** Fields never written in full, whatever the caller passes. */
const TIER3_FIELDS = new Set([
  'annual_ctc_paise', 'ctc', 'basic', 'gross', 'net', 'net_paise',
  'bank_account', 'account_number', 'ifsc', 'pan', 'pan_enc', 'uan', 'uan_enc',
  'aadhaar', 'salary', 'components', 'monthly_components',
])

/** Never written at all, in any circumstance. */
const NEVER = new Set(['password', 'password_hash', 'secret', 'secret_ciphertext', 'token', 'refresh_token'])

/**
 * Tier-3 values appear only when the action IS a change to that kind of field;
 * everything else records that it changed, not what it changed to. A log that
 * leaks what the UI protects is a lateral path around the permission model.
 */
export function maskPayload(
  payload: Record<string, unknown> | null | undefined,
  action: string,
): Record<string, unknown> | null {
  if (!payload) return null
  const allowTier3 = action.startsWith('people.compensation.')
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(payload)) {
    const key = k.toLowerCase()
    if (NEVER.has(key)) continue
    if (TIER3_FIELDS.has(key) && !allowTier3) {
      out[k] = { changed: true }
      continue
    }
    out[k] = v
  }
  return out
}

export interface EmitInput {
  action: string
  entityType: string
  entityId?: string
  entityLabel?: string
  subjectEmployeeId?: string
  actorUserId?: string
  actorLabel?: string
  actorType?: 'user' | 'system' | 'integration' | 'support' | 'anonymous'
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
  metadata?: Record<string, unknown>
  reason?: string
  source?: string
}

export async function emit(tx: PoolClient, input: EmitInput): Promise<void> {
  const def = ACTIONS[input.action]
  if (!def) {
    throw new AuditError(
      'UNKNOWN_ACTION',
      `"${input.action}" is not in the audit action registry — add it there, not as a free-text string`,
    )
  }
  if (def.requiresReason && !input.reason?.trim()) {
    throw new AuditError('REASON_REQUIRED', `"${input.action}" requires a reason`)
  }

  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const tid = rows[0]?.t
  if (!tid) throw new AuditError('NO_TENANT_CONTEXT', 'audit emitted without a tenant context')

  await tx.query(
    `INSERT INTO audit_events
       (tenant_id, actor_user_id, actor_type, actor_label, action, category, severity,
        entity_type, entity_id, entity_label, subject_employee_id,
        before, after, metadata, reason, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15,$16)`,
    [tid, input.actorUserId ?? null, input.actorType ?? 'user', input.actorLabel ?? null,
     input.action, def.category, def.severity,
     input.entityType, input.entityId ?? null, input.entityLabel ?? null,
     input.subjectEmployeeId ?? null,
     JSON.stringify(maskPayload(input.before, input.action)),
     JSON.stringify(maskPayload(input.after, input.action)),
     JSON.stringify(input.metadata ?? {}), input.reason ?? null, input.source ?? 'web'],
  )
}

export interface ChainCheck {
  ok: boolean
  checked: number
  brokenAtId?: string
}

/**
 * Re-walks the per-tenant hash chain. A retrospective edit or a deleted row
 * breaks the link and is located here. This is what converts the log from
 * "trust the operator" into "verify", and a tenant's own auditor can run it.
 */
export async function verifyChain(tx: PoolClient): Promise<ChainCheck> {
  const { rows } = await tx.query<{ id: string; ok: boolean }>(
    `SELECT id,
            row_hash = digest(
              coalesce(encode(prev_hash, 'hex'), '') ||
              tenant_id::text || action || entity_type ||
              coalesce(entity_id::text, '') || coalesce(actor_user_id::text, '') ||
              coalesce(before::text, '') || coalesce(after::text, '') ||
              occurred_at::text,
              'sha256') AS ok
       FROM audit_events
      ORDER BY id`,
  )

  let prevHashOk = true
  const { rows: links } = await tx.query<{ id: string; linked: boolean }>(
    `SELECT e.id,
            e.prev_hash IS NOT DISTINCT FROM lag(e.row_hash) OVER (ORDER BY e.id) AS linked
       FROM audit_events e
      ORDER BY e.id`,
  )
  for (const l of links) {
    if (!l.linked) {
      prevHashOk = false
      return { ok: false, checked: rows.length, brokenAtId: l.id }
    }
  }

  const bad = rows.find((r) => !r.ok)
  if (bad) return { ok: false, checked: rows.length, brokenAtId: bad.id }

  return { ok: prevHashOk, checked: rows.length }
}

export interface ActivityFilter {
  category?: string
  actorUserId?: string
  subjectEmployeeId?: string
  severity?: Severity
  limit?: number
}

export async function activity(tx: PoolClient, f: ActivityFilter = {}): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT occurred_at, actor_user_id, actor_label, action, category, severity,
            entity_type, entity_label, before, after, reason
       FROM audit_events
      WHERE ($1::text IS NULL OR category = $1)
        AND ($2::uuid IS NULL OR actor_user_id = $2)
        AND ($3::uuid IS NULL OR subject_employee_id = $3)
        AND ($4::text IS NULL OR severity = $4)
      ORDER BY id DESC
      LIMIT $5`,
    [f.category ?? null, f.actorUserId ?? null, f.subjectEmployeeId ?? null,
     f.severity ?? null, f.limit ?? 100],
  )
  return rows
}

/**
 * What an EMPLOYEE can see about their own record — including every access to
 * their own tier-3 data. Being able to see who looked at your salary is both a
 * transparency measure and a strong deterrent against casual snooping.
 */
export async function myRecordAccess(
  tx: PoolClient,
  employeeId: string,
): Promise<Record<string, unknown>[]> {
  const { rows } = await tx.query(
    `SELECT occurred_at, actor_user_id, actor_label, action, metadata
       FROM audit_events
      WHERE subject_employee_id = $1
        AND category IN ('access', 'people')
      ORDER BY id DESC`,
    [employeeId],
  )
  return rows
}
