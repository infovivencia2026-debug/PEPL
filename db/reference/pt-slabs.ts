/**
 * Professional tax slabs by state — REFERENCE DATA, to be reconciled.
 *
 * Professional tax is a state levy under Article 276 (₹2,500 a year at most),
 * and about half the states levy it, each with its own slabs, its own idea of
 * "salary", and in several cases a different amount in one month so the year
 * comes to exactly ₹2,500. The figures below are the commonly published slabs
 * as this file was written; states amend them by notification, so every entry
 * carries `verifiedOn` and the seed writes them with an effective date. A
 * compliance owner corrects a state by editing this file and re-running
 * `npm run seed:statutory` — it is data, not a deploy.
 *
 * Amounts are MONTHLY rupees and thresholds MONTHLY gross rupees. States that
 * assess half-yearly (TN, KL) are expressed as the monthly equivalent, which
 * is how payroll deducts them; the half-yearly remittance is the filer's.
 */

export interface PtSlabRef {
  /** Monthly gross from (inclusive), in rupees. */
  from: number
  /** Monthly gross to (exclusive), in rupees; null = no upper bound. */
  to: number | null
  /** Monthly amount in rupees. */
  amount: number
  /** 1–12: this amount applies in that month only (the annual make-up month). */
  month?: number
}

export interface PtStateRef {
  code: string
  name: string
  /** ISO date the figures were checked against a published source. */
  verifiedOn: string
  note?: string
  slabs: PtSlabRef[]
}

export const PT_STATES: readonly PtStateRef[] = [
  { code: 'AP', name: 'Andhra Pradesh', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 15_000, amount: 0 }, { from: 15_000, to: 20_000, amount: 150 }, { from: 20_000, to: null, amount: 200 }] },
  { code: 'TS', name: 'Telangana', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 15_000, amount: 0 }, { from: 15_000, to: 20_000, amount: 150 }, { from: 20_000, to: null, amount: 200 }] },
  { code: 'KA', name: 'Karnataka', verifiedOn: '2026-09-01', note: 'Threshold raised to ₹25,000 by the 2024 amendment; ₹300 in February.',
    slabs: [{ from: 0, to: 25_000, amount: 0 }, { from: 25_000, to: null, amount: 200 }, { from: 25_000, to: null, amount: 300, month: 2 }] },
  { code: 'MH', name: 'Maharashtra', verifiedOn: '2026-09-01', note: 'Women are exempt up to ₹25,000; PEPL applies the general slab — model the exemption per employee before relying on it.',
    slabs: [{ from: 0, to: 7_500, amount: 0 }, { from: 7_500, to: 10_000, amount: 175 }, { from: 10_000, to: null, amount: 200 }, { from: 10_000, to: null, amount: 300, month: 2 }] },
  { code: 'GJ', name: 'Gujarat', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 12_000, amount: 0 }, { from: 12_000, to: null, amount: 200 }] },
  { code: 'WB', name: 'West Bengal', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 10_000, amount: 0 }, { from: 10_000, to: 15_000, amount: 110 }, { from: 15_000, to: 25_000, amount: 130 }, { from: 25_000, to: 40_000, amount: 150 }, { from: 40_000, to: null, amount: 200 }] },
  { code: 'TN', name: 'Tamil Nadu', verifiedOn: '2026-09-01', note: 'Assessed half-yearly by the local body (Chennai Corporation slabs shown as monthly equivalents).',
    slabs: [{ from: 0, to: 3_500, amount: 0 }, { from: 3_500, to: 5_000, amount: 22 }, { from: 5_000, to: 7_500, amount: 52 }, { from: 7_500, to: 10_000, amount: 115 }, { from: 10_000, to: 12_500, amount: 171 }, { from: 12_500, to: null, amount: 208 }] },
  { code: 'KL', name: 'Kerala', verifiedOn: '2026-09-01', note: 'Assessed half-yearly by the panchayat/municipality; monthly equivalents shown.',
    slabs: [{ from: 0, to: 2_000, amount: 0 }, { from: 2_000, to: 3_000, amount: 20 }, { from: 3_000, to: 5_000, amount: 30 }, { from: 5_000, to: 7_500, amount: 50 }, { from: 7_500, to: 10_000, amount: 75 }, { from: 10_000, to: 12_500, amount: 100 }, { from: 12_500, to: 16_667, amount: 125 }, { from: 16_667, to: 20_833, amount: 166 }, { from: 20_833, to: null, amount: 208 }] },
  { code: 'MP', name: 'Madhya Pradesh', verifiedOn: '2026-09-01', note: 'Annual slabs (₹2.25L / ₹3L / ₹4L) shown as monthly gross; the March amount makes the year up.',
    slabs: [{ from: 0, to: 18_750, amount: 0 }, { from: 18_750, to: 25_000, amount: 125 }, { from: 25_000, to: 33_334, amount: 166 }, { from: 25_000, to: 33_334, amount: 174, month: 3 }, { from: 33_334, to: null, amount: 208 }, { from: 33_334, to: null, amount: 212, month: 3 }] },
  { code: 'OD', name: 'Odisha', verifiedOn: '2026-09-01', note: '₹300 in December makes the year up to ₹2,500.',
    slabs: [{ from: 0, to: 13_334, amount: 0 }, { from: 13_334, to: 25_000, amount: 125 }, { from: 25_000, to: null, amount: 200 }, { from: 25_000, to: null, amount: 300, month: 12 }] },
  { code: 'AS', name: 'Assam', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 10_000, amount: 0 }, { from: 10_000, to: 15_000, amount: 150 }, { from: 15_000, to: 25_000, amount: 180 }, { from: 25_000, to: null, amount: 208 }] },
  { code: 'BR', name: 'Bihar', verifiedOn: '2026-09-01', note: 'Annual slabs (₹3L / ₹5L / ₹10L) shown as monthly gross and monthly amounts.',
    slabs: [{ from: 0, to: 25_000, amount: 0 }, { from: 25_000, to: 41_667, amount: 83 }, { from: 41_667, to: 83_334, amount: 167 }, { from: 83_334, to: null, amount: 208 }] },
  { code: 'JH', name: 'Jharkhand', verifiedOn: '2026-09-01', note: 'Annual slabs shown as monthly gross and monthly amounts.',
    slabs: [{ from: 0, to: 25_000, amount: 0 }, { from: 25_000, to: 41_667, amount: 100 }, { from: 41_667, to: 66_667, amount: 150 }, { from: 66_667, to: 83_334, amount: 175 }, { from: 83_334, to: null, amount: 208 }] },
  { code: 'PB', name: 'Punjab', verifiedOn: '2026-09-01', note: 'Punjab State Development Tax: ₹200 a month above ₹2.5L a year.',
    slabs: [{ from: 0, to: 20_834, amount: 0 }, { from: 20_834, to: null, amount: 200 }] },
  { code: 'CG', name: 'Chhattisgarh', verifiedOn: '2026-09-01', note: 'Annual slabs shown as monthly gross and monthly amounts.',
    slabs: [{ from: 0, to: 8_334, amount: 0 }, { from: 8_334, to: 12_500, amount: 130 }, { from: 12_500, to: 16_667, amount: 150 }, { from: 16_667, to: 20_834, amount: 200 }, { from: 20_834, to: null, amount: 208 }] },
  { code: 'ML', name: 'Meghalaya', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 4_167, amount: 0 }, { from: 4_167, to: 6_250, amount: 16 }, { from: 6_250, to: 8_334, amount: 25 }, { from: 8_334, to: 12_500, amount: 41 }, { from: 12_500, to: 16_667, amount: 62 }, { from: 16_667, to: 20_834, amount: 83 }, { from: 20_834, to: 25_000, amount: 104 }, { from: 25_000, to: 29_167, amount: 125 }, { from: 29_167, to: 33_334, amount: 150 }, { from: 33_334, to: 37_500, amount: 175 }, { from: 37_500, to: 41_667, amount: 200 }, { from: 41_667, to: null, amount: 208 }] },
  { code: 'TR', name: 'Tripura', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 7_500, amount: 0 }, { from: 7_500, to: 15_000, amount: 150 }, { from: 15_000, to: null, amount: 208 }] },
  { code: 'MN', name: 'Manipur', verifiedOn: '2026-09-01', note: 'Annual slabs shown as monthly gross and monthly amounts.',
    slabs: [{ from: 0, to: 4_167, amount: 0 }, { from: 4_167, to: 6_250, amount: 100 }, { from: 6_250, to: 8_334, amount: 167 }, { from: 8_334, to: 10_000, amount: 200 }, { from: 10_000, to: null, amount: 208 }] },
  { code: 'MZ', name: 'Mizoram', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 5_000, amount: 0 }, { from: 5_000, to: 8_000, amount: 75 }, { from: 8_000, to: 10_000, amount: 120 }, { from: 10_000, to: 12_000, amount: 150 }, { from: 12_000, to: 15_000, amount: 180 }, { from: 15_000, to: null, amount: 208 }] },
  { code: 'NL', name: 'Nagaland', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 4_000, amount: 0 }, { from: 4_000, to: 5_000, amount: 35 }, { from: 5_000, to: 7_000, amount: 75 }, { from: 7_000, to: 9_000, amount: 110 }, { from: 9_000, to: 12_000, amount: 180 }, { from: 12_000, to: null, amount: 208 }] },
  { code: 'SK', name: 'Sikkim', verifiedOn: '2026-09-01',
    slabs: [{ from: 0, to: 20_000, amount: 0 }, { from: 20_000, to: 30_000, amount: 125 }, { from: 30_000, to: 40_000, amount: 150 }, { from: 40_000, to: null, amount: 200 }] },
  { code: 'PY', name: 'Puducherry', verifiedOn: '2026-09-01', note: 'Half-yearly slabs shown as monthly equivalents.',
    slabs: [{ from: 0, to: 16_667, amount: 0 }, { from: 16_667, to: 33_334, amount: 42 }, { from: 33_334, to: 50_000, amount: 84 }, { from: 50_000, to: 66_667, amount: 126 }, { from: 66_667, to: 83_334, amount: 168 }, { from: 83_334, to: null, amount: 208 }] },
]

/** States and territories with NO professional tax. Listed so "no slabs" is a decision, not an omission. */
export const PT_EXEMPT_STATES: readonly { code: string; name: string }[] = [
  { code: 'DL', name: 'Delhi' }, { code: 'UP', name: 'Uttar Pradesh' }, { code: 'HR', name: 'Haryana' },
  { code: 'RJ', name: 'Rajasthan' }, { code: 'UK', name: 'Uttarakhand' }, { code: 'HP', name: 'Himachal Pradesh' },
  { code: 'GA', name: 'Goa' }, { code: 'JK', name: 'Jammu & Kashmir' }, { code: 'LA', name: 'Ladakh' },
  { code: 'AR', name: 'Arunachal Pradesh' }, { code: 'CH', name: 'Chandigarh' }, { code: 'AN', name: 'Andaman & Nicobar' },
  { code: 'DN', name: 'Dadra & Nagar Haveli and Daman & Diu' }, { code: 'LD', name: 'Lakshadweep' },
]
