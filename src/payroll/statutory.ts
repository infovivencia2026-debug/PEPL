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

export interface LwfRate {
  state_code: string
  employee_paise: string
  employer_paise: string
  deduction_months: number[]
  wage_ceiling_paise: string | null
}

export interface LoadedStatutory {
  id: string
  config: StatutoryConfig
  ptSlabs: PtSlab[]
  /** Who does not pay it despite falling in a slab. */
  ptExemptions: PtExemption[]
  lwfRates: LwfRate[]
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
    eps_rate: string; eps_wage_ceiling_paise: string
    edli_rate: string; edli_wage_ceiling_paise: string
  }>(
    `SELECT id, pf_employee_rate::text, pf_employer_rate::text, pf_wage_ceiling_paise::text,
            esi_employee_rate::text, esi_employer_rate::text, esi_gross_threshold_paise::text,
            eps_rate::text, eps_wage_ceiling_paise::text,
            edli_rate::text, edli_wage_ceiling_paise::text
       FROM statutory_configs
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
      ORDER BY effective_from DESC LIMIT 1`,
    [date],
  )
  const { rows: exemptionRows } = await tx.query<{ state_code: string; gender: string | null; gross_upto_paise: string }>(
    `SELECT state_code, gender, gross_upto_paise::text
       FROM pt_exemptions
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)`,
    [date])
  const ptExemptions = exemptionRows

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

  const { rows: lwfRates } = await tx.query<LwfRate>(
    `SELECT state_code, employee_paise::text, employer_paise::text, deduction_months, wage_ceiling_paise::text
       FROM lwf_rates
      WHERE effective_from <= $1::date AND (effective_to IS NULL OR effective_to > $1::date)
      ORDER BY state_code`,
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
    lwfRates,
    config: {
      pf_employee_rate: Number(row.pf_employee_rate),
      pf_employer_rate: Number(row.pf_employer_rate),
      pf_wage_ceiling_paise: BigInt(row.pf_wage_ceiling_paise),
      esi_employee_rate: Number(row.esi_employee_rate),
      esi_employer_rate: Number(row.esi_employer_rate),
      esi_gross_threshold_paise: BigInt(row.esi_gross_threshold_paise),
      // The employer's 12% is split into pension and provident fund, and EDLI
      // rides on top. Effective-dated like every other rate, so a locked run
      // keeps computing the way it did when it was locked.
      eps_rate: Number(row.eps_rate),
      eps_wage_ceiling_paise: BigInt(row.eps_wage_ceiling_paise),
      edli_rate: Number(row.edli_rate),
      edli_wage_ceiling_paise: BigInt(row.edli_wage_ceiling_paise),
    },
    ptSlabs: slabs,
    ptExemptions,
  }
}

export interface PtExemption {
  state_code: string
  gender: string | null
  gross_upto_paise: string
}

/**
 * Slab lookup. A state with no slabs levies no professional tax.
 *
 * Exemptions are checked FIRST and are separate data: Maharashtra exempts
 * women up to Rs 25,000 a month, and PEPL used to apply the general slab to
 * everyone -- deducting professional tax from people who did not owe it.
 */
export function ptFor(
  slabs: readonly PtSlab[],
  stateCode: string,
  grossPaise: bigint,
  month?: number,
  gender?: string | null,
  exemptions: readonly PtExemption[] = [],
): bigint {
  for (const e of exemptions) {
    if (e.state_code !== stateCode) continue
    // A NULL gender on the exemption means it is not gendered at all.
    if (e.gender !== null && e.gender !== gender) continue
    if (grossPaise <= BigInt(e.gross_upto_paise)) return 0n
  }
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

/** LWF for a state in a calendar month (1–12): zero outside the state's collection months or above its wage ceiling. */
export function lwfFor(rates: readonly LwfRate[], stateCode: string, month: number, grossPaise: bigint): { employee: bigint; employer: bigint } {
  const r = rates.find((x) => x.state_code === stateCode)
  if (!r || !r.deduction_months.includes(month)) return { employee: 0n, employer: 0n }
  if (r.wage_ceiling_paise !== null && grossPaise > BigInt(r.wage_ceiling_paise)) return { employee: 0n, employer: 0n }
  return { employee: BigInt(r.employee_paise), employer: BigInt(r.employer_paise) }
}
