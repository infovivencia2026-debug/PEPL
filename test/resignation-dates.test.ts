/**
 * A resignation's business dates belong to the COMPANY's calendar, not the database server's UTC clock.
 *
 * `submitResignation` compared the requested last day with `CURRENT_DATE` (UTC on the server) and let the
 * column default stamp `submitted_on` with it too. For the 5.5 hours after midnight in India the UTC date is
 * still yesterday, so a last day that was already past in the company's calendar was accepted, and the
 * resignation was recorded as submitted a day early (and notice counted from it). The company's date is now
 * passed in -- and the tests choose it, so none of them depends on what day it happens to run.
 *
 * Only the BUSINESS dates change. Timestamps (decided_at, created_at ...) stay UTC instants.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { submitResignation } from '../src/people/exit-workflow.ts'
import { today as companyToday } from '../src/lib/timezone.ts'

let A: Tenant
beforeAll(async () => { A = (await resetAndSeed()).a })
afterAll(async () => { await closePools(); await controlPool.end() })

const submit = (today: string, requestedLastDay: string) => withTenant(A.id, (tx) =>
  submitResignation(tx, { employeeId: A.employeeId, requestedLastDay, reason: 'Relocating', today }))
const reset = () => controlPool.query(`DELETE FROM resignations WHERE tenant_id = $1`, [A.id])

describe('the company date decides what is "in the past"', () => {
  it('records submitted_on as the company date given, not the server\'s', async () => {
    await reset()
    // A date far from any real "today": if the server's clock leaked in, this would differ.
    const r = await submit('2031-03-10', '2031-04-30')
    expect(r.submitted_on).toBe('2031-03-10')
  })

  it('refuses a last day before the company\'s today', async () => {
    await reset()
    await expect(submit('2031-03-10', '2031-03-09')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
  })

  it('accepts a last day equal to the company\'s today', async () => {
    await reset()
    expect((await submit('2031-03-10', '2031-03-10')).requested_last_day).toBe('2031-03-10')
  })

  it('does not depend on the real date: the same call gives the same answer in any year', async () => {
    for (const [today, last, ok] of [['2020-01-15', '2020-01-14', false], ['2020-01-15', '2020-01-16', true], ['2040-12-31', '2040-12-30', false], ['2040-12-31', '2041-01-01', true]] as const) {
      await reset()
      if (ok) expect((await submit(today, last)).requested_last_day).toBe(last)
      else await expect(submit(today, last), `${today} / ${last}`).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
    }
  })
})

describe('the early hours in India', () => {
  // 02:30 IST on 4 Oct is 21:00 UTC on 3 Oct. UTC says 3 Oct; the company says 4 Oct.
  const instant = new Date('2026-10-03T21:00:00Z')

  it('companyToday() gives the company\'s date, which UTC would get wrong', () => {
    expect(instant.toISOString().slice(0, 10)).toBe('2026-10-03')
    expect(companyToday('Asia/Kolkata', instant)).toBe('2026-10-04')
  })

  it('so a last day of 3 Oct is already past at that moment, and 4 Oct is not', async () => {
    const today = companyToday('Asia/Kolkata', instant)
    await reset()
    await expect(submit(today, '2026-10-03')).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })   // accepted under UTC
    await reset()
    expect((await submit(today, '2026-10-04')).submitted_on).toBe('2026-10-04')                      // stamped 3 Oct under UTC
  })
})

describe('when no date is passed', () => {
  it('uses the company\'s calendar (Asia/Kolkata by default), not the server\'s', async () => {
    await reset()
    const r = await withTenant(A.id, (tx) => submitResignation(tx, { employeeId: A.employeeId, requestedLastDay: '2099-01-01', reason: 'x' }))
    expect(r.submitted_on).toBe(companyToday('Asia/Kolkata'))
  })
})
