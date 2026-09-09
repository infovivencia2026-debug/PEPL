/**
 * Statutory reference data: rates and slabs are the law, not a tenant setting.
 *
 * Effective-dated and snapshotted onto every payroll run, so a budget change
 * never retroactively alters a locked payroll.
 */
import type { PoolClient } from 'pg'
import type { StatutoryConfig } from './engine.ts'
import { fiscalYearOf, type TaxRules, type TaxSlab } from './tds.ts'

export class StatutoryError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'StatutoryError'
  }
}

export interface PtSlab {
  state_code: string
  gross_from_paise: string
  gross_to_paise: string | null
  amount_paise: string
  month_override: number | null
}

export interface LoadedStatutory {
  id: string
  config: StatutoryConfig
  ptSlabs: PtSlab[]
  taxSlabs: Record<'old' | 'new', TaxSlab[]>
  taxRules: Partial<Record<'old' | 'new', TaxRules>>
  fiscalYear: string
}

export async function loadStatutory(tx: PoolClient, asOf?: string): Promise<LoadedStatutory> {
  const date = asOf ?? new Date().toISOString().slice(0, 10)

  const { rows } = await tx.query<{
    id: string
    pf_employee_rate: string; pf_employer_rate: string; pf_wage_ceiling_paise: string
    esi_employee_rate: string; esi_employer_rate: string; esi_gross_threshold_paise: string
  }>(
    `SELECT id, pf_employee_rate::text, pf_employer_rate::text, pf_wage_ceiling_paise::text,
            esi_employee_rate::text, esi_employer_rate::text, esi_gross_threshold_paise::text
       FROM statutory_configs
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [date],
  )
  const row = rows[0]
  if (!row) {
    throw new StatutoryError(
      'NO_STATUTORY_CONFIG',
      `no statutory configuration is effective on ${date}. Reference data must be loaded before payroll can run.`,
    )
  }

  const { rows: slabs } = await tx.query<PtSlab>(
    `SELECT state_code, gross_from_paise::text, gross_to_paise::text, amount_paise::text, month_override
       FROM pt_slabs
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
      ORDER BY state_code, gross_from_paise`,
    [date],
  )

  const fiscalYear = fiscalYearOf(new Date(date))

  const { rows: slabRows } = await tx.query<TaxSlab & { regime: 'old' | 'new' }>(
    `SELECT regime, income_from_paise::text, income_to_paise::text, rate::text
       FROM tax_slabs WHERE fiscal_year = $1 ORDER BY regime, income_from_paise`,
    [fiscalYear],
  )
  const taxSlabs: Record<'old' | 'new', TaxSlab[]> = { old: [], new: [] }
  for (const r of slabRows) taxSlabs[r.regime].push(r)

  const { rows: ruleRows } = await tx.query<TaxRules & { regime: 'old' | 'new' }>(
    `SELECT regime, standard_deduction_paise::text, rebate_limit_paise::text,
            rebate_max_paise::text, cess_rate::text, surcharge_bands
       FROM tax_rules WHERE fiscal_year = $1`,
    [fiscalYear],
  )
  const taxRules: Partial<Record<'old' | 'new', TaxRules>> = {}
  for (const r of ruleRows) taxRules[r.regime] = r

  return {
    id: row.id,
    fiscalYear,
    taxSlabs,
    taxRules,
    config: {
      pf_employee_rate: Number(row.pf_employee_rate),
      pf_employer_rate: Number(row.pf_employer_rate),
      pf_wage_ceiling_paise: BigInt(row.pf_wage_ceiling_paise),
      esi_employee_rate: Number(row.esi_employee_rate),
      esi_employer_rate: Number(row.esi_employer_rate),
      esi_gross_threshold_paise: BigInt(row.esi_gross_threshold_paise),
    },
    ptSlabs: slabs,
  }
}

/** Slab lookup. A state with no slabs levies no professional tax. */
export function ptFor(slabs: readonly PtSlab[], stateCode: string, grossPaise: bigint, month?: number): bigint {
  const applicable = slabs.filter((s) => s.state_code === stateCode)
  if (applicable.length === 0) return 0n

  const g = grossPaise
  const match = applicable.find((s) => {
    const from = BigInt(s.gross_from_paise)
    const to = s.gross_to_paise === null ? null : BigInt(s.gross_to_paise)
    const monthOk = s.month_override === null || (month !== undefined && s.month_override === month)
    return g >= from && (to === null || g < to) && monthOk
  })

  // Some states levy a different amount in exactly one month of the year; a
  // month-specific slab wins over the general one for that month.
  const monthSpecific = applicable.find((s) => {
    if (s.month_override === null || month === undefined || s.month_override !== month) return false
    const from = BigInt(s.gross_from_paise)
    const to = s.gross_to_paise === null ? null : BigInt(s.gross_to_paise)
    return g >= from && (to === null || g < to)
  })

  return BigInt((monthSpecific ?? match)?.amount_paise ?? 0)
}
