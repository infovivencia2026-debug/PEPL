/**
 * Which faults are allowed to kill the process.
 *
 * This exists because of a real outage in the sibling ONROL deployment: an
 * IMAP socket reset with no listener became an uncaught exception and took
 * attendance and payroll down with it. Mail is auxiliary; a bug in payroll is
 * not. The classifier is the whole of that decision, so it is tested directly.
 */
import { describe, it, expect } from 'vitest'
import { isAuxiliary } from '../src/http/process-guards.ts'

describe('auxiliary faults keep the process serving', () => {
  it('recognises the mail library by its stack', () => {
    expect(isAuxiliary({
      stack: String.raw`Error: socket closed
    at TLSSocket.<anonymous> (E:\app\node_modules\imapflow\lib\imap-flow.js:812:20)`,
    })).toBe(true)
  })

  it('recognises our own mail and realtime modules, on either path style', () => {
    expect(isAuxiliary({ stack: String.raw`Error at src\mail\sync.ts:12:1` })).toBe(true)
    expect(isAuxiliary({ stack: 'Error at src/mail/outbox.ts:44:9' })).toBe(true)
    expect(isAuxiliary({ stack: String.raw`Error at src\realtime\sse.ts:3:1` })).toBe(true)
  })

  it('recognises a transport fault by its code, whatever the stack says', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH']) {
      expect(isAuxiliary({ code })).toBe(true)
    }
  })
})

describe('a real bug still stops the process', () => {
  it('does not excuse payroll, routing or anything else of ours', () => {
    expect(isAuxiliary({ stack: String.raw`TypeError at src\payroll\engine.ts:12:1` })).toBe(false)
    expect(isAuxiliary({ stack: 'TypeError at src/http/routes/people.ts:9:1' })).toBe(false)
    expect(isAuxiliary({ stack: 'Error at src/leave/ledger.ts:80:3' })).toBe(false)
  })

  it('does not excuse an error with nothing to go on', () => {
    expect(isAuxiliary(null)).toBe(false)
    expect(isAuxiliary(undefined)).toBe(false)
    expect(isAuxiliary({})).toBe(false)
    expect(isAuxiliary(new Error('something went wrong'))).toBe(false)
  })

  it('does not match a word that merely contains a code', () => {
    expect(isAuxiliary({ code: 'ECONNRESETX' })).toBe(false)
  })
})
