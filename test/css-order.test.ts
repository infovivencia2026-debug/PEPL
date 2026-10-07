/**
 * styles.css is an ordered list: later files deliberately override earlier ones, so the order is load-bearing
 * (CLAUDE.md, "Web layout"). This pins what can be checked mechanically: every file is imported exactly once,
 * nothing imported is missing, tokens come first, and the files that exist to have the last word stay last.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'

const sheet = readFileSync('web/src/styles.css', 'utf8')
const imports = [...sheet.matchAll(/@import\s+'\.\/styles\/([a-z0-9-]+\.css)'/g)].map((m) => m[1]!)
const onDisk = readdirSync('web/src/styles').filter((f) => f.endsWith('.css'))

describe('styles.css', () => {
  it('imports every stylesheet exactly once, and nothing that does not exist', () => {
    expect([...imports].sort()).toEqual([...onDisk].sort())
    expect(new Set(imports).size).toBe(imports.length)
  })
  it('loads the design tokens first', () => {
    expect(imports[0]).toBe('tokens.css')
  })
  it('keeps the files that must win at the end, in order', () => {
    // refinements.css and reference.css set values later files (viewport, composition) tune; the shared page
    // title is applied after all of them so no screen-specific heading rule can drift from it again.
    expect(imports.indexOf('refinements.css')).toBeLessThan(imports.indexOf('viewport.css'))
    expect(imports.indexOf('viewport.css')).toBeLessThan(imports.indexOf('composition.css'))
    expect(imports.indexOf('accessibility.css')).toBeLessThan(imports.indexOf('page-title.css'))
    expect(imports.indexOf('page-title.css')).toBeLessThan(imports.indexOf('password-field.css'))
    expect(imports.at(-1)).toBe('password-field.css')
  })
  it('has nothing but @import rules after the comment (an @import after a rule is ignored by browsers)', () => {
    const body = sheet.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.trim()).filter(Boolean)
    for (const line of body) expect(line, line).toMatch(/^@import\s+'\.\/styles\/[a-z0-9-]+\.css';$/)
  })
})
