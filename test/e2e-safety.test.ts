/**
 * Automated browser scripts must not change production data by default.
 * console and workflow create companies and move payroll; four scripts defaulted to pepl.onrol.in.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { e2eBase, LOCAL_BASE } from '../scripts/e2e-common.ts'

describe('e2eBase', () => {
  it('defaults to the local server', () => {
    expect(e2eBase('X', { mutates: true }, {})).toBe(LOCAL_BASE)
    expect(e2eBase('X', { mutates: false }, {})).toBe(LOCAL_BASE)
  })
  it('a mutating script refuses production and any remote host by default', () => {
    for (const url of ['https://pepl.onrol.in', 'https://staging.example.com', 'http://203.0.113.9:3100']) {
      expect(() => e2eBase('X', { mutates: true }, { X: url }), url).toThrow(/Refusing/)
    }
  })
  it('...unless the override is set deliberately', () => {
    expect(e2eBase('X', { mutates: true }, { X: 'https://staging.example.com', E2E_ALLOW_REMOTE: 'yes' })).toBe('https://staging.example.com')
    expect(() => e2eBase('X', { mutates: true }, { X: 'https://staging.example.com', E2E_ALLOW_REMOTE: 'true' })).toThrow()
  })
  it('loopback is always fine', () => {
    expect(e2eBase('X', { mutates: true }, { X: 'http://localhost:4010/' })).toBe('http://localhost:4010')
  })
  it('a read-only script may be pointed at a remote host explicitly', () => {
    expect(e2eBase('X', { mutates: false }, { X: 'https://pepl.onrol.in' })).toBe('https://pepl.onrol.in')
  })
})

describe('the scripts themselves', () => {
  const scripts = readdirSync('scripts').filter((f) => /^(e2e-|shoot|responsive)/.test(f) && f.endsWith('.ts') && f !== 'e2e-common.ts')
  it('none defaults to production', () => {
    for (const f of scripts) expect(readFileSync(`scripts/${f}`, 'utf8'), f).not.toMatch(/\?\?\s*['"]https:\/\/pepl\.onrol\.in/)
  })
  it('none signs in with a bare type= selector', () => {
    for (const f of scripts) {
      expect(readFileSync(`scripts/${f}`, 'utf8'), f).not.toMatch(/page\.(fill|click)\(\s*'(input\[type="(email|password)"\]|button\[type="submit"\])/)
    }
  })
});
