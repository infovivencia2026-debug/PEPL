/**
 * Every password box has a show/hide toggle.
 *
 * Reported as "hide/show password not implemented". There were four password
 * fields -- sign in, choose a new password, change password, and an external
 * mailbox -- and none had a toggle. People mistype a password they cannot see,
 * and on a phone a wrong one costs a lockout attempt.
 *
 * All four now go through PasswordInput in ui.tsx. This fails if a raw
 * type="password" input appears anywhere else in web/src, because the next form
 * to be written would otherwise quietly reintroduce the gap.
 *
 * Read as text: the component needs a browser to exercise, and scripts/e2e-login.ts
 * clicks the real toggle. This pins the rule that every field uses it.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : path.endsWith('.tsx') ? [path] : []
  })

const files = walk('web/src')

describe('password fields', () => {
  it('none is a raw type="password" input', () => {
    const raw = files.filter((f) => /type=["']password["']/.test(readFileSync(f, 'utf8')))
    expect(raw, 'use <PasswordInput> from ./ui so the show/hide toggle comes with it').toEqual([])
  })

  it('the app has at least the four fields it had when the toggle was added', () => {
    const uses = files.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/<PasswordInput\b/g)?.length ?? 0), 0)
    // Sign in, choose a new password, change password (x2), external mailbox.
    expect(uses).toBeGreaterThanOrEqual(5)
  })

  it('every use names itself, so the toggle button is not folded into the label', () => {
    // The button sits inside the caller's <label>. With no aria-label the input
    // is announced as "Password Show password".
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const match of source.matchAll(/<PasswordInput\b/g)) {
        const tag = source.slice(match.index, match.index + 500)
        expect(tag, `${file}`).toContain('aria-label=')
      }
    }
  })
})

describe('the component itself', () => {
  const source = readFileSync('web/src/ui.tsx', 'utf8')
  const start = source.indexOf('export function PasswordInput')
  const body = source.slice(start)

  it('hides the password by default', () => {
    expect(body).toContain('useState(false)')
    expect(body).toContain("shown ? 'text' : 'password'")
  })

  it('is a real button, so it does not submit the form', () => {
    expect(body).toContain('type="button"')
  })

  it('tells assistive tech what it does and what state it is in', () => {
    expect(body).toContain("'Hide password' : 'Show password'")
    expect(body).toContain('aria-pressed={shown}')
    expect(body).toContain('aria-hidden="true"')   // the icon is decoration
  })

  it('turns off the keyboard "help" that would rewrite a revealed password', () => {
    for (const attr of ['autoCapitalize="off"', 'autoCorrect="off"', 'spellCheck={false}']) {
      expect(body, attr).toContain(attr)
    }
  })
})

describe('the stylesheet', () => {
  it('is imported after everything that could override it, without reordering the cascade', () => {
    const entry = readFileSync('web/src/styles.css', 'utf8').trim().split('\n').filter((l) => l.startsWith('@import'))
    const names = entry.map((l) => /styles\/([a-z0-9-]+\.css)/.exec(l)![1]!)
    const after = names.slice(names.indexOf('password-field.css') + 1)
    // It used to be literally last. Two small sheets that style OTHER things now follow it (the shared page
    // title, and focus rings on tiles and wrappers); what matters is that nothing after it can override it.
    expect(names.includes('password-field.css')).toBe(true)
    expect(after.every((f) => ['focus.css', 'page-title.css'].includes(f)), after.join(', ')).toBe(true)
    for (const f of after) expect(readFileSync(`web/src/styles/${f}`, 'utf8'), f).not.toMatch(/password|\.field\b/)
  })

  it('keeps the field look the login box relies on', () => {
    // `.field > input` is a CHILD selector; the wrapper puts the input a level
    // deeper, so its rules have to be repeated for the nested case.
    const css = readFileSync('web/src/styles/password-field.css', 'utf8')
    expect(css).toContain('.field > .password-field > input')
  })

  it('makes the toggle at least 44px wide', () => {
    const css = readFileSync('web/src/styles/password-field.css', 'utf8')
    const width = Number(/\.password-toggle\s*{[^}]*?width:\s*(\d+)px/s.exec(css)?.[1] ?? 0)
    expect(width).toBeGreaterThanOrEqual(44)
  })
})
