/**
 * Labour Welfare Fund — reference rates by state.
 *
 * Amounts are rupees per contribution, per employee; `months` are the salary
 * months the deduction is taken in (Indian practice: half-yearly in June and
 * December for most states, annual for some, monthly for a few). Ceilings and
 * rates are revised by state notification; treat this as a starting point and
 * reconcile against the current notification before the first deduction.
 */
export interface LwfStateRef {
  code: string
  name: string
  employee: number
  employer: number
  months: number[]
  /** Monthly wage above which the fund does not apply; undefined = everyone. */
  ceiling?: number
}

export const LWF_STATES: readonly LwfStateRef[] = [
  { code: 'MH', name: 'Maharashtra', employee: 25, employer: 75, months: [6, 12] },
  { code: 'KA', name: 'Karnataka', employee: 20, employer: 40, months: [12] },
  { code: 'TN', name: 'Tamil Nadu', employee: 20, employer: 40, months: [12] },
  { code: 'GJ', name: 'Gujarat', employee: 6, employer: 12, months: [6, 12] },
  { code: 'WB', name: 'West Bengal', employee: 3, employer: 15, months: [6, 12] },
  { code: 'AP', name: 'Andhra Pradesh', employee: 30, employer: 70, months: [12] },
  { code: 'TS', name: 'Telangana', employee: 2, employer: 5, months: [12] },
  { code: 'KL', name: 'Kerala', employee: 50, employer: 50, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { code: 'MP', name: 'Madhya Pradesh', employee: 10, employer: 30, months: [6, 12] },
  { code: 'DL', name: 'Delhi', employee: 0.75, employer: 2.25, months: [6, 12] },
  { code: 'HR', name: 'Haryana', employee: 31, employer: 62, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { code: 'PB', name: 'Punjab', employee: 5, employer: 20, months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { code: 'CG', name: 'Chhattisgarh', employee: 15, employer: 45, months: [6, 12] },
  { code: 'OR', name: 'Odisha', employee: 20, employer: 40, months: [6, 12] },
  { code: 'GA', name: 'Goa', employee: 60, employer: 180, months: [6, 12] },
]
