/**
 * A CSV reader.
 *
 * RFC 4180 with the two deviations every real spreadsheet export has: a BOM at
 * the front, and CRLF line endings. Written here rather than taken as a
 * dependency because it is forty lines and the alternative is auditing a parser
 * that will read customer payroll data.
 */

export class CsvError extends Error {
  readonly code = 'IMPORT_INVALID'
  readonly line: number
  constructor(message: string, line: number) {
    super(message)
    this.line = line
    this.name = 'CsvError'
  }
}

/** Splits into rows of raw cells. Quoted cells may contain commas and newlines. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let line = 1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else { quoted = false }
      } else {
        if (ch === '\n') line++
        cell += ch
      }
      continue
    }

    if (ch === '"') {
      if (cell.trim() !== '') {
        throw new CsvError('a quote may only open a field, not appear inside one', line)
      }
      quoted = true
    } else if (ch === ',') {
      row.push(cell); cell = ''
    } else if (ch === '\r') {
      // handled by the \n that follows; a lone \r is treated as a line break too
      if (text[i + 1] !== '\n') { row.push(cell); rows.push(row); row = []; cell = ''; line++ }
    } else if (ch === '\n') {
      row.push(cell); rows.push(row); row = []; cell = ''; line++
    } else {
      cell += ch
    }
  }

  if (quoted) throw new CsvError('the file ends inside a quoted field', line)
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }

  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * Rows keyed by header.
 *
 * Headers are matched loosely — case, spaces and underscores ignored — because
 * "Employee Number", "employee_number" and "employeenumber" are the same column
 * to everyone except a strict parser.
 */
export function parseCsvObjects(input: string): { headers: string[]; rows: Record<string, string>[] } {
  const raw = parseCsv(input)
  const headerRow = raw[0]
  if (!headerRow) throw new CsvError('the file is empty', 1)

  const headers = headerRow.map((h) => normaliseHeader(h))
  const duplicate = headers.find((h, i) => headers.indexOf(h) !== i)
  if (duplicate) throw new CsvError(`the column "${duplicate}" appears twice`, 1)

  const rows = raw.slice(1).map((cells) => {
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = (cells[i] ?? '').trim() })
    return row
  })
  return { headers, rows }
}

export function normaliseHeader(header: string): string {
  return header.trim().toLowerCase().replace(/[\s_-]+/g, '')
}
