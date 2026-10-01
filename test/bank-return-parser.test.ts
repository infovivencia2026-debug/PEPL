/**
 * A bank return must never mark someone PAID on the strength of silence.
 * The parser called every row that did not look like a failure "settled": blank, "pending",
 * "processing", or a file with no status column at all. Found by an audit (UI2-01).
 */
import { describe, it, expect } from 'vitest'
import { parseReturnDetailed } from '../web/src/pay/parseReturn.ts'

const csv = (...rows: string[]) => ['Reference,Account,Amount,Status,UTR,Reason', ...rows].join('\n')

describe('bank return parsing', () => {
  it('settles only on a success word', () => {
    const r = parseReturnDetailed(csv('R1,111,100.00,SUCCESS,U1,', 'R2,222,50,Credited,U2,', 'R3,333,70,Processed,U3,'))
    expect(r.lines.map((l) => l.status)).toEqual(['settled', 'settled', 'settled'])
  })

  it('does NOT settle blank, pending, processing or unknown statuses', () => {
    const r = parseReturnDetailed(csv('R1,111,100,,U1,', 'R2,222,50,PENDING,,', 'R3,333,70,Processing,,', 'R4,444,10,???,,'))
    expect(r.lines).toEqual([])
    expect(r.unrecognised).toHaveLength(4)
  })

  it('still recognises failures and returns', () => {
    const r = parseReturnDetailed(csv('R1,111,100,FAILED,,Account closed', 'R2,222,50,Returned,,Invalid IFSC', 'R3,333,9,Rejected,,x'))
    expect(r.lines.map((l) => l.status)).toEqual(['failed', 'returned', 'failed'])
    expect(r.lines[0]!.reason).toBe('Account closed')
  })

  it('a file with no status column applies nothing', () => {
    const r = parseReturnDetailed('Reference,Account,Amount\nR1,111,100\nR2,222,50')
    expect(r.noStatusColumn).toBe(true)
    expect(r.lines).toEqual([])
  })
})
