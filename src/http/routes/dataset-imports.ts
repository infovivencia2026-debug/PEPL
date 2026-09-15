/**
 * Imports beyond employees: attendance, opening leave balances, compensation,
 * sales. One shape for all four — template, validate, commit — and the
 * permission the data itself needs, not just `import.run`: loading a year of
 * salary revisions is a compensation write however it arrives.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, asUuid, emit, can } from './deps.ts'
import {
  CsvError, DATASETS, commitDataset, template, validateDataset, writeSales, type DatasetKey,
} from '../../import/datasets.ts'
import type { Ctx } from '../context.ts'

/** The extra permission each dataset demands beyond import.run. */
const EXTRA: Record<DatasetKey, string | null> = {
  attendance: 'attendance.correct',
  leave_openings: 'leave.balance.adjust',
  compensation: 'compensation.write',
  sales: 'incentive.write',
}

function dataset(ctx: Ctx): DatasetKey {
  const key = ctx.req.params.dataset as DatasetKey
  if (!(key in DATASETS)) {
    throw new HttpError(404, 'NOT_FOUND', `no import called "${key}"; try ${Object.keys(DATASETS).join(', ')}`)
  }
  const extra = EXTRA[key]
  if (extra && !can(ctx.auth, extra as never)) {
    throw new HttpError(403, 'PERMISSION_DENIED', `importing ${key} also needs ${extra}`)
  }
  if (ctx.auth.scope !== 'all') throw new HttpError(403, 'PERMISSION_DENIED', 'an import is company-wide')
  return key
}

function csvFromBody(b: { csv?: string; csvBase64?: string }): string {
  const csv = b.csvBase64 ? Buffer.from(b.csvBase64, 'base64').toString('utf8') : b.csv
  if (typeof csv !== 'string' || !csv.trim()) throw new HttpError(422, 'VALIDATION_FAILED', 'csv or csvBase64 is required')
  if (csv.length > 8 * 1024 * 1024) throw new HttpError(413, 'FILE_TOO_LARGE', 'split a file larger than 8 MB')
  return csv
}

const asCsvError = (e: unknown): never => {
  if (e instanceof CsvError) throw new HttpError(422, 'IMPORT_INVALID', e.message, { line: e.line })
  throw e
}

export function register(router: Router): void {
  router.get('/api/v1/imports/:dataset/template',
    { summary: 'The CSV template for attendance | leave_openings | compensation | sales', tag: 'imports', permission: 'import.run' },
    authed('import.run', async (ctx) => {
      const key = dataset(ctx)
      return ok({ fileName: `pepl-${key}-import.csv`, contentType: 'text/csv', content: template(DATASETS[key] as never) })
    }))

  router.post('/api/v1/imports/:dataset/validate',
    { summary: 'Dry run: every problem in the file, plus warnings for rows that would be skipped',
      tag: 'imports', permission: 'import.run',
      requestExample: { csv: 'employee_number,work_date,punch_in,punch_out\nA-001,2026-09-14,2026-09-14T09:32:00+05:30,' } },
    authed('import.run', async (ctx) => {
      const key = dataset(ctx)
      const b = requireBody<{ csv?: string; csvBase64?: string }>(ctx.req, [])
      try {
        const report = await validateDataset(ctx.tx, DATASETS[key] as never, csvFromBody(b))
        return ok({ ...report, valid: report.valid.length, willWrite: report.valid.length, rows: report.valid.slice(0, 50) })
      } catch (e) { return asCsvError(e) }
    }))

  router.post('/api/v1/imports/:dataset',
    { summary: 'Commit an import: all rows or none. Sales need ?periodId=', tag: 'imports', permission: 'import.run' },
    authed('import.run', async (ctx) => {
      const key = dataset(ctx)
      const b = requireBody<{ csv?: string; csvBase64?: string }>(ctx.req, [])
      try {
        const report = await validateDataset(ctx.tx, DATASETS[key] as never, csvFromBody(b))
        if (report.errors.length) {
          throw new HttpError(422, 'IMPORT_HAS_ERRORS', `${report.errors.length} row(s) still have errors`, { errors: report.errors.slice(0, 50) })
        }
        const result = key === 'sales'
          ? await writeSales(ctx.tx, asUuid(ctx.req.query.get('periodId'), 'periodId'), report as never)
          : await commitDataset(ctx.tx, DATASETS[key] as never, { tenantId: ctx.auth.tenantId, report: report as never, actorUserId: ctx.auth.userId })
        await emit(ctx.tx, {
          action: 'data.import.committed', entityType: 'import', actorUserId: ctx.auth.userId,
          metadata: { dataset: key, totalRows: report.totalRows, ...result },
        })
        return ok({ dataset: key, ...result, warnings: report.warnings })
      } catch (e) { return asCsvError(e) }
    }))
}
