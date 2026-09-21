/**
 * Income-tax and PF/ESI reference data, per fiscal year.
 *
 * REFERENCE DATA. These are the figures as understood when written; the
 * Finance Act for each year is the authority, and a compliance owner must
 * reconcile before the first payroll of a year. They live in code so a wrong
 * figure is a reviewed commit rather than an untraceable row edit, and are
 * loaded by `npm run seed:statutory` (idempotent per fiscal year).
 *
 * A fiscal year with NO entry here blocks payroll validation for that year
 * (`NO_TAX_SLABS`) rather than deducting zero tax and paying out.
 */

export interface SlabRow { from: number; to: number | null; rate: number }        // rupees
export interface RegimeRules {
  standardDeduction: number
  rebateLimit: number
  rebateMax: number
  cessRate: number
  surcharge: { above: number; rate: number }[]
}
export interface FiscalYearTables {
  fiscalYear: string
  slabs: { new: SlabRow[]; old: SlabRow[] }
  rules: { new: RegimeRules; old: RegimeRules }
  note: string
}

const NEW_2026: SlabRow[] = [
  { from: 0, to: 400_000, rate: 0 }, { from: 400_000, to: 800_000, rate: 0.05 },
  { from: 800_000, to: 1_200_000, rate: 0.10 }, { from: 1_200_000, to: 1_600_000, rate: 0.15 },
  { from: 1_600_000, to: 2_000_000, rate: 0.20 }, { from: 2_000_000, to: 2_400_000, rate: 0.25 },
  { from: 2_400_000, to: null, rate: 0.30 },
]
const OLD: SlabRow[] = [
  { from: 0, to: 250_000, rate: 0 }, { from: 250_000, to: 500_000, rate: 0.05 },
  { from: 500_000, to: 1_000_000, rate: 0.20 }, { from: 1_000_000, to: null, rate: 0.30 },
]
const SURCHARGE = [{ above: 5_000_000, rate: 0.10 }, { above: 10_000_000, rate: 0.15 }]
const NEW_RULES: RegimeRules = { standardDeduction: 75_000, rebateLimit: 1_200_000, rebateMax: 60_000, cessRate: 0.04, surcharge: SURCHARGE }
const OLD_RULES: RegimeRules = { standardDeduction: 50_000, rebateLimit: 500_000, rebateMax: 12_500, cessRate: 0.04, surcharge: SURCHARGE }

export const INCOME_TAX: readonly FiscalYearTables[] = [
  { fiscalYear: '2026-27', slabs: { new: NEW_2026, old: OLD }, rules: { new: NEW_RULES, old: OLD_RULES },
    note: 'Finance Act 2026 figures as understood at authoring; reconcile before the April 2026 payroll.' },
  // The following year is pre-loaded with the same figures so a payroll on
  // 1 April is not blocked by a deploy that has not happened yet. The
  // reconciliation note is the reminder that it is a carry-forward.
  { fiscalYear: '2027-28', slabs: { new: NEW_2026, old: OLD }, rules: { new: NEW_RULES, old: OLD_RULES },
    note: 'CARRY-FORWARD of 2026-27 pending the Finance Act 2027; reconcile before the April 2027 payroll.' },
]

/** PF/ESI rates. One row in force since well before any tenant's first payroll. */
export const STATUTORY_CONFIG = {
  effectiveFrom: '2020-04-01',
  pfEmployeeRate: 0.12,
  pfEmployerRate: 0.12,
  pfWageCeiling: 15_000,
  esiEmployeeRate: 0.0075,
  esiEmployerRate: 0.0325,
  esiGrossThreshold: 21_000,
  notes: 'EPF 12%/12% on wages to ₹15,000; ESI 0.75%/3.25% on gross to ₹21,000. Reference data — reconcile against current notifications.',
}
