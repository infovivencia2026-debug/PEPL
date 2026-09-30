/**
 * Separations: the record, and the settlement's place in payroll.
 *
 *   initiated ──(final run frozen)──▶ in_payroll ──(run locked)──▶ settled
 *        │
 *        └──cancel──▶ cancelled                  (a rehire starts a new one)
 *
 * The settlement is computed twice: as a PREVIEW whenever HR asks, and FOR
 * REAL exactly once, when the run covering the last working day is frozen —
 * written to the separation as values and to the run as adhoc lines. After
 * that a changed leave balance or a corrected salary does not move it; a
 * correction is a revision of the run, like any other.
 */
import type { PoolClient } from 'pg'
import { endAccessForEmployee } from '../people/access.ts'
import { balance } from '../leave/ledger.ts'
import { listLeaveTypes } from '../leave/policy.ts'
import {
  gratuity, leaveEncashment, noticeRecovery, settlementLines, type Settlement,
} from './settlement.ts'

export class ExitError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'ExitError'
  }
}

export type SeparationReason =
  'resignation' | 'termination' | 'retirement' | 'end_of_contract' | 'death' | 'absconding'

export interface Separation {
  id: string
  employee_id: string
  reason: SeparationReason
  initiated_on: string
  last_working_day: string
  notice_days_required: number
  notice_waived: boolean
  recoveries_paise: string
  recoveries_note: string | null
  status: 'initiated' | 'in_payroll' | 'settled' | 'cancelled'
  settlement: Settlement | null
  settlement_run_id: string | null
  settled_at: string | null
  note: string | null
}

const COLUMNS = `id, employee_id, reason, initiated_on::text, last_working_day::text, notice_days_required,
  notice_waived, recoveries_paise::text, recoveries_note, status, settlement, settlement_run_id,
  settled_at::text, note`

const REASONS: SeparationReason[] = ['resignation', 'termination', 'retirement', 'end_of_contract', 'death', 'absconding']

export async function initiateSeparation(
  tx: PoolClient,
  args: {
    employeeId: string; reason: SeparationReason; lastWorkingDay: string; initiatedOn?: string
    noticeDaysRequired?: number; noticeWaived?: boolean; recoveriesPaise?: number; recoveriesNote?: string
    note?: string; actorUserId: string
  },
): Promise<Separation> {
  if (!REASONS.includes(args.reason)) throw new ExitError('VALIDATION_FAILED', `reason must be one of ${REASONS.join(', ')}`)
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const { rows: emp } = await tx.query<{ status: string; date_of_joining: string }>(
    `SELECT status, date_of_joining::text FROM employees WHERE id = $1`, [args.employeeId])
  if (!emp[0]) throw new ExitError('NOT_FOUND', 'no such employee')
  if (emp[0].status === 'exited') throw new ExitError('ALREADY_EXITED', 'this employee has already left')
  if (args.lastWorkingDay < emp[0].date_of_joining) {
    throw new ExitError('VALIDATION_FAILED', 'last working day is before the date of joining')
  }
  // Checked before inserting: a unique violation would abort the caller's
  // transaction, and the caller may have work in it. The index still guards a race.
  const open = await tx.query(
    `SELECT 1 FROM employee_separations WHERE employee_id = $1 AND status IN ('initiated','in_payroll')`,
    [args.employeeId])
  if (open.rowCount) throw new ExitError('SEPARATION_OPEN', 'this employee already has a separation in progress')
  try {
    const { rows } = await tx.query<Separation>(
      `INSERT INTO employee_separations
         (tenant_id, employee_id, reason, initiated_on, last_working_day, notice_days_required,
          notice_waived, recoveries_paise, recoveries_note, note, initiated_by_user_id)
       VALUES ($1,$2,$3,coalesce($4::date, CURRENT_DATE),$5,$6,$7,$8,$9,$10,$11)
       RETURNING ${COLUMNS}`,
      [tid, args.employeeId, args.reason, args.initiatedOn ?? null, args.lastWorkingDay,
       args.noticeDaysRequired ?? 0, args.noticeWaived ?? false, Math.round(args.recoveriesPaise ?? 0),
       args.recoveriesNote ?? null, args.note ?? null, args.actorUserId])
    return rows[0]!
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      throw new ExitError('SEPARATION_OPEN', 'this employee already has a separation in progress')
    }
    throw err
  }
}

export async function getSeparation(tx: PoolClient, employeeId: string): Promise<Separation | null> {
  const { rows } = await tx.query<Separation>(
    `SELECT ${COLUMNS} FROM employee_separations WHERE employee_id = $1
      ORDER BY (status IN ('initiated','in_payroll')) DESC, created_at DESC LIMIT 1`, [employeeId])
  return rows[0] ?? null
}

export async function cancelSeparation(tx: PoolClient, id: string, reason: string): Promise<Separation> {
  if (!reason.trim()) throw new ExitError('REASON_REQUIRED', 'say why the exit is being cancelled')
  const { rows } = await tx.query<Separation>(
    `UPDATE employee_separations SET status = 'cancelled', note = coalesce(note || E'\\n', '') || $2
      WHERE id = $1 AND status = 'initiated' RETURNING ${COLUMNS}`, [id, `cancelled: ${reason.trim()}`])
  if (!rows[0]) throw new ExitError('SEPARATION_NOT_OPEN', 'only a separation not yet in payroll can be cancelled')
  return rows[0]
}

export interface SettlementOptions {
  encashmentDivisor: number
  noticeDivisor: number
  encashmentMaxDays?: number
}

/**
 * What the settlement would be today. Reads live compensation and leave
 * balances — which is exactly why it is only a preview until freeze.
 */
export async function computeSettlement(
  tx: PoolClient,
  separation: Separation,
  opts: SettlementOptions,
): Promise<Settlement> {
  const { rows: comp } = await tx.query<{ components: Record<string, number>; annual_ctc_paise: string }>(
    `SELECT components, annual_ctc_paise::text FROM compensation_records
      WHERE employee_id = $1 AND superseded_at IS NULL
        AND effective_from <= $2::date AND (effective_to IS NULL OR effective_to >= $2::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [separation.employee_id, separation.last_working_day])
  if (!comp[0]) throw new ExitError('NO_COMPENSATION', 'no salary structure in force on the last working day')
  const c = comp[0].components
  const wage = Number(c.basic ?? c.BASIC ?? 0) + Number(c.da ?? c.DA ?? 0)
  const grossMonthly = Object.values(c).reduce((n, v) => n + Number(v), 0)

  const { rows: emp } = await tx.query<{ date_of_joining: string }>(
    `SELECT date_of_joining::text FROM employees WHERE id = $1`, [separation.employee_id])
  const lwd = new Date(separation.last_working_day)

  const g = gratuity({
    wagePaise: wage, dateOfJoining: new Date(emp[0]!.date_of_joining), lastWorkingDay: lwd,
    waiveMinimumService: separation.reason === 'death',
  })

  const types = await listLeaveTypes(tx, { asOf: separation.last_working_day })
  const balances: { leaveTypeCode: string; days: number }[] = []
  for (const t of types) {
    if (!t.policy?.encashable) continue
    const b = await balance(tx, separation.employee_id, t.id, lwd.getFullYear(), separation.last_working_day)
    if (b.available > 0) balances.push({ leaveTypeCode: t.code, days: b.available })
  }
  const e = leaveEncashment({ balances, wagePaise: wage, divisor: opts.encashmentDivisor, maxDays: opts.encashmentMaxDays })

  const n = noticeRecovery({
    requiredDays: separation.notice_days_required, resignedOn: new Date(separation.initiated_on),
    lastWorkingDay: lwd, grossMonthlyPaise: grossMonthly, divisor: opts.noticeDivisor,
    // Only a resignation owes notice; the company chose the date otherwise.
    waived: separation.notice_waived || separation.reason !== 'resignation',
  })

  const partial = { gratuity: g, encashment: e, notice: n, recoveriesPaise: Number(separation.recoveries_paise) }
  return { ...partial, adhoc: settlementLines(partial) }
}

/**
 * Called by freezeInputs for every row: if the employee has an open separation
 * whose last working day falls in the period, the settlement is computed for
 * real, written to the separation, and returned so the row carries the lines
 * and the proration.
 */
export async function settlementForFreeze(
  tx: PoolClient,
  args: { employeeId: string; runId: string; periodStart: string; periodEnd: string; opts: SettlementOptions },
): Promise<{ separation: Separation; settlement: Settlement } | null> {
  const { rows } = await tx.query<Separation>(
    `SELECT ${COLUMNS} FROM employee_separations
      WHERE employee_id = $1 AND status = 'initiated'
        AND last_working_day BETWEEN $2::date AND $3::date`,
    [args.employeeId, args.periodStart, args.periodEnd])
  const sep = rows[0]
  if (!sep) return null
  // Clearance gates the money: while any area is pending, the person is paid
  // a normal month and the settlement waits for the next run.
  const pending = await tx.query(`SELECT 1 FROM exit_clearances WHERE separation_id = $1 AND status = 'pending' LIMIT 1`, [sep.id])
  if (pending.rowCount) return null
  const settlement = await computeSettlement(tx, sep, args.opts)
  await tx.query(
    `UPDATE employee_separations
        SET status = 'in_payroll', settlement = $2::jsonb, settlement_run_id = $3
      WHERE id = $1`,
    [sep.id, JSON.stringify(settlement), args.runId])
  return { separation: sep, settlement }
}

/** Unfreeze puts the separation back so the next freeze recomputes it. */
export async function releaseSettlements(tx: PoolClient, runId: string): Promise<void> {
  await tx.query(
    `UPDATE employee_separations
        SET status = 'initiated', settlement = NULL, settlement_run_id = NULL
      WHERE settlement_run_id = $1 AND status = 'in_payroll'`, [runId])
}

/** Lock closes the loop: settled, and the employee has left. */
export async function finalizeSettlements(tx: PoolClient, runId: string): Promise<number> {
  const { rows } = await tx.query<{ employee_id: string; last_working_day: string }>(
    `UPDATE employee_separations
        SET status = 'settled', settled_at = now()
      WHERE settlement_run_id = $1 AND status = 'in_payroll'
      RETURNING employee_id, last_working_day::text`, [runId])
  for (const r of rows) {
    await tx.query(
      `UPDATE employees SET status = 'exited', date_of_exit = $2 WHERE id = $1`,
      [r.employee_id, r.last_working_day])
    // The person has left the payroll; they must also leave the product.
    await endAccessForEmployee(tx, r.employee_id)
  }
  return rows.length
}
