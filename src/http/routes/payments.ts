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
  HttpError, authed, ok, requireBody, requireModule, asUuid, asDate, emit, requireRecentMfa,
} from './deps.ts'
import { generateBankFile, type BankFormat } from '../../payments/bank-file.ts'
import { listMappings, upsertMapping, buildJournal, journalCsv, journalTallyXml, reconcileBatch, paymentStatus, type ReconLine } from '../../payroll/journal.ts'

const FORMATS: readonly BankFormat[] = [
  'hdfc_neft_csv', 'icici_csv', 'axis_csv', 'generic_neft_csv',
]

export function register(router: Router): void {
  router.get('/api/v1/payroll/ledger-mappings', { summary: 'Which accounting head each payroll component posts to (defaults seeded)', tag: 'payments', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => ok({ mappings: await listMappings(ctx.tx) })))
  router.post('/api/v1/payroll/ledger-mappings', { summary: 'Set a component\'s debit/credit heads (Tally ledger names or ERP codes); *:earning etc. are the defaults by type', tag: 'payments', permission: 'payroll.process',
    requestExample: { componentCode: 'HRA', debitAccount: 'House Rent Allowance', creditAccount: 'Salary Payable', costCentreBy: 'department' } },
    authed('payroll.process', async (ctx) => ok(await upsertMapping(ctx.tx, requireBody<{ componentCode: string; componentType?: string; debitAccount: string; creditAccount: string; costCentreBy?: string }>(ctx.req, ['componentCode', 'debitAccount', 'creditAccount'])))))

  router.get('/api/v1/payroll/runs/:id/journal', { summary: 'Accounting journal for a locked run (?format=json|csv|tally) — balanced, by cost centre', tag: 'payments', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const j = await buildJournal(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      const fmt = ctx.req.query.get('format') ?? 'json'
      if (fmt === 'csv') return ok({ fileName: `journal-${j.period}.csv`, contentType: 'text/csv; charset=utf-8', rows: j.lines.length, contentBase64: Buffer.from(journalCsv(j)).toString('base64'), balanced: j.balanced, unmapped: j.unmapped })
      if (fmt === 'tally') {
        const company = (await ctx.tx.query<{ n: string }>(`SELECT legal_name AS n FROM tenants`)).rows[0]!.n
        return ok({ fileName: `journal-${j.period}.xml`, contentType: 'application/xml', rows: j.lines.length, contentBase64: Buffer.from(journalTallyXml(j, company)).toString('base64') })
      }
      return ok({ ...j, lines: j.lines.map((l) => ({ ...l, debitPaise: l.debitPaise.toString(), creditPaise: l.creditPaise.toString() })), totalDebitPaise: j.totalDebitPaise.toString(), totalCreditPaise: j.totalCreditPaise.toString() })
    }))

  router.post('/api/v1/payments/batches/:id/reconcile', { summary: 'Apply the bank\'s return file: lines matched by reference (else account + amount) become settled (with UTR) or failed', tag: 'payments', permission: 'bank.export',
    requestExample: { lines: [{ reference: 'PEPL-…', status: 'settled', utr: 'HDFCN52026…' }, { reference: 'PEPL-…', status: 'failed', reason: 'Account closed' }] } },
    authed('bank.export', async (ctx) => {
      const b = requireBody<{ lines: ReconLine[] }>(ctx.req, ['lines'])
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 5000) throw new HttpError(422, 'VALIDATION_FAILED', '1–5000 lines')
      const r = await reconcileBatch(ctx.tx, { batchId: asUuid(ctx.req.params.id, 'id'), lines: b.lines })
      await emit(ctx.tx, { action: 'payments.reconciled', entityType: 'payment_batch', entityId: ctx.req.params.id, actorUserId: ctx.auth.userId, metadata: { matched: r.matched, settled: r.settled, failed: r.failed, unmatched: r.unmatched.length } })
      return ok(r)
    }))

  router.get('/api/v1/payroll/runs/:id/payment-status', { summary: 'Settled / failed / pending instructions for a run, with failures to re-pay', tag: 'payments', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => ok(await paymentStatus(ctx.tx, asUuid(ctx.req.params.id, 'id')))))

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
      await requireRecentMfa(ctx)
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
