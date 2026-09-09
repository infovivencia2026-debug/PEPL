import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { parseCsv, parseCsvObjects, CsvError } from '../src/import/csv.ts'
import {
  commitImport, findDuplicates, importTemplate, validateImport,
} from '../src/import/employees.ts'

let A: Tenant
let B: Tenant

beforeAll(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
beforeEach(async () => {
  const s = await resetAndSeed()
  A = s.a
  B = s.b
})
afterAll(async () => {
  await closePools()
  await controlPool.end()
})

const header = 'employee_number,first_name,last_name,date_of_joining,department,designation,email'
const file = (...rows: string[]) => [header, ...rows].join('\r\n')

describe('the CSV reader copes with what spreadsheets actually export', () => {
  it('reads quoted commas, escaped quotes and CRLF', () => {
    const rows = parseCsv('a,b\r\n"Sharma, Rahul","he said ""hi"""\r\n')
    expect(rows).toEqual([['a', 'b'], ['Sharma, Rahul', 'he said "hi"']])
  })

  it('strips a byte order mark', () => {
    expect(parseCsvObjects('﻿Employee Number\r\nA-001').headers).toEqual(['employeenumber'])
  })

  it('matches headers regardless of case, spaces and underscores', () => {
    const { rows } = parseCsvObjects('Employee_Number, First Name\r\nA-001,Rahul')
    expect(rows[0]).toEqual({ employeenumber: 'A-001', firstname: 'Rahul' })
  })

  it('reads a quoted newline inside a field', () => {
    expect(parseCsv('a\r\n"line1\nline2"')).toEqual([['a'], ['line1\nline2']])
  })

  it('refuses a file that ends mid-quote', () => {
    expect(() => parseCsv('a\r\n"unterminated')).toThrow(CsvError)
  })

  it('refuses a duplicated column', () => {
    expect(() => parseCsvObjects('name,name\r\nx,y')).toThrow(/appears twice/)
  })
})

describe('the dry run reports every problem at once', () => {
  it('accepts a good file', () => {
    const report = validateImport(file(
      'A-001,Rahul,Sharma,2026-02-01,Engineering,Engineer,rahul@example.com',
      'A-002,Priya,Nair,2026-03-15,People,HR Manager,priya@example.com',
    ))
    expect(report.errors).toEqual([])
    expect(report.valid).toHaveLength(2)
    expect(report.valid[0]!.department).toBe('Engineering')
  })

  it('names the row, the column and the fix', () => {
    const report = validateImport(file(
      ',Rahul,Sharma,2026-02-01,,,',
      'A-002,,Nair,15/03/2026,,,not-an-email',
    ))
    expect(report.valid).toHaveLength(0)
    expect(report.errors).toEqual([
      { row: 2, field: 'employee_number', message: 'employee number is required' },
      { row: 3, field: 'first_name', message: 'first name is required' },
      {
        row: 3, field: 'date_of_joining',
        message: 'date of joining must be YYYY-MM-DD, for example 2026-02-01',
      },
      { row: 3, field: 'email', message: 'that does not look like an email address' },
    ])
  })

  it('catches a date that is well formed but not real', () => {
    const report = validateImport(file('A-001,Rahul,,2026-02-31,,,'))
    expect(report.errors[0]!.field).toBe('date_of_joining')
  })

  it('catches a duplicate inside the file itself', () => {
    const report = validateImport(file(
      'A-001,Rahul,,2026-02-01,,,',
      'A-001,Priya,,2026-02-02,,,',
    ))
    expect(report.errors[0]!.message).toMatch(/duplicate of row 2/)
  })

  it('stops at the header when a required column is missing', () => {
    const report = validateImport('first_name\r\nRahul')
    expect(report.errors.map((e) => e.field)).toEqual(['employeenumber', 'dateofjoining'])
    expect(report.valid).toHaveLength(0)
  })

  it('validates its own template', () => {
    expect(validateImport(importTemplate()).errors).toEqual([])
  })
})

describe('committing', () => {
  it('creates the people and their first assignment', async () => {
    const report = validateImport(file(
      'IMP-1,Anita,Rao,2026-02-01,Finance,Analyst,anita@example.com',
      'IMP-2,Vikram,Iyer,2026-02-02,Finance,Manager,vikram@example.com',
    ))
    const result = await withTenant(A.id, async (tx) =>
      commitImport(tx, {
        tenantId: A.id,
        report: await findDuplicates(tx, report),
        headcountLimit: 100,
      }))
    expect(result.created).toBe(2)

    const rows = await withTenant(A.id, async (tx) => {
      const r = await tx.query(
        `SELECT e.employee_number, a.department
           FROM employees e
           LEFT JOIN employee_assignments a
             ON (a.tenant_id, a.employee_id) = (e.tenant_id, e.id)
          WHERE e.employee_number LIKE 'IMP-%'
          ORDER BY e.employee_number`)
      return r.rows as { employee_number: string; department: string }[]
    })
    expect(rows.map((r) => r.department)).toEqual(['Finance', 'Finance'])
  })

  it('skips somebody already on file rather than duplicating them', async () => {
    const first = validateImport(file('IMP-9,Anita,,2026-02-01,,,'))
    await withTenant(A.id, async (tx) =>
      commitImport(tx, { tenantId: A.id, report: await findDuplicates(tx, first), headcountLimit: 100 }))

    const again = await withTenant(A.id, (tx) => findDuplicates(tx, validateImport(
      file('IMP-9,Anita,,2026-02-01,,,', 'IMP-10,Ravi,,2026-02-02,,,'))))
    expect(again.duplicates).toEqual(['IMP-9'])

    const result = await withTenant(A.id, (tx) =>
      commitImport(tx, { tenantId: A.id, report: again, headcountLimit: 100 }))
    expect(result.created).toBe(1)
    expect(result.skipped).toEqual(['IMP-9'])
  })

  it('refuses a file with any error, rather than importing the good half', async () => {
    const report = validateImport(file('IMP-20,Good,,2026-02-01,,,', ',Bad,,2026-02-02,,,'))
    await expect(
      withTenant(A.id, (tx) =>
        commitImport(tx, { tenantId: A.id, report, headcountLimit: 100 })),
    ).rejects.toBeInstanceOf(CsvError)

    const count = await withTenant(A.id, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM employees WHERE employee_number LIKE 'IMP-%'`)
      return Number(r.rows[0]!.n)
    })
    expect(count).toBe(0)
  })

  it('refuses to take the company past its plan limit', async () => {
    const report = validateImport(file(
      'IMP-30,A,,2026-02-01,,,', 'IMP-31,B,,2026-02-01,,,', 'IMP-32,C,,2026-02-01,,,'))
    await expect(
      withTenant(A.id, async (tx) =>
        commitImport(tx, {
          tenantId: A.id, report: await findDuplicates(tx, report), headcountLimit: 2,
        })),
    ).rejects.toThrow(/plan allows 2 employees/)
  })

  it('imports into the caller company only', async () => {
    const report = validateImport(file('IMP-40,Solo,,2026-02-01,,,'))
    await withTenant(A.id, async (tx) =>
      commitImport(tx, { tenantId: A.id, report: await findDuplicates(tx, report), headcountLimit: 100 }))

    const inB = await withTenant(B.id, async (tx) => {
      const r = await tx.query<{ n: string }>(
        `SELECT count(*) AS n FROM employees WHERE employee_number = 'IMP-40'`)
      return Number(r.rows[0]!.n)
    })
    expect(inB).toBe(0)
  })
})
