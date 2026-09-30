/**
 * Statutory filings from a locked run.
 *
 * PEPL computed correct PF, ESI, PT and TDS from the beginning and produced no
 * return, so a company still did the month twice: once here and once in a
 * spreadsheet for the portals. These are the four filings an Indian employer
 * owes every month or quarter.
 *
 *   ECR    EPFO, monthly, `#~#`-separated text, one line per member
 *   ESI    ESIC, monthly, CSV of insurance number and contribution
 *   PT     state, monthly, a summary by slab — no national format exists
 *   24Q    TDS, quarterly, deductee-wise (Annexure I) as CSV
 *
 * Two rules hold everything:
 *
 * - **A filing is DERIVED from a locked run, never stored.** A locked run is
 *   immutable, so the same run always renders the same bytes; there is nothing
 *   to keep in sync and no second copy to go stale. (Bank files are the
 *   opposite and are stored — there the risk is paying twice, not filing twice.)
 * - **Missing identifiers are REPORTED, not skipped.** A return filed without
 *   an employee is worse than one that will not generate: the person's PF year
 *   silently has a hole. Every generator returns `omitted` with the reason.
 */
import type { PoolClient } from 'pg'
import { csvCell } from '../lib/csv.ts'

export class FilingError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'FilingError'
  }
}

export interface FilingRow {
  employeeId: string
  employeeNumber: string
  name: string
  uan: string | null
  esiNumber: string | null
  pan: string | null
  grossPaise: bigint
  /** The wage PF was computed on, from the PF_EE line's note. */
  pfWagePaise: bigint
  pfEmployeePaise: bigint
  /** The EPF share of the employer's 12% -- the ECR reports it apart from pension. */
  pfEmployerPaise: bigint
  /** The pension (EPS) share of the same 12%. */
  pfPensionPaise: bigint
  esiEmployeePaise: bigint
  esiEmployerPaise: bigint
  ptPaise: bigint
  tdsPaise: bigint
  lopDays: number
}

export interface Filing {
  fileName: string
  contentType: string
  content: string
  rows: number
  totalPaise: bigint
  /** Employees left out, and why. Never silent. */
  omitted: { employeeNumber: string; name: string; reason: string }[]
}

const rupees = (paise: bigint): string => (Number(paise) / 100).toFixed(2)
/** EPFO wants whole rupees, rounded down: a paisa over is a rejected file. */
const wholeRupees = (paise: bigint): string => String(Math.floor(Number(paise) / 100))

/** CSV field: quote only when it must be, and never let a value break the row. */
const csv = (v: string | number): string => csvCell(v)

/**
 * The run's rows, joined to the statutory identifiers.
 *
 * Reads payroll_lines, which is what the run actually paid — not live
 * compensation, and not a recomputation that could disagree with the payslip
 * the employee is holding.
 */
export async function filingRows(tx: PoolClient, runId: string): Promise<FilingRow[]> {
  const { rows } = await tx.query<{
    employee_id: string; employee_number: string; first_name: string; last_name: string | null
    uan: string | null; esi_number: string | null; pan: string | null
    gross: string; lop_days: string
    pf_ee: string; pf_er: string; pf_eps: string; esi_ee: string; esi_er: string; pt: string; tds: string
    pf_wage: string | null
  }>(
    `SELECT e.id AS employee_id, e.employee_number, e.first_name, e.last_name,
            s.uan, s.esi_number, s.pan,
            p.gross_paise::text AS gross, i.lop_days::text AS lop_days,
            coalesce(l.pf_ee, 0)::text AS pf_ee,
            -- The TOTAL employer contribution: PF_ER now holds only the EPF
            -- remainder, so the pension line has to be added back. Everything
            -- downstream has always meant "the employer's 12%" by this.
            (coalesce(l.pf_er, 0) + coalesce(l.pf_eps, 0))::text AS pf_er,
            coalesce(l.pf_eps, 0)::text AS pf_eps,
            coalesce(l.esi_ee, 0)::text AS esi_ee, coalesce(l.esi_er, 0)::text AS esi_er,
            coalesce(l.pt, 0)::text AS pt, coalesce(l.tds, 0)::text AS tds,
            l.pf_wage::text AS pf_wage
       FROM payslips p
       JOIN employees e ON (e.tenant_id, e.id) = (p.tenant_id, p.employee_id)
       JOIN payroll_inputs i ON (i.tenant_id, i.run_id, i.employee_id) = (p.tenant_id, p.run_id, p.employee_id)
       LEFT JOIN employee_statutory_ids s ON (s.tenant_id, s.employee_id) = (e.tenant_id, e.id)
       LEFT JOIN LATERAL (
         SELECT sum(amount_paise) FILTER (WHERE component_code = 'PF_EE')  AS pf_ee,
                sum(amount_paise) FILTER (WHERE component_code = 'PF_ER')  AS pf_er,
                -- The ECR has separate EPF and EPS columns. Before the split
                -- there was one PF_ER line and nothing to put in the second.
                sum(amount_paise) FILTER (WHERE component_code = 'PF_EPS') AS pf_eps,
                sum(amount_paise) FILTER (WHERE component_code = 'ESI_EE') AS esi_ee,
                sum(amount_paise) FILTER (WHERE component_code = 'ESI_ER') AS esi_er,
                sum(amount_paise) FILTER (WHERE component_code = 'PT')     AS pt,
                sum(amount_paise) FILTER (WHERE component_code = 'TDS')    AS tds,
                max((calc_note ->> 'pfWage')::numeric) FILTER (WHERE component_code = 'PF_EE') AS pf_wage
           FROM payroll_lines
          WHERE tenant_id = p.tenant_id AND run_id = p.run_id AND employee_id = p.employee_id
       ) l ON true
      WHERE p.run_id = $1
      ORDER BY e.employee_number`,
    [runId],
  )

  return rows.map((r) => ({
    employeeId: r.employee_id,
    employeeNumber: r.employee_number,
    name: [r.first_name, r.last_name].filter(Boolean).join(' '),
    uan: r.uan,
    esiNumber: r.esi_number,
    pan: r.pan,
    grossPaise: BigInt(r.gross),
    pfWagePaise: BigInt(Math.round(Number(r.pf_wage ?? '0'))),
    pfEmployeePaise: BigInt(r.pf_ee),
    pfEmployerPaise: BigInt(r.pf_er),
    pfPensionPaise: BigInt(r.pf_eps),
    esiEmployeePaise: BigInt(r.esi_ee),
    esiEmployerPaise: BigInt(r.esi_er),
    ptPaise: BigInt(r.pt),
    tdsPaise: BigInt(r.tds),
    lopDays: Number(r.lop_days),
  }))
}

export interface EcrOptions {
  /** EPS is 8.33% of EPS wages, capped at the EPS ceiling (₹15,000 today). */
  epsRate: number
  epsWageCeilingPaise: bigint
  period: string        // '2026-09'
  establishment?: string
}

/**
 * The EPFO ECR file.
 *
 * Eleven `#~#`-separated fields per member. The split that trips everyone up:
 * the employer's 12% is not all EPF — 8.33% of EPS wages goes to the pension
 * scheme and only the remainder to EPF, so field 9 is `employer total − EPS`.
 * EPS wages are capped even where the company contributes PF on full wages.
 */
export function ecrFile(rows: readonly FilingRow[], opts: EcrOptions): Filing {
  const lines: string[] = []
  const omitted: Filing['omitted'] = []
  let total = 0n

  for (const r of rows) {
    if (r.pfEmployeePaise === 0n && r.pfEmployerPaise === 0n) continue   // PF does not apply
    if (!r.uan) {
      omitted.push({ employeeNumber: r.employeeNumber, name: r.name,
        reason: 'no UAN on file — EPFO cannot accept a member without one' })
      continue
    }

    const epsWage = r.pfWagePaise > opts.epsWageCeilingPaise ? opts.epsWageCeilingPaise : r.pfWagePaise
    // Prefer what was actually BOOKED. Recomputing here can differ from the
    // ledger by a rupee -- this function floors while the engine rounds -- and
    // a return that disagrees with the payslip it came from is the kind of
    // discrepancy that takes an afternoon to explain. Falls back to deriving
    // it for a run written before the pension line existed.
    const eps = r.pfPensionPaise > 0n
      ? r.pfPensionPaise
      : BigInt(Math.round(Number(epsWage) * opts.epsRate))
    // The employer's share never goes negative: where EPS would exceed it (a
    // wage below the EPS floor), EPF takes nothing rather than a negative.
    const epfEmployer = r.pfEmployerPaise > eps ? r.pfEmployerPaise - eps : 0n

    lines.push([
      r.uan,
      // The portal rejects '#' inside a name, which is also the separator.
      r.name.replace(/#/g, ' ').toUpperCase(),
      wholeRupees(r.grossPaise),
      wholeRupees(r.pfWagePaise),
      wholeRupees(epsWage),
      wholeRupees(r.pfWagePaise),        // EDLI wages track EPF wages
      wholeRupees(r.pfEmployeePaise),
      wholeRupees(eps),
      wholeRupees(epfEmployer),
      String(Math.round(r.lopDays)),     // NCP: non-contributory period, in days
      '0',                               // refund of advances
    ].join('#~#'))
    total += r.pfEmployeePaise + r.pfEmployerPaise
  }

  return {
    fileName: `ECR_${opts.establishment ?? 'ESTABLISHMENT'}_${opts.period}.txt`,
    contentType: 'text/plain; charset=utf-8',
    // The portal expects a trailing newline; without one the last member is dropped.
    content: lines.length ? lines.join('\n') + '\n' : '',
    rows: lines.length,
    totalPaise: total,
    omitted,
  }
}

/** ESIC monthly contribution: insurance number, name, days, wages, contribution. */
export function esiFile(
  rows: readonly FilingRow[],
  opts: { period: string; code?: string; workingDays?: number },
): Filing {
  const out = ['IPNumber,IPName,NoOfDays,TotalMonthlyWages,ReasonCode,LastWorkingDay']
  const omitted: Filing['omitted'] = []
  let total = 0n

  for (const r of rows) {
    if (r.esiEmployeePaise === 0n && r.esiEmployerPaise === 0n) continue   // above the threshold
    if (!r.esiNumber) {
      omitted.push({ employeeNumber: r.employeeNumber, name: r.name,
        reason: 'no ESI insurance number on file' })
      continue
    }
    const days = Math.max(0, (opts.workingDays ?? 30) - Math.round(r.lopDays))
    out.push([r.esiNumber, csv(r.name.toUpperCase()), days, rupees(r.grossPaise), 0, ''].join(','))
    total += r.esiEmployeePaise + r.esiEmployerPaise
  }

  return {
    fileName: `ESI_${opts.code ?? 'CODE'}_${opts.period}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: out.join('\n') + '\n',
    rows: out.length - 1,
    totalPaise: total,
    omitted,
  }
}

/**
 * Professional tax.
 *
 * PT is a STATE tax with no national return format — each state's portal takes
 * its own. What every one of them needs is the same: how many people in each
 * slab and how much was deducted, which is what this summarises. It is a
 * working paper for the person filing, not a file to upload.
 */
export function ptSummary(
  rows: readonly FilingRow[],
  opts: { period: string; stateCode: string },
): Filing {
  const bySlab = new Map<string, { count: number; total: bigint }>()
  let total = 0n
  for (const r of rows) {
    if (r.ptPaise === 0n) continue
    const key = rupees(r.ptPaise)
    const entry = bySlab.get(key) ?? { count: 0, total: 0n }
    entry.count++
    entry.total += r.ptPaise
    bySlab.set(key, entry)
    total += r.ptPaise
  }
  const out = ['State,Period,SlabAmount,Employees,TotalDeducted']
  for (const [slab, e] of [...bySlab].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    out.push([opts.stateCode, opts.period, slab, e.count, rupees(e.total)].join(','))
  }
  out.push(['', '', 'TOTAL', [...bySlab.values()].reduce((n, e) => n + e.count, 0), rupees(total)].join(','))

  return {
    fileName: `PT_${opts.stateCode}_${opts.period}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: out.join('\n') + '\n',
    rows: bySlab.size,
    totalPaise: total,
    omitted: [],
  }
}

/**
 * Form 24Q Annexure I: deductee-wise TDS for a quarter.
 *
 * Produced as CSV for the return-preparation utility rather than as the .fvu
 * binary — that format is validated by NSDL's own tool, which every filer
 * already runs, and generating it here would mean shipping their validator's
 * rules and keeping them current. A PAN-less deductee is reported, because
 * filing without one attracts a higher deduction rate and a notice.
 */
export function form24qAnnexureI(
  rows: readonly { pan: string | null; name: string; employeeNumber: string; grossPaise: bigint; tdsPaise: bigint; month: string }[],
  opts: { quarter: string; fiscalYear: string; tan?: string },
): Filing {
  const out = ['Month,EmployeeNumber,DeducteeName,PAN,AmountPaidRs,TDSDeductedRs']
  const omitted: Filing['omitted'] = []
  let total = 0n
  for (const r of rows) {
    if (r.tdsPaise === 0n) continue
    if (!r.pan) {
      omitted.push({ employeeNumber: r.employeeNumber, name: r.name,
        reason: 'no PAN on file — filing without one attracts deduction at 20%' })
      continue
    }
    out.push([r.month, csv(r.employeeNumber), csv(r.name.toUpperCase()), r.pan,
      rupees(r.grossPaise), rupees(r.tdsPaise)].join(','))
    total += r.tdsPaise
  }
  return {
    fileName: `24Q_${opts.tan ?? 'TAN'}_${opts.fiscalYear}_${opts.quarter}.csv`,
    contentType: 'text/csv; charset=utf-8',
    content: out.join('\n') + '\n',
    rows: out.length - 1,
    totalPaise: total,
    omitted,
  }
}

/** Which quarter an Indian fiscal month falls in. Q1 is April–June. */
export function quarterOf(periodStart: Date): 'Q1' | 'Q2' | 'Q3' | 'Q4' {
  const m = periodStart.getMonth()
  if (m >= 3 && m <= 5) return 'Q1'
  if (m >= 6 && m <= 8) return 'Q2'
  if (m >= 9 && m <= 11) return 'Q3'
  return 'Q4'
}

export const QUARTER_MONTHS: Record<string, [number, number]> = {
  Q1: [3, 5], Q2: [6, 8], Q3: [9, 11], Q4: [0, 2],
}
