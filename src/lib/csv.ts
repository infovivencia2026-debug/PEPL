/**
 * The one way to write a CSV cell.
 *
 * Spreadsheet applications execute a cell that BEGINS with = + - @ (or a tab or a carriage
 * return) as a formula, so text a user controls -- a name, a department, a narration -- can
 * turn an export into a way to exfiltrate the cells beside it. The defence is to make the
 * cell text: prefix an apostrophe. (OWASP "CSV injection".)
 *
 * Numbers are exempt, and so is a string that IS a plain number: a reversal or a recovery is
 * legitimately negative, and prefixing `-1867` would turn a figure into text and break every
 * sum over the column. A formula needs letters or parentheses; `-1867.50` has neither.
 *
 * Quoting for commas, quotes and line breaks happens AFTER the guard, so a hostile cell that
 * also contains a comma is neutralised and quoted.
 */
const TRIGGER = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/

export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v)
  if (typeof v !== 'number' && typeof v !== 'bigint' && TRIGGER.test(s) && !PLAIN_NUMBER.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s
}
