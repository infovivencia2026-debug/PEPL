/**
 * Payments — the bank file that actually moves salary.
 *
 * PEPL never holds customer money: this produces a file the company uploads to
 * their own bank. Two properties matter more than anything else here, and both
 * live in the module rather than in this route:
 *
 *   - only a LOCKED run produces a file, so what is paid matches what was
 *     approved;
 *   - calling twice returns the identical batch, byte for byte, so a retried
 *     download cannot become a second payment.
 */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, requireBody, requireModule, asUuid, asDate, emit,
} from './deps.ts'
import { generateBankFile, type BankFormat } from '../../payments/bank-file.ts'

const FORMATS: readonly BankFormat[] = [
  'hdfc_neft_csv', 'icici_csv', 'axis_csv', 'generic_neft_csv',
]

export function register(router: Router): void {
  router.get('/api/v1/payments/formats',
    { summary: 'Bank file formats this deployment can write', tag: 'payments',
      permission: 'bank.read' },
    authed('bank.read', () => ok({ formats: FORMATS })))

  router.post('/api/v1/payroll/runs/:id/bank-file',
    { summary: 'Generate (or re-fetch) the bank file for a locked run', tag: 'payments',
      permission: 'bank.export',
      requestExample: { format: 'hdfc_neft_csv', valueDate: '2026-10-01' } },
    authed('bank.export', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const b = requireBody<{ format: string; valueDate: string; bankAccountId?: string }>(
        ctx.req, ['format', 'valueDate'])

      if (!FORMATS.includes(b.format as BankFormat)) {
        throw new HttpError(422, 'VALIDATION_FAILED',
          `format must be one of: ${FORMATS.join(', ')}`, { formats: FORMATS })
      }

      const result = await generateBankFile(ctx.tx, {
        runId: asUuid(ctx.req.params.id, 'id'),
        format: b.format as BankFormat,
        valueDate: asDate(b.valueDate, 'valueDate'),
        generatedByUserId: ctx.session.userId,
        bankAccountId: b.bankAccountId ? asUuid(b.bankAccountId, 'bankAccountId') : undefined,
      })

      // Generating is the critical event, not downloading: this is the moment a
      // payable file for every employee comes into existence. A re-fetch is
      // logged separately so the trail distinguishes them.
      await emit(ctx.tx, {
        action: result.reused ? 'payroll.bankfile.downloaded' : 'payroll.bankfile.generated',
        entityType: 'payment_batch', entityId: result.batchId,
        actorUserId: ctx.session.userId,
        metadata: {
          runId: ctx.req.params.id, format: b.format,
          instructions: result.lineCount, checksum: result.checksum,
        },
      })

      return ok(result)
    }))

  router.get('/api/v1/payments/batches',
    { summary: 'Bank batches generated for this company', tag: 'payments',
      permission: 'bank.read' },
    authed('bank.read', async (ctx) => {
      const { rows } = await ctx.tx.query(
        `SELECT id, source_type, source_id, channel, format, value_date::text,
                instruction_count, total_paise::text, file_checksum_sha256,
                status, created_at
           FROM payment_batches
          ORDER BY created_at DESC
          LIMIT 100`)
      return ok({ batches: rows })
    }))

  router.get('/api/v1/payments/batches/:id',
    { summary: 'One batch, with its file content', tag: 'payments',
      permission: 'bank.export' },
    authed('bank.export', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const { rows } = await ctx.tx.query<{ file_content: string | null }>(
        `SELECT id, source_id, channel, format, value_date::text, instruction_count,
                total_paise::text, file_checksum_sha256, file_content, status, created_at
           FROM payment_batches WHERE id = $1`, [id])
      const batch = rows[0]
      if (!batch) throw new HttpError(404, 'NOT_FOUND', 'no such batch')

      await emit(ctx.tx, {
        action: 'payroll.bankfile.downloaded', entityType: 'payment_batch', entityId: id,
        actorUserId: ctx.session.userId,
      })
      return ok(batch)
    }))
}
