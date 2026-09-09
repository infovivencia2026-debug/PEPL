/**
 * Attendance capture, derivation and the correction model.
 *
 * The hard requirement — HR can add, remove or edit punches and days INSTANTLY —
 * collides with the other hard requirement — payroll must be reproducible. Both
 * are non-negotiable, so the resolution is not to restrict the edit but to
 * constrain how it is recorded and when it can land:
 *
 *   1. corrections are append-only; raw punches are never edited
 *   2. the PERIOD STATE decides what an edit can do
 *        open   -> applies immediately          (the "instant" case)
 *        closed -> refused; needs an audited reopen
 *        frozen -> never touches the past; routed to the next period
 *   3. every correction re-derives the day, and the employee is notified
 */
import type { PoolClient } from 'pg'

export class AttendanceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'AttendanceError'
  }
}

export type CorrectionAction =
  | 'set_punch_in' | 'set_punch_out' | 'add_day' | 'mark_absent' | 'mark_present'
  | 'mark_half_day' | 'mark_full_day' | 'mark_remote' | 'revoke_remote'
  | 'mark_field_duty' | 'mark_leave' | 'clear_leave'

export type PeriodStatus = 'open' | 'closed' | 'frozen'

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new AttendanceError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

/** Idempotent by client_punch_id, so an offline queue can retry safely. */
export async function recordPunch(
  tx: PoolClient,
  p: {
    employeeId: string; punchedAt: string; localDate: string
    direction: 'in' | 'out'; source: 'mobile' | 'web' | 'biometric_import' | 'manual'
    clientPunchId?: string; withinGeofence?: boolean
    geo?: { lat: number; lng: number }
  },
): Promise<boolean> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `INSERT INTO attendance_punches
       (tenant_id, employee_id, punched_at, local_date, direction, source,
        geo_lat, geo_lng, within_geofence, client_punch_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, employee_id, client_punch_id)
       WHERE client_punch_id IS NOT NULL DO NOTHING`,
    [tid, p.employeeId, p.punchedAt, p.localDate, p.direction, p.source,
     p.geo?.lat ?? null, p.geo?.lng ?? null, p.withinGeofence ?? null, p.clientPunchId ?? null],
  )
  return rowCount === 1
}

export async function periodFor(
  tx: PoolClient,
  workDate: string,
): Promise<{ id: string; status: PeriodStatus; period_end: string } | undefined> {
  const { rows } = await tx.query<{ id: string; status: PeriodStatus; period_end: string }>(
    `SELECT id, status, period_end::text
       FROM attendance_periods
      WHERE $1::date BETWEEN period_start AND period_end
      LIMIT 1`,
    [workDate],
  )
  return rows[0]
}

/** Next period after the given date, used to route a deferred correction. */
async function nextPeriodAfter(tx: PoolClient, workDate: string): Promise<string | undefined> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM attendance_periods
      WHERE period_start > $1::date AND status <> 'frozen'
      ORDER BY period_start LIMIT 1`,
    [workDate],
  )
  return rows[0]?.id
}

/**
 * Rebuilds one day from raw punches, then replays corrections over it in order.
 * Idempotent: running it twice produces the same row.
 */
export async function recomputeDay(
  tx: PoolClient,
  employeeId: string,
  workDate: string,
): Promise<void> {
  const tid = await tenantId(tx)

  const { rows: punches } = await tx.query<{ punched_at: string; direction: 'in' | 'out' }>(
    `SELECT punched_at, direction FROM attendance_punches
      WHERE employee_id = $1 AND local_date = $2 ORDER BY punched_at`,
    [employeeId, workDate],
  )

  const ins = punches.filter((p) => p.direction === 'in')
  const outs = punches.filter((p) => p.direction === 'out')
  let firstIn: string | null = ins[0]?.punched_at ?? null
  let lastOut: string | null = outs[outs.length - 1]?.punched_at ?? null

  let status = firstIn ? 'present' : 'absent'
  let dayFraction = firstIn ? 1 : 0
  let fractionSource: string | null = 'system'
  let isRemote = false
  let isFieldDuty = false
  let regularized = false
  let markedBy: string | null = null
  let markedReason: string | null = null

  const { rows: corrections } = await tx.query<{
    action: CorrectionAction; after: Record<string, unknown>
    actor_user_id: string | null; reason: string
  }>(
    `SELECT action, after, actor_user_id, reason
       FROM attendance_corrections
      WHERE employee_id = $1 AND work_date = $2 AND deferred_to_period_id IS NULL
      ORDER BY id`,
    [employeeId, workDate],
  )

  for (const c of corrections) {
    regularized = true
    markedBy = c.actor_user_id
    markedReason = c.reason
    switch (c.action) {
      case 'set_punch_in':
        firstIn = String(c.after.at)
        status = 'present'
        break
      case 'set_punch_out':
        lastOut = String(c.after.at)
        break
      case 'add_day':
      case 'mark_present':
        status = 'present'
        if (dayFraction === 0) dayFraction = 1
        break
      case 'mark_absent':
        status = 'absent'
        dayFraction = 0
        fractionSource = 'manager_marked'
        break
      case 'mark_half_day':
        dayFraction = 0.5
        fractionSource = 'manager_marked'
        if (status === 'absent') status = 'present'
        break
      case 'mark_full_day':
        dayFraction = 1
        fractionSource = 'manager_marked'
        break
      // Remote and field duty are ATTRIBUTES, not statuses: a day can be remote
      // and half-day at once.
      case 'mark_remote':
        isRemote = true
        if (status === 'absent') { status = 'present'; dayFraction = dayFraction || 1 }
        break
      case 'revoke_remote':
        isRemote = false
        break
      case 'mark_field_duty':
        isFieldDuty = true
        status = 'on_duty'
        if (dayFraction === 0) dayFraction = 1
        break
      case 'mark_leave':
        status = 'on_leave'
        fractionSource = 'leave'
        break
      case 'clear_leave':
        status = firstIn ? 'present' : 'absent'
        fractionSource = 'system'
        break
    }
  }

  const worked = firstIn && lastOut
    ? Math.max(0, Math.round((Date.parse(lastOut) - Date.parse(firstIn)) / 60000))
    : 0

  await tx.query(
    `INSERT INTO daily_attendance
       (tenant_id, employee_id, work_date, first_in, last_out, worked_minutes, status,
        day_fraction, fraction_source, is_remote, is_field_duty, is_regularized,
        marked_by_user_id, marked_reason, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14, now())
     ON CONFLICT (tenant_id, employee_id, work_date) DO UPDATE SET
       first_in = EXCLUDED.first_in, last_out = EXCLUDED.last_out,
       worked_minutes = EXCLUDED.worked_minutes, status = EXCLUDED.status,
       day_fraction = EXCLUDED.day_fraction, fraction_source = EXCLUDED.fraction_source,
       is_remote = EXCLUDED.is_remote, is_field_duty = EXCLUDED.is_field_duty,
       is_regularized = EXCLUDED.is_regularized, marked_by_user_id = EXCLUDED.marked_by_user_id,
       marked_reason = EXCLUDED.marked_reason, computed_at = now()`,
    [tid, employeeId, workDate, firstIn, lastOut, worked, status,
     dayFraction, fractionSource, isRemote, isFieldDuty, regularized, markedBy, markedReason],
  )
}

export interface CorrectionInput {
  employeeId: string
  workDate: string
  action: CorrectionAction
  after?: Record<string, unknown>
  reason: string
  actorUserId?: string
  /** Set by a user holding attendance.reopen_period; audited by the caller. */
  allowClosedPeriod?: boolean
}

export interface CorrectionResult {
  applied: boolean
  deferredToPeriodId?: string
  periodStatus: PeriodStatus | 'no_period'
}

/**
 * The single entry point for every manual change to attendance.
 * Instant when the period is open — which is the common case — and structurally
 * incapable of rewriting a period payroll has already frozen.
 */
export async function applyCorrection(
  tx: PoolClient,
  input: CorrectionInput,
): Promise<CorrectionResult> {
  const tid = await tenantId(tx)
  if (!input.reason?.trim()) {
    throw new AttendanceError('CORRECTION_REASON_REQUIRED', 'every attendance correction must carry a reason')
  }

  const period = await periodFor(tx, input.workDate)
  const status: PeriodStatus | 'no_period' = period?.status ?? 'no_period'

  if (status === 'closed' && !input.allowClosedPeriod) {
    throw new AttendanceError(
      'PERIOD_CLOSED',
      `${input.workDate} is in a closed period. Reopening it requires attendance.reopen_period and is audited.`,
    )
  }

  const { rows: beforeRows } = await tx.query(
    `SELECT status, day_fraction, is_remote, is_field_duty
       FROM daily_attendance WHERE employee_id = $1 AND work_date = $2`,
    [input.employeeId, input.workDate],
  )
  const before = beforeRows[0] ?? {}

  // A frozen period is never rewritten. The correction is still RECORDED — the
  // fact happened — but its effect is carried into the next open period as an
  // arrear, exactly like a payroll revision.
  const deferredTo = status === 'frozen' ? await nextPeriodAfter(tx, input.workDate) : undefined
  if (status === 'frozen' && !deferredTo) {
    throw new AttendanceError(
      'PERIOD_FROZEN_NO_TARGET',
      `${input.workDate} is in a frozen period and there is no later open period to carry the correction into`,
    )
  }

  await tx.query(
    `INSERT INTO attendance_corrections
       (tenant_id, employee_id, work_date, action, before, after, reason, actor_user_id,
        source, deferred_to_period_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9,$10)`,
    [tid, input.employeeId, input.workDate, input.action,
     JSON.stringify(before), JSON.stringify(input.after ?? {}),
     input.reason, input.actorUserId ?? null, 'hr_console', deferredTo ?? null],
  )

  if (!deferredTo) {
    await recomputeDay(tx, input.employeeId, input.workDate)
    return { applied: true, periodStatus: status }
  }
  return { applied: false, deferredToPeriodId: deferredTo, periodStatus: status }
}

/** Bulk correction: one reason, many employees, one correction row each. */
export async function applyBulkCorrection(
  tx: PoolClient,
  employeeIds: readonly string[],
  base: Omit<CorrectionInput, 'employeeId'>,
): Promise<CorrectionResult[]> {
  const out: CorrectionResult[] = []
  for (const employeeId of employeeIds) {
    out.push(await applyCorrection(tx, { ...base, employeeId }))
  }
  return out
}

export async function setPeriodStatus(
  tx: PoolClient,
  periodId: string,
  status: PeriodStatus,
  actorUserId?: string,
): Promise<void> {
  const tid = await tenantId(tx)
  await tx.query(
    `UPDATE attendance_periods
        SET status = $3,
            -- $4 is cast explicitly: a NULL parameter inside a CASE is inferred
            -- as text and fails against a uuid column.
            closed_by_user_id = CASE WHEN $3 <> 'open' THEN $4::uuid ELSE NULL END,
            closed_at = CASE WHEN $3 <> 'open' THEN now() ELSE NULL END
      WHERE tenant_id = $1 AND id = $2`,
    [tid, periodId, status, actorUserId ?? null],
  )
}
