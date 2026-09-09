/**
 * Bulk employee import.
 *
 * Nobody onboards 200 people through a form. The import is deliberately
 * two-phase: a dry run reports every problem in the file at once, and only a
 * file with zero errors can be committed. A partial import is the worst
 * outcome — half a company loaded, no clear record of which half — so a commit
 * is all rows or none, inside one transaction.
 */
import type { PoolClient } from 'pg'
import { parseCsvObjects, CsvError } from './csv.ts'

export { CsvError }

export interface ImportError {
  /** 1-based row number in the file, counting the header as row 1. */
  row: number
  field: string
  message: string
}

export interface ImportRow {
  row: number
  employeeNumber: string
  firstName: string
  lastName: string | null
  dateOfJoining: string
  department: string | null
  designation: string | null
  email: string | null
}

export interface ImportReport {
  totalRows: number
  valid: ImportRow[]
  errors: ImportError[]
  /** Rows already present, matched on employee number: skipped, never overwritten. */
  duplicates: string[]
}

export const TEMPLATE_HEADERS = [
  'employee_number', 'first_name', 'last_name', 'date_of_joining',
  'department', 'designation', 'email',
] as const

/** The file a customer should start from. */
export function importTemplate(): string {
  return [
    TEMPLATE_HEADERS.join(','),
    'A-001,Rahul,Sharma,2026-02-01,Engineering,Software Engineer,rahul@example.com',
  ].join('\r\n') + '\r\n'
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const EMAIL = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/

function validDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false
  const parsed = new Date(value)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/**
 * Reads the file and says what is wrong with it.
 *
 * Every row is checked even after the first failure: a customer fixing a
 * spreadsheet wants the whole list, not one error per upload.
 */
export function validateImport(csv: string): ImportReport {
  const { headers, rows } = parseCsvObjects(csv)
  const errors: ImportError[] = []
  const valid: ImportRow[] = []

  for (const required of ['employeenumber', 'firstname', 'dateofjoining']) {
    if (!headers.includes(required)) {
      errors.push({ row: 1, field: required, message: `the column "${required}" is missing` })
    }
  }
  if (errors.length) return { totalRows: rows.length, valid: [], errors, duplicates: [] }

  const seen = new Map<string, number>()

  rows.forEach((row, i) => {
    const line = i + 2 // header is row 1
    const employeeNumber = row.employeenumber ?? ''
    const firstName = row.firstname ?? ''
    const dateOfJoining = row.dateofjoining ?? ''
    const email = row.email ?? ''
    let rowOk = true

    const fail = (field: string, message: string) => {
      errors.push({ row: line, field, message })
      rowOk = false
    }

    if (!employeeNumber) fail('employee_number', 'employee number is required')
    else if (employeeNumber.length > 40) fail('employee_number', 'employee number is too long (40 characters)')
    else if (seen.has(employeeNumber)) {
      fail('employee_number', `duplicate of row ${seen.get(employeeNumber)} in this file`)
    } else seen.set(employeeNumber, line)

    if (!firstName) fail('first_name', 'first name is required')
    else if (firstName.length > 100) fail('first_name', 'first name is too long (100 characters)')

    if (!dateOfJoining) fail('date_of_joining', 'date of joining is required')
    else if (!validDate(dateOfJoining)) {
      fail('date_of_joining', 'date of joining must be YYYY-MM-DD, for example 2026-02-01')
    }

    if (email && !EMAIL.test(email)) fail('email', 'that does not look like an email address')

    if (rowOk) {
      valid.push({
        row: line,
        employeeNumber,
        firstName,
        lastName: row.lastname || null,
        dateOfJoining,
        department: row.department || null,
        designation: row.designation || null,
        email: email || null,
      })
    }
  })

  return { totalRows: rows.length, valid, errors, duplicates: [] }
}

/** Marks rows whose employee number already exists; they are skipped on commit. */
export async function findDuplicates(
  tx: PoolClient,
  report: ImportReport,
): Promise<ImportReport> {
  if (report.valid.length === 0) return report
  const { rows } = await tx.query<{ employee_number: string }>(
    `SELECT employee_number FROM employees WHERE employee_number = ANY($1)`,
    [report.valid.map((r) => r.employeeNumber)],
  )
  return { ...report, duplicates: rows.map((r) => r.employee_number) }
}

export interface CommitResult {
  created: number
  skipped: string[]
}

/**
 * Writes the rows.
 *
 * Refuses outright if the file has any error, rather than importing the good
 * rows and leaving the customer to work out which ones landed. A department and
 * designation, where given, become the employee's first assignment record so
 * the profile is complete from day one.
 */
export async function commitImport(
  tx: PoolClient,
  args: { tenantId: string; report: ImportReport; headcountLimit: number },
): Promise<CommitResult> {
  if (args.report.errors.length) {
    throw new CsvError('the file still has errors; fix them and upload again', 1)
  }

  const skip = new Set(args.report.duplicates)
  const toCreate = args.report.valid.filter((r) => !skip.has(r.employeeNumber))

  const { rows: headcount } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM employees WHERE status <> 'exited'`)
  const existing = headcount[0]?.n ?? 0
  if (existing + toCreate.length > args.headcountLimit) {
    throw new CsvError(
      `this plan allows ${args.headcountLimit} employees; the file would take you to ` +
      `${existing + toCreate.length}`, 1)
  }

  for (const row of toCreate) {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [args.tenantId, row.employeeNumber, row.firstName, row.lastName, row.dateOfJoining],
    )
    const employeeId = rows[0]!.id

    if (row.department || row.designation) {
      await tx.query(
        `INSERT INTO employee_assignments
           (tenant_id, employee_id, department, designation, effective_from)
         VALUES ($1,$2,$3,$4,$5)`,
        [args.tenantId, employeeId, row.department ?? 'Unassigned',
         row.designation ?? 'Unassigned', row.dateOfJoining],
      )
    }
  }

  return { created: toCreate.length, skipped: [...skip] }
}
