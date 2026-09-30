/**
 * The engine options for a payroll run, built ONCE.
 *
 * The browser (/api/ui) and the API (/api/v1) each assembled these by hand, and
 * they disagreed:
 *
 *   - the browser passed no `computeTds` and no component flags, so every payroll
 *     run from the UI deducted ZERO income tax (found by the audit; the existing
 *     workflow test paid a salary under the rebate threshold and asserted only that
 *     net pay was positive);
 *   - the API passed no month, so a state's February professional-tax rule never
 *     applied, and loaded the statutory rates of TODAY rather than the run's period
 *     -- so a March run calculated in April used FY 26-27's tables for FY 25-26;
 *   - the API read LIVE configuration where the run had frozen a snapshot.
 *
 * Everything here comes from the run itself: its own period, the statutory config
 * it was frozen against, and the config snapshot taken at freeze. The wall clock
 * and today's settings have no say, which is the whole point of freezing.
 */
import type { PoolClient } from 'pg'
import { loadStatutory, ptFor, type LoadedStatutory } from './statutory.ts'
import { computeTds } from './tds.ts'
import { componentFlags } from './structures.ts'
import { PayrollError, type calculate } from './run.ts'

/** The options `calculate()` takes, plus the tax-table coverage `validate()` also wants. */
export type RunOptions = Parameters<typeof calculate>[2] & {
  taxTables: { fiscalYear: string; regimes: Record<'old' | 'new', boolean> }
}

/**
 * Binds the run's statutory slab data to the engine's TDS hook. With no slabs
 * configured for a regime it deducts nothing and says why in the trace, rather
 * than silently deducting a wrong figure.
 */
export function tdsFor(statutory: LoadedStatutory) {
  return (args: {
    monthlyTaxableGrossPaise: bigint; regime: 'old' | 'new'; declaredDeductionsPaise: bigint
    earnedToDatePaise: bigint; deductedToDatePaise: bigint; monthsRemaining: number
  }) => {
    const rules = statutory.taxRules[args.regime]
    const slabs = statutory.taxSlabs[args.regime]
    if (!rules || slabs.length === 0) {
      return { monthlyTdsPaise: 0n, trace: { reason: 'no tax slabs configured' } }
    }
    const r = computeTds(
      {
        monthlyTaxableGrossPaise: args.monthlyTaxableGrossPaise,
        // All three are frozen VALUES on the run; the wall clock has no say.
        monthsRemaining: args.monthsRemaining,
        earnedToDatePaise: args.earnedToDatePaise,
        deductedToDatePaise: args.deductedToDatePaise,
        regime: args.regime,
        declaredDeductionsPaise: args.declaredDeductionsPaise,
      },
      slabs,
      rules,
    )
    return { monthlyTdsPaise: r.monthlyTdsPaise, trace: r.trace }
  }
}

/** The last day of the run's period, which is what its statutory rates are read as of. */
export async function periodEndOf(tx: PoolClient, runId: string): Promise<string> {
  const { rows } = await tx.query<{ period_end: string }>(
    `SELECT p.period_end::text FROM payroll_runs r
       JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id)
      WHERE r.id = $1`, [runId])
  if (!rows[0]) throw new PayrollError('RUN_NOT_FOUND', 'no such payroll run')
  return rows[0].period_end
}

export async function loadRunOptions(tx: PoolClient, runId: string): Promise<RunOptions> {
  const { rows } = await tx.query<{
    statutory_config_id: string | null; config_snapshot: Record<string, unknown> | null; period_end: string
  }>(
    `SELECT r.statutory_config_id, r.config_snapshot, p.period_end::text
       FROM payroll_runs r JOIN payroll_periods p ON (p.tenant_id, p.id) = (r.tenant_id, r.period_id)
      WHERE r.id = $1`, [runId])
  const run = rows[0]
  if (!run) throw new PayrollError('RUN_NOT_FOUND', 'no such payroll run')

  // As of the PERIOD. A March run calculated in April must use the year it belongs
  // to, not the year the calendar has moved on to.
  const statutory = await loadStatutory(tx, run.period_end)
  if (statutory.id !== run.statutory_config_id) {
    throw new PayrollError('STATUTORY_CHANGED',
      'The reference rates differ from the frozen run. Review this run before calculating.')
  }

  const snapshot = run.config_snapshot ?? {}
  const month = Number(run.period_end.slice(5, 7))
  return {
    statutory: statutory.config,
    components: (await componentFlags(tx)) ?? undefined,
    // The MONTH matters: some states levy a different amount in exactly one of
    // them (February), and without it that rule silently never applies. Gender and
    // exemptions matter too -- Maharashtra exempts women up to Rs 25,000.
    ptAmountPaise: (state, gross, gender) =>
      ptFor(statutory.ptSlabs, state, gross, month, gender, statutory.ptExemptions),
    lwfRates: statutory.lwfRates,
    // The run's frozen snapshot, not today's settings.
    pfOnFullWage: Boolean(snapshot.pf_on_full_wage),
    lopBasis: (snapshot.lop_basis as 'calendar_days' | 'fixed_30' | 'working_days' | undefined) ?? 'calendar_days',
    computeTds: tdsFor(statutory),
    taxTables: {
      fiscalYear: statutory.fiscalYear,
      regimes: {
        new: statutory.taxSlabs.new.length > 0 && !!statutory.taxRules.new,
        old: statutory.taxSlabs.old.length > 0 && !!statutory.taxRules.old,
      },
    },
  }
}
