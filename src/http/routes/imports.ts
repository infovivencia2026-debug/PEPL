/** Bulk import — template, dry run, commit. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, emit } from './deps.ts'
import {
  commitImport, findDuplicates, importTemplate, validateImport, CsvError,
} from '../../import/employees.ts'

/** 5 MB of CSV is roughly 50,000 employees — far past any single upload. */
const MAX_CSV_BYTES = 5 * 1024 * 1024

function csvFromBody(body: { csv?: string; csvBase64?: string }): string {
  const csv = body.csvBase64
    ? Buffer.from(body.csvBase64, 'base64').toString('utf8')
    : body.csv
  if (!csv) throw new HttpError(422, 'VALIDATION_FAILED', 'csv or csvBase64 is required')
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) {
    throw new HttpError(413, 'FILE_TOO_LARGE', 'the file is larger than 5 MB')
  }
  return csv
}

export function register(router: Router): void {
  router.get('/api/v1/imports/employees/template',
    { summary: 'The CSV template, with its one example row', tag: 'imports',
      permission: 'import.run' },
    authed('import.run', () => ok({
      fileName: 'pepl-employee-import.csv',
      contentType: 'text/csv',
      content: importTemplate(),
    })))

  router.post('/api/v1/imports/employees/validate',
    { summary: 'Dry run: every problem in the file, nothing written', tag: 'imports',
      permission: 'import.run',
      requestExample: { csv: 'employee_number,first_name,date_of_joining\nA-001,Rahul,2026-02-01' } },
    authed('import.run', async (ctx) => {
      const b = requireBody<{ csv?: string; csvBase64?: string }>(ctx.req, [])
      try {
        const report = await findDuplicates(ctx.tx, validateImport(csvFromBody(b)))
        return ok({
          ...report,
          // The client needs one number to decide whether the button is enabled.
          willCreate: report.valid.length - report.duplicates.length,
        })
      } catch (e) {
        if (e instanceof CsvError) {
          throw new HttpError(422, 'IMPORT_INVALID', e.message, { line: e.line })
        }
        throw e
      }
    }))

  router.post('/api/v1/imports/employees',
    { summary: 'Commit an import: all rows or none', tag: 'imports', permission: 'import.run',
      requestExample: { csv: 'employee_number,first_name,date_of_joining\nA-001,Rahul,2026-02-01' } },
    authed('import.run', async (ctx) => {
      const b = requireBody<{ csv?: string; csvBase64?: string }>(ctx.req, [])
      try {
        const report = await findDuplicates(ctx.tx, validateImport(csvFromBody(b)))
        if (report.errors.length) {
          throw new HttpError(422, 'IMPORT_INVALID',
            `${report.errors.length} row(s) need fixing before this file can be imported`,
            { errors: report.errors.slice(0, 100) })
        }
        const result = await commitImport(ctx.tx, {
          tenantId: ctx.auth.tenantId,
          report,
          headcountLimit: ctx.config.limit('employees'),
        })
        await emit(ctx.tx, {
          action: 'data.import.committed', entityType: 'employee_import',
          actorUserId: ctx.session.userId,
          metadata: { created: result.created, skipped: result.skipped.length },
        })
        return ok(result)
      } catch (e) {
        if (e instanceof CsvError) {
          throw new HttpError(422, 'IMPORT_INVALID', e.message, { line: e.line })
        }
        throw e
      }
    }))
}
