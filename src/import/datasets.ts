/**
 * The other four imports: attendance, opening leave balances, compensation
 * and sales.
 *
 * Same two-phase shape as the employee import and for the same reason: a dry
 * run lists every problem in the file at once, and a commit is all rows or
 * none. What differs per dataset is only the columns, the row check and the
 * write — so that is all each one declares, and everything else is shared.
 *
 * Every dataset resolves the employee by EMPLOYEE NUMBER, never by id: a
 * spreadsheet a customer edits has employee numbers in it, and a uuid in a
 * CSV is a uuid somebody has pasted wrong.
 */
import type { PoolClient } from 'pg'
import { parseCsvObjects, CsvError, normaliseHeader } from './csv.ts'

export { CsvError }

export interface RowError { row: number; field: string; message: string }

export interface DatasetReport<T> {
  dataset: string
  totalRows: number
  valid: (T & { row: number; employeeId: string })[]
  errors: RowError[]
  /** Rows that would replace something already there — reported, never silent. */
  warnings: RowError[]
}

export interface Dataset<T> {
  key: string
  headers: readonly string[]
  example: string
  /** Per-row checks that need no database. Returns the typed row, or pushes errors. */
  parse(raw: Record<string, string>, row: number, push: (field: string, message: string) => void): T | null
  /** Database checks: existence, overlap, duplicates. */
  check?(tx: PoolClient, rows: (T & { row: number; employeeId: string })[], push: (row: number, field: string, message: string) => void): Promise<void>
  write(tx: PoolClient, tenantId: string, rows: (T & { row: number; employeeId: string })[], actorUserId?: string): Promise<number>
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
export const isDate = (v: string): boolean =>
  ISO_DATE.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
export const isPaise = (v: string): boolean => /^\d{1,15}$/.test(v)

/**
 * A column's value. `parseCsvObjects` normalises headers by STRIPPING spaces,
 * underscores and dashes, so `employee_number` is stored as `employeenumber`;
 * every read goes through here rather than guessing the shape.
 */
export const col = (raw: Record<string, string>, name: string): string => (raw[normaliseHeader(name)] ?? '').trim()

export function template<T>(d: Dataset<T>): string {
  return [d.headers.join(','), d.example].join('\r\n') + '\r\n'
}

/**
 * Parses and validates. Employee numbers are resolved in one query, so a file
 * of a thousand rows costs one lookup, not a thousand.
 */
export async function validateDataset<T>(tx: PoolClient, d: Dataset<T>, csv: string): Promise<DatasetReport<T>> {
  const { headers, rows } = parseCsvObjects(csv)
  const missing = d.headers.filter((h) => !headers.includes(normaliseHeader(h)))
  if (missing.length) throw new CsvError(`missing column(s): ${missing.join(', ')}`, 1)

  const errors: RowError[] = []
  const warnings: RowError[] = []
  const parsed: { row: number; employeeNumber: string; value: T }[] = []

  rows.forEach((raw, i) => {
    const row = i + 2
    const push = (field: string, message: string): void => { errors.push({ row, field, message }) }
    const employeeNumber = col(raw, 'employee_number')
    if (!employeeNumber) push('employee_number', 'required')
    const value = d.parse(raw, row, push)
    if (value !== null && employeeNumber) parsed.push({ row, employeeNumber, value })
  })

  const numbers = [...new Set(parsed.map((p) => p.employeeNumber))]
  const byNumber = new Map<string, string>()
  if (numbers.length) {
    const { rows: found } = await tx.query<{ id: string; employee_number: string }>(
      `SELECT id, employee_number FROM employees WHERE employee_number = ANY($1) AND status <> 'exited'`, [numbers])
    for (const f of found) byNumber.set(f.employee_number, f.id)
  }

  const valid: (T & { row: number; employeeId: string })[] = []
  for (const p of parsed) {
    const employeeId = byNumber.get(p.employeeNumber)
    if (!employeeId) {
      errors.push({ row: p.row, field: 'employee_number', message: `no active employee ${p.employeeNumber}` })
      continue
    }
    valid.push({ ...p.value, row: p.row, employeeId })
  }

  if (d.check && valid.length) {
    await d.check(tx, valid, (row, field, message) => warnings.push({ row, field, message }))
  }
  return { dataset: d.key, totalRows: rows.length, valid, errors, warnings }
}

export async function commitDataset<T>(
  tx: PoolClient, d: Dataset<T>, args: { tenantId: string; report: DatasetReport<T>; actorUserId?: string },
): Promise<{ written: number }> {
  if (args.report.errors.length) throw new CsvError('the file still has errors; fix them and upload again', 1)
  return { written: await d.write(tx, args.tenantId, args.report.valid, args.actorUserId) }
}

// ---------------------------------------------------------------------------
// attendance: a biometric export, one row per person per day
// ---------------------------------------------------------------------------
interface AttendanceRow { workDate: string; punchIn: string | null; punchOut: string | null }

export const attendanceDataset: Dataset<AttendanceRow> = {
  key: 'attendance',
  headers: ['employee_number', 'work_date', 'punch_in', 'punch_out'],
  example: 'A-001,2026-09-14,2026-09-14T09:32:00+05:30,2026-09-14T18:41:00+05:30',
  parse(raw, _row, push) {
    const workDate = col(raw, 'work_date')
    if (!isDate(workDate)) { push('work_date', 'a date, YYYY-MM-DD'); return null }
    const time = (field: 'punch_in' | 'punch_out'): string | null => {
      const v = col(raw, field)
      if (!v) return null
      if (!Number.isFinite(Date.parse(v))) { push(field, 'a timestamp, e.g. 2026-09-14T09:32:00+05:30'); return null }
      return new Date(v).toISOString()
    }
    const punchIn = time('punch_in'), punchOut = time('punch_out')
    if (!punchIn && !punchOut) { push('punch_in', 'give at least one of punch_in, punch_out'); return null }
    if (punchIn && punchOut && punchOut <= punchIn) { push('punch_out', 'is at or before punch_in'); return null }
    return { workDate, punchIn, punchOut }
  },
  async check(tx, rows, push) {
    // A day inside a closed attendance period would be rewritten; say so.
    const { rows: closed } = await tx.query<{ period_start: string; period_end: string }>(
      `SELECT period_start::text, period_end::text FROM attendance_periods WHERE status <> 'open'`)
    for (const r of rows) {
      if (closed.some((c) => r.workDate >= c.period_start && r.workDate <= c.period_end)) {
        push(r.row, 'work_date', 'falls in a closed attendance period and will be skipped')
      }
    }
  },
  async write(tx, tenantId, rows) {
    const { rows: closed } = await tx.query<{ period_start: string; period_end: string }>(
      `SELECT period_start::text, period_end::text FROM attendance_periods WHERE status <> 'open'`)
    const { recomputeDay } = await import('../attendance/index.ts')
    let n = 0
    const touched = new Set<string>()
    for (const r of rows) {
      if (closed.some((c) => r.workDate >= c.period_start && r.workDate <= c.period_end)) continue
      for (const [direction, at] of [['in', r.punchIn], ['out', r.punchOut]] as const) {
        if (!at) continue
        await tx.query(
          `INSERT INTO attendance_punches (tenant_id, employee_id, punched_at, local_date, direction, source, client_punch_id)
           VALUES ($1,$2,$3,$4,$5,'biometric_import',$6)
           ON CONFLICT (tenant_id, employee_id, client_punch_id) WHERE client_punch_id IS NOT NULL DO NOTHING`,
          [tenantId, r.employeeId, at, r.workDate, direction, `import:${r.workDate}:${direction}`])
      }
      touched.add(`${r.employeeId}|${r.workDate}`)
      n++
    }
    for (const key of touched) {
      const [employeeId, workDate] = key.split('|') as [string, string]
      await recomputeDay(tx, employeeId, workDate)
    }
    return n
  },
}

// ---------------------------------------------------------------------------
// opening leave balances: what people carried in on day one
// ---------------------------------------------------------------------------
interface LeaveOpeningRow { leaveTypeCode: string; days: number; cycleYear: number; asOf: string }

export const leaveOpeningDataset: Dataset<LeaveOpeningRow> = {
  key: 'leave_openings',
  headers: ['employee_number', 'leave_type_code', 'days', 'cycle_year', 'as_of'],
  example: 'A-001,EL,12.5,2026,2026-04-01',
  parse(raw, _row, push) {
    const leaveTypeCode = col(raw, 'leave_type_code').toUpperCase()
    if (!leaveTypeCode) { push('leave_type_code', 'required'); return null }
    const days = Number(col(raw, 'days'))
    if (!Number.isFinite(days) || days < 0 || days > 400 || Math.round(days * 100) !== days * 100) {
      push('days', 'a number of days, 0–400, at most two decimals'); return null
    }
    const cycleYear = Number(col(raw, 'cycle_year'))
    if (!Number.isInteger(cycleYear) || cycleYear < 2000 || cycleYear > 2100) { push('cycle_year', 'a year'); return null }
    const asOf = col(raw, 'as_of')
    if (!isDate(asOf)) { push('as_of', 'a date, YYYY-MM-DD'); return null }
    return { leaveTypeCode, days, cycleYear, asOf }
  },
  async check(tx, rows, push) {
    const codes = [...new Set(rows.map((r) => r.leaveTypeCode))]
    const { rows: types } = await tx.query<{ code: string }>(
      `SELECT code FROM leave_types WHERE code = ANY($1) AND status = 'active'`, [codes])
    const known = new Set(types.map((t) => t.code))
    for (const r of rows) {
      if (!known.has(r.leaveTypeCode)) push(r.row, 'leave_type_code', `no active leave type ${r.leaveTypeCode} — the row will fail`)
    }
    const { rows: existing } = await tx.query<{ employee_id: string; code: string; cycle_year: number }>(
      `SELECT l.employee_id, t.code, l.cycle_year FROM leave_ledger l JOIN leave_types t ON (t.tenant_id, t.id) = (l.tenant_id, l.leave_type_id)
        WHERE l.entry_type = 'opening' AND l.employee_id = ANY($1)`, [[...new Set(rows.map((r) => r.employeeId))]])
    for (const r of rows) {
      if (existing.some((e) => e.employee_id === r.employeeId && e.code === r.leaveTypeCode && e.cycle_year === r.cycleYear)) {
        push(r.row, 'days', 'an opening balance already exists for this type and cycle; the row will be skipped')
      }
    }
  },
  async write(tx, _tenantId, rows, actorUserId) {
    const { appendEntry } = await import('../leave/ledger.ts')
    const { rows: types } = await tx.query<{ id: string; code: string }>(`SELECT id, code FROM leave_types WHERE status = 'active'`)
    const byCode = new Map(types.map((t) => [t.code, t.id]))
    let n = 0
    for (const r of rows) {
      const leaveTypeId = byCode.get(r.leaveTypeCode)
      if (!leaveTypeId) throw new CsvError(`no active leave type ${r.leaveTypeCode}`, r.row)
      const written = await appendEntry(tx, {
        employeeId: r.employeeId, leaveTypeId, entryType: 'opening', deltaDays: r.days,
        effectiveDate: r.asOf, cycleYear: r.cycleYear, note: 'imported opening balance',
        idempotencyKey: `import:opening:${r.employeeId}:${leaveTypeId}:${r.cycleYear}`, actorUserId,
      })
      if (written) n++
    }
    return n
  },
}

// ---------------------------------------------------------------------------
// compensation: a revision per employee, effective-dated
// ---------------------------------------------------------------------------
interface CompensationRow { annualCtcPaise: number; effectiveFrom: string; structureCode: string | null; components: Record<string, number>; reason: string }

export const compensationDataset: Dataset<CompensationRow> = {
  key: 'compensation',
  headers: ['employee_number', 'annual_ctc_paise', 'effective_from', 'structure_code', 'components', 'reason'],
  example: 'A-001,60000000,2027-04-01,STD,,annual revision',
  parse(raw, _row, push) {
    const annual = col(raw, 'annual_ctc_paise')
    if (!isPaise(annual) || Number(annual) <= 0) { push('annual_ctc_paise', 'a positive whole number of paise'); return null }
    const effectiveFrom = col(raw, 'effective_from')
    if (!isDate(effectiveFrom)) { push('effective_from', 'a date, YYYY-MM-DD'); return null }
    const structureCode = col(raw, 'structure_code').toUpperCase() || null
    const components: Record<string, number> = {}
    const rawComponents = col(raw, 'components')
    if (rawComponents) {
      // "BASIC=2500000;HRA=1000000" — a CSV cell cannot hold JSON comfortably.
      for (const part of rawComponents.split(';')) {
        const [code = '', value = ''] = part.split('=').map((x) => x.trim())
        if (!code || !isPaise(value)) { push('components', `"${part}" is not CODE=paise`); return null }
        components[code.toUpperCase()] = Number(value)
      }
    }
    if (!structureCode && !rawComponents) { push('structure_code', 'give a structure_code or components'); return null }
    if (structureCode && rawComponents) { push('components', 'give a structure_code OR components, not both'); return null }
    const reason = col(raw, 'reason')
    if (!reason) { push('reason', 'required — a salary change needs a reason on the record'); return null }
    return { annualCtcPaise: Number(annual), effectiveFrom, structureCode, components, reason }
  },
  async check(tx, rows, push) {
    const codes = [...new Set(rows.map((r) => r.structureCode).filter((c): c is string => !!c))]
    if (codes.length) {
      const { rows: known } = await tx.query<{ code: string }>(`SELECT code FROM salary_structures WHERE code = ANY($1) AND status = 'active'`, [codes])
      const set = new Set(known.map((k) => k.code))
      for (const r of rows) if (r.structureCode && !set.has(r.structureCode)) push(r.row, 'structure_code', `no active structure ${r.structureCode} — the row will fail`)
    }
    for (const r of rows) {
      const { rows: cur } = await tx.query<{ effective_from: string }>(
        `SELECT effective_from::text FROM compensation_records WHERE employee_id = $1 AND superseded_at IS NULL ORDER BY effective_from DESC LIMIT 1`, [r.employeeId])
      if (cur[0] && cur[0].effective_from >= r.effectiveFrom) {
        push(r.row, 'effective_from', `compensation already starts on ${cur[0].effective_from}; this row will fail`)
      }
    }
  },
  async write(tx, _tenantId, rows, actorUserId) {
    const { changeCompensation } = await import('../people/history.ts')
    const { normaliseComponents, resolveForEmployee, structureByCode } = await import('../payroll/structures.ts')
    const { loadStatutory } = await import('./../payroll/statutory.ts')
    let n = 0
    for (const r of rows) {
      let components = r.components
      let structureCode: string | undefined
      if (r.structureCode) {
        const structure = await structureByCode(tx, r.structureCode)
        const statutory = await loadStatutory(tx, r.effectiveFrom)
        components = await resolveForEmployee(tx, structure, r.annualCtcPaise, statutory.config, false)
        structureCode = structure.code
      } else {
        components = await normaliseComponents(tx, components)
      }
      await changeCompensation(tx, {
        employeeId: r.employeeId, annualCtcPaise: r.annualCtcPaise, components, structureCode,
        effectiveFrom: r.effectiveFrom, reason: r.reason, actorUserId,
      })
      n++
    }
    return n
  },
}

// ---------------------------------------------------------------------------
// sales: achievement for an incentive period
// ---------------------------------------------------------------------------
interface SalesRow { occurredOn: string; valuePaise: number; quantity: number | null; externalRef: string | null }

export const salesDataset: Dataset<SalesRow> = {
  key: 'sales',
  headers: ['employee_number', 'occurred_on', 'value_paise', 'quantity', 'external_ref'],
  example: 'A-001,2026-11-05,25000000,2,INV-1041',
  parse(raw, _row, push) {
    const occurredOn = col(raw, 'occurred_on')
    if (!isDate(occurredOn)) { push('occurred_on', 'a date, YYYY-MM-DD'); return null }
    const value = col(raw, 'value_paise')
    if (!/^-?\d{1,15}$/.test(value)) { push('value_paise', 'a whole number of paise'); return null }
    const q = col(raw, 'quantity')
    if (q && !Number.isFinite(Number(q))) { push('quantity', 'a number'); return null }
    return { occurredOn, valuePaise: Number(value), quantity: q ? Number(q) : null, externalRef: col(raw, 'external_ref') || null }
  },
  write: async () => { throw new CsvError('sales are imported against a period; use the period import route', 1) },
}

/** Sales need the period, so they get their own writer rather than a Dataset.write. */
export async function writeSales(
  tx: PoolClient, periodId: string, report: DatasetReport<SalesRow>,
): Promise<{ recorded: number; duplicates: number }> {
  if (report.errors.length) throw new CsvError('the file still has errors; fix them and upload again', 1)
  const { recordSales } = await import('../work/incentive-admin.ts')
  return recordSales(tx, periodId, report.valid.map((r) => ({
    employeeId: r.employeeId, occurredOn: r.occurredOn, valuePaise: r.valuePaise,
    quantity: r.quantity ?? undefined, externalRef: r.externalRef ?? undefined,
  })), 'import')
}

export const DATASETS = {
  attendance: attendanceDataset,
  leave_openings: leaveOpeningDataset,
  compensation: compensationDataset,
  sales: salesDataset,
} as const

export type DatasetKey = keyof typeof DATASETS
