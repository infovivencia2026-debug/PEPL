/**
 * Leave balances are derived, never stored.
 *
 *   balance(employee, type, cycle) = SUM(delta_days) over leave_ledger
 *
 * Every movement is an entry. A cancellation writes a reversal; the annual
 * rollover writes lapse and carry_forward entries. Nothing is ever mutated, so
 * a balance is always explainable and a failed rollover is visible rather than
 * silently carrying stale numbers into the new year.
 */
import type { PoolClient } from 'pg'

export class LeaveError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'LeaveError'
  }
}

export type EntryType =
  | 'opening' | 'accrual' | 'consumption' | 'reversal'
  | 'encashment' | 'lapse' | 'carry_forward' | 'adjustment'

export interface Balance {
  opening: number
  accrued: number
  consumed: number
  adjusted: number
  available: number
}

async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new LeaveError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}

interface EntryInput {
  employeeId: string
  leaveTypeId: string
  entryType: EntryType
  deltaDays: number
  effectiveDate: string
  cycleYear: number
  sourceType?: string
  sourceId?: string
  idempotencyKey?: string
  note?: string
  actorUserId?: string
}

/** Returns false when an idempotency key has already been used — a no-op, not an error. */
export async function appendEntry(tx: PoolClient, e: EntryInput): Promise<boolean> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `INSERT INTO leave_ledger
       (tenant_id, employee_id, leave_type_id, entry_type, delta_days, effective_date,
        cycle_year, source_type, source_id, idempotency_key, note, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL
     DO NOTHING`,
    [tid, e.employeeId, e.leaveTypeId, e.entryType, e.deltaDays, e.effectiveDate,
     e.cycleYear, e.sourceType ?? null, e.sourceId ?? null, e.idempotencyKey ?? null,
     e.note ?? null, e.actorUserId ?? null],
  )
  return rowCount === 1
}

export async function balance(
  tx: PoolClient,
  employeeId: string,
  leaveTypeId: string,
  cycleYear: number,
  asOf?: string,
): Promise<Balance> {
  const { rows } = await tx.query<{ entry_type: EntryType; total: string }>(
    `SELECT entry_type, COALESCE(SUM(delta_days), 0)::text AS total
       FROM leave_ledger
      WHERE employee_id = $1 AND leave_type_id = $2 AND cycle_year = $3
        AND ($4::date IS NULL OR effective_date <= $4::date)
      GROUP BY entry_type`,
    [employeeId, leaveTypeId, cycleYear, asOf ?? null],
  )

  const by = (t: EntryType): number => Number(rows.find((r) => r.entry_type === t)?.total ?? 0)

  const opening = by('opening') + by('carry_forward')
  const accrued = by('accrual')
  // consumption and reversal are stored signed; consumed is reported positive
  const consumed = -(by('consumption') + by('reversal'))
  const adjusted = by('adjustment') + by('encashment') + by('lapse')

  return {
    opening,
    accrued,
    consumed,
    adjusted,
    available: Number((opening + accrued + adjusted - consumed).toFixed(2)),
  }
}

/**
 * Monthly accrual. Keyed on (employee, type, cycle, period) so re-running the job
 * — after a crash, or twice by a scheduler — cannot double-credit.
 */
export async function accrueMonthly(
  tx: PoolClient,
  args: { employeeId: string; leaveTypeId: string; cycleYear: number; period: string; units: number; effectiveDate: string },
): Promise<boolean> {
  return appendEntry(tx, {
    employeeId: args.employeeId,
    leaveTypeId: args.leaveTypeId,
    entryType: 'accrual',
    deltaDays: args.units,
    effectiveDate: args.effectiveDate,
    cycleYear: args.cycleYear,
    sourceType: 'accrual_run',
    idempotencyKey: `accrual:${args.employeeId}:${args.leaveTypeId}:${args.cycleYear}:${args.period}`,
    note: `monthly accrual ${args.period}`,
  })
}

export async function consume(
  tx: PoolClient,
  args: {
    employeeId: string; leaveTypeId: string; cycleYear: number; days: number
    effectiveDate: string; requestId: string; allowNegative?: boolean
  },
): Promise<void> {
  if (args.days <= 0) throw new LeaveError('INVALID_DAYS', 'consumption must be positive')

  const bal = await balance(tx, args.employeeId, args.leaveTypeId, args.cycleYear)
  if (!args.allowNegative && bal.available < args.days) {
    throw new LeaveError(
      'INSUFFICIENT_BALANCE',
      `balance is ${bal.available} day(s); ${args.days} requested. Enable leave.allow_negative_balance to permit going negative.`,
    )
  }

  await appendEntry(tx, {
    employeeId: args.employeeId,
    leaveTypeId: args.leaveTypeId,
    entryType: 'consumption',
    deltaDays: -args.days,
    effectiveDate: args.effectiveDate,
    cycleYear: args.cycleYear,
    sourceType: 'leave_request',
    sourceId: args.requestId,
    idempotencyKey: `consume:${args.requestId}`,
  })
}

/** Cancelling approved leave writes a reversal. The consumption stays. */
export async function reverse(
  tx: PoolClient,
  args: { employeeId: string; leaveTypeId: string; cycleYear: number; days: number; effectiveDate: string; requestId: string; note?: string },
): Promise<void> {
  await appendEntry(tx, {
    employeeId: args.employeeId,
    leaveTypeId: args.leaveTypeId,
    entryType: 'reversal',
    deltaDays: args.days,
    effectiveDate: args.effectiveDate,
    cycleYear: args.cycleYear,
    sourceType: 'leave_request',
    sourceId: args.requestId,
    idempotencyKey: `reverse:${args.requestId}`,
    note: args.note ?? 'leave cancelled',
  })
}

/**
 * Year end. Carries forward up to the cap and LAPSES the remainder — both as
 * entries, so the rollover is visible and auditable instead of an invisible
 * reset that can silently fail.
 */
export async function rollover(
  tx: PoolClient,
  args: {
    employeeId: string; leaveTypeId: string
    fromCycle: number; toCycle: number
    carryForwardLimit: number
    cycleEndDate: string; nextCycleStartDate: string
  },
): Promise<{ carriedForward: number; lapsed: number }> {
  const bal = await balance(tx, args.employeeId, args.leaveTypeId, args.fromCycle)
  const closing = bal.available
  const carried = Math.max(0, Math.min(closing, args.carryForwardLimit))
  const lapsed = Math.max(0, closing - carried)
  const key = `${args.employeeId}:${args.leaveTypeId}:${args.fromCycle}`

  if (lapsed > 0) {
    await appendEntry(tx, {
      employeeId: args.employeeId, leaveTypeId: args.leaveTypeId,
      entryType: 'lapse', deltaDays: -lapsed,
      effectiveDate: args.cycleEndDate, cycleYear: args.fromCycle,
      sourceType: 'rollover', idempotencyKey: `lapse:${key}`,
      note: `lapsed at end of cycle ${args.fromCycle}`,
    })
  }
  if (carried > 0) {
    // A transfer has two legs. Writing only the credit would leave the same days
    // spendable in BOTH cycles — the balance for the closed year must go to zero.
    await appendEntry(tx, {
      employeeId: args.employeeId, leaveTypeId: args.leaveTypeId,
      entryType: 'carry_forward', deltaDays: -carried,
      effectiveDate: args.cycleEndDate, cycleYear: args.fromCycle,
      sourceType: 'rollover', idempotencyKey: `carry-out:${key}`,
      note: `carried forward into cycle ${args.toCycle}`,
    })
    await appendEntry(tx, {
      employeeId: args.employeeId, leaveTypeId: args.leaveTypeId,
      entryType: 'carry_forward', deltaDays: carried,
      effectiveDate: args.nextCycleStartDate, cycleYear: args.toCycle,
      sourceType: 'rollover', idempotencyKey: `carry-in:${key}`,
      note: `carried forward from cycle ${args.fromCycle}`,
    })
  }
  return { carriedForward: carried, lapsed }
}

/** Work on a weekly off or holiday. One credit per date, enforced by the schema. */
export async function creditCompOff(
  tx: PoolClient,
  args: { employeeId: string; workDate: string; expiresOn: string },
): Promise<boolean> {
  const tid = await tenantId(tx)
  const { rowCount } = await tx.query(
    `INSERT INTO comp_off_credits (tenant_id, employee_id, work_date, expires_on)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, employee_id, work_date) DO NOTHING`,
    [tid, args.employeeId, args.workDate, args.expiresOn],
  )
  return rowCount === 1
}
