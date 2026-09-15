/**
 * Statutory identifiers and filings.
 *
 * Identifiers are the sensitive tier: reading is `payroll.read` scoped to the
 * person (an employee sees their own UAN and PAN, payroll sees everyone's);
 * writing is `compensation.write`. A filing needs every identifier at once
 * and is `payroll.process` — the same hands that lock the run file it.
 */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, requireModule, asUuid, assertScope, emit } from './deps.ts'
import { getRun } from '../../payroll/run.ts'
import { loadStatutory } from '../../payroll/statutory.ts'
import { buildForm16, form16Pdf } from '../../payroll/form16.ts'
import {
  QUARTER_MONTHS, ecrFile, esiFile, filingRows, form24qAnnexureI, ptSummary, type Filing,
} from '../../payroll/filings.ts'

const IDS = 'id, employee_id, uan, pf_member_id, esi_number, pan, updated_at'
const FY = /^\d{4}-\d{2}$/

async function lockedRun(ctx: { tx: import('pg').PoolClient }, id: string) {
  const run = await getRun(ctx.tx, id)
  if (run.status !== 'locked') {
    throw new HttpError(409, 'RUN_NOT_LOCKED_FOR_FILING',
      'a return is filed from a LOCKED run; this one can still change')
  }
  const { rows } = await ctx.tx.query<{ period_start: string; label: string }>(
    `SELECT period_start::text, label FROM payroll_periods WHERE id = $1`, [run.period_id])
  return { run, periodStart: new Date(rows[0]!.period_start), period: rows[0]!.period_start.slice(0, 7) }
}

function deliver(filing: Filing) {
  return ok({
    fileName: filing.fileName,
    contentType: filing.contentType,
    rows: filing.rows,
    totalPaise: String(filing.totalPaise),
    omitted: filing.omitted,
    contentBase64: Buffer.from(filing.content).toString('base64'),
  })
}

export function register(router: Router): void {
  router.get('/api/v1/employees/:id/form16',
    { summary: 'Form 16 Part B for a fiscal year (?fy=2026-27; &format=pdf) — own record, or payroll',
      tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const fy = ctx.req.query.get('fy') ?? ''
      if (!FY.test(fy)) throw new HttpError(422, 'VALIDATION_FAILED', 'fy must look like 2026-27')
      // Slabs of the year the certificate is for, not this year's.
      const statutory = await loadStatutory(ctx.tx, `${Number(fy.slice(0, 4)) + 1}-03-31`)
      const form = await buildForm16(ctx.tx, {
        employeeId: id, fiscalYear: fy, slabs: statutory.taxSlabs, rules: statutory.taxRules,
        tan: ctx.config.get<string>('payroll.tan') || null,
      })
      await emit(ctx.tx, {
        action: 'access.tier3.revealed', entityType: 'employee', entityId: id, actorUserId: ctx.auth.userId,
        subjectEmployeeId: id, metadata: { document: 'form16', fiscalYear: fy, format: ctx.req.query.get('format') ?? 'json' },
      })
      if (ctx.req.query.get('format') === 'pdf') {
        const pdf = form16Pdf(form)
        return ok({ fileName: `Form16-PartB-${fy}-${form.employee.number}.pdf`, contentType: 'application/pdf',
          sizeBytes: pdf.length, contentBase64: pdf.toString('base64') })
      }
      return ok({ form16: form })
    }))

  router.get('/api/v1/employees/:id/statutory-ids',
    { summary: 'UAN, PF member id, ESI number and PAN (own record for an employee)',
      tag: 'payroll', permission: 'payroll.read' },
    authed('payroll.read', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const { rows } = await ctx.tx.query(
        `SELECT ${IDS} FROM employee_statutory_ids WHERE employee_id = $1`, [id])
      return ok({ statutoryIds: rows[0] ?? null })
    }))

  router.patch('/api/v1/employees/:id/statutory-ids',
    { summary: 'Set or correct statutory identifiers', tag: 'payroll', permission: 'compensation.write',
      requestExample: { uan: '100123456789', pan: 'ABCDE1234F', esiNumber: '3101234567', pfMemberId: 'TNMAS00123450000000123' } },
    authed('compensation.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      assertScope(ctx.auth, id)
      const b = requireBody<{ uan?: string | null; pfMemberId?: string | null; esiNumber?: string | null; pan?: string | null }>(ctx.req, [])
      const norm = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim().toUpperCase() : null)
      const tid = (await ctx.tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
      try {
        const { rows } = await ctx.tx.query(
          `INSERT INTO employee_statutory_ids (tenant_id, employee_id, uan, pf_member_id, esi_number, pan, updated_by_user_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (tenant_id, employee_id) DO UPDATE
             SET uan = coalesce(EXCLUDED.uan, employee_statutory_ids.uan),
                 pf_member_id = coalesce(EXCLUDED.pf_member_id, employee_statutory_ids.pf_member_id),
                 esi_number = coalesce(EXCLUDED.esi_number, employee_statutory_ids.esi_number),
                 pan = coalesce(EXCLUDED.pan, employee_statutory_ids.pan),
                 updated_at = now(), updated_by_user_id = EXCLUDED.updated_by_user_id
           RETURNING ${IDS}`,
          [tid, id, norm(b.uan), norm(b.pfMemberId), norm(b.esiNumber), norm(b.pan), ctx.auth.userId])
        await emit(ctx.tx, {
          action: 'employee.statutory_ids.changed', entityType: 'employee', entityId: id,
          actorUserId: ctx.auth.userId, subjectEmployeeId: id,
          metadata: { fields: Object.keys(b).filter((k) => b[k as keyof typeof b] != null) },
        })
        return ok({ statutoryIds: rows[0] })
      } catch (err) {
        const e = err as { code?: string; constraint?: string }
        if (e.code === '23514') {
          throw new HttpError(422, 'VALIDATION_FAILED',
            'UAN is 12 digits, PAN is AAAAA9999A, ESI number is 10 or 17 digits')
        }
        if (e.code === '23505') {
          throw new HttpError(409, 'DUPLICATE_IDENTIFIER',
            `that ${e.constraint === 'employee_pan_idx' ? 'PAN' : 'UAN'} is already on another employee's record`)
        }
        throw err
      }
    }))

  router.get('/api/v1/payroll/runs/:id/filings/ecr',
    { summary: 'EPFO ECR file for a locked run', tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const { periodStart, period } = await lockedRun(ctx, id)
      const statutory = await loadStatutory(ctx.tx, periodStart.toISOString().slice(0, 10))
      const filing = ecrFile(await filingRows(ctx.tx, id), {
        // EPS: 8.33% of wages up to the ceiling. The PF ceiling and the EPS
        // ceiling have been the same figure since 2014; if they diverge this
        // becomes its own statutory value.
        epsRate: 0.0833, epsWageCeilingPaise: statutory.config.pf_wage_ceiling_paise,
        period, establishment: ctx.config.get<string>('payroll.pf_establishment_code') || undefined,
      })
      await emit(ctx.tx, { action: 'payroll.filing.generated', entityType: 'payroll_run', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { filing: 'ecr', rows: filing.rows, omitted: filing.omitted.length } })
      return deliver(filing)
    }))

  router.get('/api/v1/payroll/runs/:id/filings/esi',
    { summary: 'ESIC monthly contribution file for a locked run', tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const { period } = await lockedRun(ctx, id)
      const filing = esiFile(await filingRows(ctx.tx, id), {
        period, code: ctx.config.get<string>('payroll.esi_employer_code') || undefined,
      })
      await emit(ctx.tx, { action: 'payroll.filing.generated', entityType: 'payroll_run', entityId: id,
        actorUserId: ctx.auth.userId, metadata: { filing: 'esi', rows: filing.rows, omitted: filing.omitted.length } })
      return deliver(filing)
    }))

  router.get('/api/v1/payroll/runs/:id/filings/pt',
    { summary: 'Professional tax summary by slab for a locked run', tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const id = asUuid(ctx.req.params.id, 'id')
      const { period } = await lockedRun(ctx, id)
      const rows = await filingRows(ctx.tx, id)
      const state = ctx.config.get<string>('payroll.pt_state_code')
        || (await ctx.tx.query<{ s: string }>(
          `SELECT state_code AS s FROM payroll_inputs WHERE run_id = $1 GROUP BY state_code ORDER BY count(*) DESC LIMIT 1`, [id]))
          .rows[0]?.s || 'XX'
      return deliver(ptSummary(rows, { period, stateCode: state }))
    }))

  router.get('/api/v1/payroll/filings/24q',
    { summary: 'Form 24Q Annexure I (deductee-wise TDS) for a quarter, from locked runs',
      tag: 'payroll', permission: 'payroll.process' },
    authed('payroll.process', async (ctx) => {
      requireModule(ctx, 'payroll.enabled')
      const fy = ctx.req.query.get('fy') ?? ''
      const quarter = ctx.req.query.get('quarter') ?? ''
      if (!FY.test(fy)) throw new HttpError(422, 'VALIDATION_FAILED', 'fy must look like 2026-27')
      const months = QUARTER_MONTHS[quarter]
      if (!months) throw new HttpError(422, 'INVALID_QUARTER', 'quarter must be Q1, Q2, Q3 or Q4')
      const startYear = Number(fy.slice(0, 4)) + (quarter === 'Q4' ? 1 : 0)
      const from = new Date(Date.UTC(startYear, months[0], 1)).toISOString().slice(0, 10)
      const to = new Date(Date.UTC(startYear, months[1] + 1, 1)).toISOString().slice(0, 10)

      const { rows } = await ctx.tx.query<{
        month: string; employee_number: string; first_name: string; last_name: string | null
        pan: string | null; gross: string; tds: string
      }>(
        `SELECT to_char(pp.period_start, 'YYYY-MM') AS month, e.employee_number, e.first_name, e.last_name,
                s.pan, p.gross_paise::text AS gross,
                coalesce((SELECT sum(amount_paise) FROM payroll_lines l
                           WHERE l.tenant_id = p.tenant_id AND l.run_id = p.run_id
                             AND l.employee_id = p.employee_id AND l.component_code = 'TDS'), 0)::text AS tds
           FROM payslips p
           JOIN payroll_runs r ON (r.tenant_id, r.id) = (p.tenant_id, p.run_id)
           JOIN payroll_periods pp ON (pp.tenant_id, pp.id) = (r.tenant_id, r.period_id)
           JOIN employees e ON (e.tenant_id, e.id) = (p.tenant_id, p.employee_id)
           LEFT JOIN employee_statutory_ids s ON (s.tenant_id, s.employee_id) = (e.tenant_id, e.id)
          WHERE r.status = 'locked'
            AND pp.period_start >= $1::date AND pp.period_start < $2::date
            AND NOT EXISTS (SELECT 1 FROM payroll_runs n
                             WHERE n.tenant_id = r.tenant_id AND n.supersedes_run_id = r.id AND n.status = 'locked')
          ORDER BY pp.period_start, e.employee_number`,
        [from, to])

      const filing = form24qAnnexureI(rows.map((r) => ({
        month: r.month, employeeNumber: r.employee_number, pan: r.pan,
        name: [r.first_name, r.last_name].filter(Boolean).join(' '),
        grossPaise: BigInt(r.gross), tdsPaise: BigInt(r.tds),
      })), { quarter, fiscalYear: fy, tan: ctx.config.get<string>('payroll.tan') || undefined })
      await emit(ctx.tx, { action: 'payroll.filing.generated', entityType: 'tds_return', entityId: undefined,
        actorUserId: ctx.auth.userId, metadata: { filing: '24q', fy, quarter, rows: filing.rows, omitted: filing.omitted.length } })
      return deliver(filing)
    }))
}
