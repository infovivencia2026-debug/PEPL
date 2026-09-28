/**
 * No credential is generated from a predictable source.
 *
 * Three places minted passwords with Math.random(): the operator account (which
 * reaches every customer's payroll), and BOTH ways of creating a company -- the
 * console route and the CLI -- each handing a new customer's administrator
 * their first password.
 *
 * Math.random() is not a CSPRNG. Its state is recoverable from a handful of
 * outputs, so an attacker who sees one generated password can predict the next
 * customer's. It is a one-line mistake that reads as harmless.
 *
 * Source-level because the failure is WHICH GENERATOR was called; an output
 * test would pass happily on a predictable stream.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const CREDENTIAL_SOURCES = [
  'src/http/routes/platform.ts',
  'scripts/ops.ts',
  'src/auth/index.ts',
  'src/control-plane/platform-auth.ts',
  'src/control-plane/billing.ts',
]

describe('credentials come from the CSPRNG', () => {
  for (const file of CREDENTIAL_SOURCES) {
    it(`${file} does not build a password or token from Math.random()`, () => {
      const source = readFileSync(file, 'utf8')
      const offending = source
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => line.includes('Math.random'))
        .filter(([, line]) => /password|token|secret|key/i.test(line))
      expect(offending.map(([n, l]) => `${file}:${n} ${l.trim()}`)).toEqual([])
    })
  }
})
