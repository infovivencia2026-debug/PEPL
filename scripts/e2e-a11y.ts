/// <reference lib="dom" />
/**
 * Two accessibility properties, measured in a real browser on every screen for several roles:
 *   1. each screen has exactly one visible <h1> (a page heading assistive technology can land on);
 *   2. every element the keyboard reaches shows a visible focus indicator (outline or ring).
 *
 *   A11Y_BASE=http://127.0.0.1:3100 npm run e2e:a11y          (read-only: it only looks)
 */
import { chromium } from 'playwright-core'
import { e2eBase, signIn } from './e2e-common.ts'

const BASE = e2eBase('A11Y_BASE', { mutates: false })
const PASSWORD = 'demo-password-2026'
const USERS = ['admin@acme.test', 'priya@acme.test', 'arjun@acme.test', 'rahul@acme.test']
const SCREENS = ['dashboard', 'people', 'attendance', 'leave', 'payroll', 'approvals', 'tasks', 'engage', 'growth', 'performance',
  'hiring', 'organisation', 'company', 'import', 'bank-files', 'my-tax', 'tax-declarations', 'documents', 'chat', 'mail',
  'notification-settings', 'account', 'reports', 'activity', 'settings']
const TABS = Number(process.env.A11Y_TABS ?? 25)

interface Finding { who: string; screen: string; kind: 'heading' | 'focus'; detail: string }
const findings: Finding[] = []

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const email of USERS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(600)
    await signIn(page, email, PASSWORD)
    await page.waitForTimeout(2500)
    for (const screen of SCREENS) {
      await page.goto(`${BASE}/#/${screen}`, { waitUntil: 'domcontentloaded' })
      // Screens load lazily: wait for a heading to appear rather than judging a loading skeleton.
      await page.waitForSelector('h1,[aria-level="1"]', { state: 'visible', timeout: 4000 }).catch(() => undefined)
      await page.waitForTimeout(400)
      // Skip screens the role is not entitled to (the app shows its own message there).
      const body = (await page.textContent('body')) ?? ''
      if (/don.t have access|not available|no access/i.test(body) && !(await page.locator('h1').count())) continue

      const h1 = await page.evaluate(() => Array.from(document.querySelectorAll('h1,[role="heading"][aria-level="1"],h2[aria-level="1"],h3[aria-level="1"]')).filter((h) => {
        const r = h.getBoundingClientRect(); const s = getComputedStyle(h)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }).map((h) => (h.textContent ?? '').trim().slice(0, 40)))
      if (h1.length !== 1) findings.push({ who: email, screen, kind: 'heading', detail: h1.length === 0 ? 'no visible h1' : `${h1.length} visible h1: ${h1.join(' | ')}` })

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      await page.mouse.click(2, 2).catch(() => undefined)
      const seen = new Set<string>()
      for (let i = 0; i < TABS; i++) {
        await page.keyboard.press('Tab')
        const probe = () => page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          if (!el || el === document.body) return null
          // A native control's built-in part (the calendar button inside a date input) is focused while the HOST
          // reports :focus-visible false; the browser draws that ring itself, so there is nothing of ours to judge.
          if (!el.matches(':focus-visible')) return null
          const s = getComputedStyle(el)
          const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 && s.outlineColor !== 'rgba(0, 0, 0, 0)'
          const ring = s.boxShadow !== 'none' && /\d+px/.test(s.boxShadow)
          // a focus style on a wrapper, e.g. :focus-within on the label that holds the input
          const wrapper = el.closest('label,.field,.password-field,.search,.search-box,.money-input,.mail-search,.card-linked,.stat,[role="search"]')
          const cardRing = !!el.closest('.card-linked') && !!wrapper && getComputedStyle(wrapper).outlineStyle !== 'none'
          const w = wrapper ? getComputedStyle(wrapper) : null
          const wrapped = !!w && ((w.outlineStyle !== 'none' && parseFloat(w.outlineWidth) > 0) || (w.boxShadow !== 'none' && /\d+px/.test(w.boxShadow)))
          const label = `${el.tagName.toLowerCase()}${el.className ? '.' + String(el.className).split(/\s+/)[0] : ''}[${(el.getAttribute('aria-label') || el.textContent?.trim() || el.getAttribute('name') || el.getAttribute('placeholder') || el.getAttribute('type') || '').trim().slice(0, 28)}]${el.parentElement?.className ? ' in .' + String(el.parentElement.className).split(/\s+/)[0] : ''}`
          return { ok: outline || ring || wrapped || cardRing, label }
        })
        let r = await probe()
        // The app animates outline/box-shadow (~180ms): a failure read in the first instant is re-read once settled.
        if (r && !r.ok) { await page.waitForTimeout(350); r = await probe() }
        if (r && !r.ok && !seen.has(r.label)) { seen.add(r.label); findings.push({ who: email, screen, kind: 'focus', detail: r.label }) }
      }
    }
    await ctx.close()
  }
  await browser.close()

  const byKey = new Map<string, Finding[]>()
  for (const f of findings) byKey.set(`${f.kind}  ${f.kind === 'heading' ? f.screen + ' → ' + f.detail : f.detail}`, [...(byKey.get(`${f.kind}  ${f.kind === 'heading' ? f.screen + ' → ' + f.detail : f.detail}`) ?? []), f])
  for (const [k, list] of byKey) console.log(`${k}   x${list.length} (${[...new Set(list.map((f) => f.screen))].slice(0, 4).join(', ')})`)
  console.log(findings.length ? `\n${byKey.size} distinct finding(s), ${findings.length} total` : 'clean: one h1 per screen, a visible focus indicator on everything reached')
  if (findings.length) process.exit(1)
}
main().catch((e) => { console.error(e); process.exit(1) })
