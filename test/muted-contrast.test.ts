/**
 * The secondary-text colour must stay readable (WCAG AA, 4.5:1) on the surfaces it lands on.
 * reference.css overrode --muted with #7b8c98 (~3.3:1), contradicting the documented 5.32:1, so
 * most secondary text failed AA. Found by an audit (UI2-03).
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!
}
const ratio = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}
const css = readdirSync('web/src/styles').filter((f) => f.endsWith('.css')).map((f) => [f, readFileSync(`web/src/styles/${f}`, 'utf8')] as const)

describe('--muted', () => {
  it('is defined in exactly one place', () => {
    const defs = css.filter(([, s]) => /--muted\s*:/.test(s)).map(([f]) => f)
    expect(defs).toEqual(['tokens.css'])
  })
  it('meets 4.5:1 on white and on the page background', () => {
    const tokens = css.find(([f]) => f === 'tokens.css')![1]
    const muted = /--muted\s*:\s*(#[0-9a-f]{6})/i.exec(tokens)![1]!
    expect(ratio(muted, '#ffffff')).toBeGreaterThanOrEqual(4.5)
    expect(ratio(muted, '#eef4f4')).toBeGreaterThanOrEqual(4.5)
  })
})
