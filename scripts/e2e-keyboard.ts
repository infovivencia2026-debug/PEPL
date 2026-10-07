/// <reference lib="dom" />
/**
 * Keyboard-only operation, in a real browser. No mouse event is sent after the page loads.
 *
 *   1. the sign-in form works from the keyboard: Tab reaches email, password, then the submit; Enter submits;
 *   2. the primary navigation is reachable with Tab and a link is activated with Enter;
 *   3. a dialog opens from the keyboard, focus moves INTO it, Tab does not escape it, Escape closes it and focus
 *      goes back to the control that opened it;
 *   4. a linked dashboard tile is reachable, shows a ring that is not clipped, and Enter follows it.
 *
 *   KEYBOARD_BASE=http://127.0.0.1:3100 npm run e2e:keyboard      (read-only: it opens things, saves nothing)
 */
import { chromium, type Page } from 'playwright-core'
import { e2eBase } from './e2e-common.ts'

const BASE = e2eBase('KEYBOARD_BASE', { mutates: false })
const EMAIL = process.env.E2E_TENANT_EMAIL ?? 'admin@acme.test'
const PASSWORD = process.env.E2E_TENANT_PASSWORD ?? 'demo-password-2026'

let failed = false
const check = (ok: boolean, what: string, extra = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? `  — ${extra}` : ''}`)
  if (!ok) failed = true
}

const active = (page: Page): Promise<string> => page.evaluate(() => {
  const a = document.activeElement as HTMLElement | null
  if (!a || a === document.body) return 'body'
  return `${a.tagName.toLowerCase()}${a.getAttribute('type') ? `[${a.getAttribute('type')}]` : ''}|${(a.getAttribute('aria-label') ?? a.textContent ?? '').trim().slice(0, 40)}`
})

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[type="email"], input[name="email"], input[autocomplete="username"]', { timeout: 15000 })

  // 1. sign-in from the keyboard
  await page.locator('input[type="email"], input[name="email"], input[autocomplete="username"]').first().focus()
  await page.keyboard.type(EMAIL)
  await page.keyboard.press('Tab')
  check((await active(page)).startsWith('input'), 'Tab from the email box lands in the password box', await active(page))
  await page.keyboard.type(PASSWORD)
  await page.keyboard.press('Tab')
  const afterPassword = await active(page)
  check(/button/.test(afterPassword), 'Tab from the password box reaches a button (the show/hide toggle or submit)', afterPassword)
  // Walk to the submit control, then press Enter on it.
  for (let i = 0; i < 4 && !(await active(page)).startsWith('button[submit]'); i++) await page.keyboard.press('Tab')
  check((await active(page)).startsWith('button[submit]'), 'Tab reaches the submit button', await active(page))
  await page.keyboard.press('Enter')
  await page.waitForTimeout(3000)
  check(!(await page.locator('input[type=password]').count()), 'Enter on the submit button signs in')

  // 2. navigation by keyboard
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  let reachedNav = false
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press('Tab')
    if (/^a\|People/i.test(await active(page))) { reachedNav = true; break }
  }
  check(reachedNav, 'the People navigation link is reachable with Tab')
  if (reachedNav) {
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    check(/#\/people/.test(page.url()), 'Enter on a navigation link navigates', page.url().replace(BASE, ''))
  }

  // 3. a dialog: open, focus inside, Tab trapped, Escape closes, focus returns
  await page.goto(`${BASE}/#/people`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  const opener = page.getByRole('button', { name: /add employee/i }).first()
  if (await opener.count()) {
    await opener.focus()
    const openerLabel = await active(page)
    await page.keyboard.press('Enter')
    await page.waitForTimeout(800)
    const dialog = page.locator('[role="dialog"], dialog[open], .modal, .drawer').first()
    check(await dialog.count() > 0, 'Enter on "Add employee" opens a dialog')
    if (await dialog.count()) {
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"], dialog, .modal, .drawer'))
      check(inside, 'focus moves into the dialog when it opens')
      let escaped = false
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab')
        // Focus on <body> is the browser's own chrome (the address bar), which a native modal dialog allows.
        // Escaping means landing on an ELEMENT of the page behind the dialog.
        if (await page.evaluate(() => {
          const a = document.activeElement
          return !!a && a !== document.body && !a.closest('[role="dialog"], dialog, .modal, .drawer')
        })) { escaped = true; break }
      }
      check(!escaped, 'Tab stays inside the dialog (it does not wander onto the page behind)')
      await page.keyboard.press('Escape')
      await page.waitForTimeout(600)
      check(await dialog.count() === 0 || !(await dialog.isVisible()), 'Escape closes the dialog')
      check((await active(page)) === openerLabel, 'focus returns to the control that opened it', `${await active(page)} vs ${openerLabel}`)
    }
  } else {
    check(false, 'the People screen has an "Add employee" button to open')
  }

  // 4. a linked dashboard tile
  await page.goto(`${BASE}/#/dashboard`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const tile = page.locator('.widget-content .card-linked .card-target, .stat .card-target').first()
  if (await tile.count()) {
    await tile.focus()
    const ring = await tile.evaluate((el) => {
      const wrap = el.closest('.card-linked, .stat') as HTMLElement
      const s = getComputedStyle(wrap)
      return { style: s.outlineStyle, width: s.outlineWidth, offset: s.outlineOffset, inWidget: !!el.closest('.widget-content') }
    })
    check(ring.style !== 'none' && parseFloat(ring.width) > 0, 'a focused dashboard tile shows a ring on its wrapper', JSON.stringify(ring))
    if (ring.inWidget) check(parseFloat(ring.offset) < 0, 'inside a widget the ring is drawn inward so it is not clipped', ring.offset)
    const before = page.url()
    await page.keyboard.press('Enter')
    await page.waitForTimeout(1200)
    check(page.url() !== before, 'Enter on the tile follows it', page.url().replace(BASE, ''))
  } else {
    check(false, 'the dashboard has a linked tile to focus')
  }

  await browser.close()
  console.log(failed ? '\nFAILED' : '\nall checks passed')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
