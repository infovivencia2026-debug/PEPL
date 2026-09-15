/**
 * Loads the professional-tax reference data into pt_slabs.
 *
 *   npm run seed:statutory                 # effective from the 1st of this fiscal year
 *   npm run seed:statutory -- 2027-04-01   # a specific effective date
 *
 * Idempotent per (state, effective date): a state's rows for that date are
 * replaced, earlier dates are left as history, and states in the exempt list
 * are left with no rows. Safe to re-run after correcting db/reference/pt-slabs.ts.
 */
import { pathToFileURL } from 'node:url'
import { controlDb } from '../src/control-plane/index.ts'
import { PT_EXEMPT_STATES, PT_STATES } from '../db/reference/pt-slabs.ts'

export async function seedPtSlabs(effectiveFrom: string): Promise<{ states: number; slabs: number }> {
  let slabs = 0
  for (const st of PT_STATES) {
    await controlDb.query(`DELETE FROM pt_slabs WHERE state_code = $1 AND effective_from = $2::date`, [st.code, effectiveFrom])
    // Close any earlier open-ended rows the day before the new set starts.
    await controlDb.query(
      `UPDATE pt_slabs SET effective_to = $2::date - 1 WHERE state_code = $1 AND effective_from < $2::date AND effective_to IS NULL`,
      [st.code, effectiveFrom])
    for (const s of st.slabs) {
      await controlDb.query(
        `INSERT INTO pt_slabs (state_code, effective_from, gross_from_paise, gross_to_paise, amount_paise, month_override)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [st.code, effectiveFrom, String(s.from * 100), s.to === null ? null : String(s.to * 100), String(s.amount * 100), s.month ?? null])
      slabs++
    }
  }
  return { states: PT_STATES.length, slabs }
}

function fiscalYearStart(d = new Date()): string {
  const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1
  return `${y}-04-01`
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const effectiveFrom = process.argv[2] ?? fiscalYearStart()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) {
    console.error('usage: npm run seed:statutory [-- YYYY-MM-DD]')
    process.exit(2)
  }
  const r = await seedPtSlabs(effectiveFrom)
  console.log(`pt_slabs: ${r.states} states, ${r.slabs} slabs effective ${effectiveFrom}; ${PT_EXEMPT_STATES.length} states/UTs levy no PT`)
  console.log('REFERENCE DATA — reconcile each state against its current notification before paying anyone there.')
  await controlDb.end()
}
