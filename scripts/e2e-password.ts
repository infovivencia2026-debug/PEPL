/// <reference lib="dom" />
/**
 * The show/hide password toggle, in a real browser.
 *
 * test/password-field.test.ts pins that every password box uses the shared
 * component. This proves the component WORKS: the type flips and flips back, the
 * value survives, the button never submits the form, the keyboard can operate
 * it, the field still looks like its neighbours, and it is big enough to hit.
 *
 * Uses the demo tenant admin for the Account page. Public sign-in page otherwise.
 */
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100'
const EMAIL = process.env.E2E_TENANT_EMAIL ?? 'admin@acme.test'
const PASSWORD = process.env.E2E_TENANT_PASSWORD ?? 'demo-password-2026'
const OUT = 'docs/ui-checks'

const fails: string[] = []
const check = (ok: boolean, what: string, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  — ' + extra : ''}`)
  if (!ok) fails.push(what)
}

const typeOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => (el as HTMLInputElement).type)

const style = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate((el) => {
    const s = getComputedStyle(el)
    return { font: s.fontSize, border: s.borderTopColor, height: Math.round(el.getBoundingClientRect().height), radius: s.borderTopLeftRadius, bg: s.backgroundColor }
  })

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  const errors: string[] = []
  const posts: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))
  page.on('request', (r) => { if (r.method() === 'POST') posts.push(r.url()) })

  // ── the sign-in page ───────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="password"]')
  const box = 'input[name="password"]'
  const toggle = 'button.password-toggle'

  check((await typeOf(page, box)) === 'password', 'the password starts hidden')
  check((await page.locator(toggle).count()) === 1, 'there is exactly one toggle on the sign-in page')
  check((await page.locator(toggle).getAttribute('aria-label')) === 'Show password', 'it says what it will do')
  check((await page.locator(toggle).getAttribute('aria-pressed')) === 'false', 'and reports that it is off')

  const target = await page.locator(toggle).boundingBox()
  check(!!target && Math.round(target.width) >= 44 && Math.round(target.height) >= 44, 'it is at least 44 by 44 pixels', target ? `${Math.round(target.width)}x${Math.round(target.height)}` : 'no box')

  // Named for what it is, not "Password Show password".
  const labelled = page.getByLabel('Password', { exact: true })
  check((await labelled.count()) === 1 && (await labelled.evaluate((el) => el.tagName)) === 'INPUT', 'the input is named "Password" on its own, without the button folded in')

  await page.fill(box, 'Sample-Passw0rd!')
  await page.click(toggle)
  check((await typeOf(page, box)) === 'text', 'clicking it reveals the password')
  check((await page.inputValue(box)) === 'Sample-Passw0rd!', 'and keeps what was typed')
  check((await page.locator(toggle).getAttribute('aria-label')) === 'Hide password', 'the label flips to "Hide password"')
  check((await page.locator(toggle).getAttribute('aria-pressed')) === 'true', 'and it reports that it is on')
  await page.screenshot({ path: `${OUT}/password-shown.png`, clip: { x: 0, y: 0, width: 1440, height: 900 } })

  await page.click(toggle)
  check((await typeOf(page, box)) === 'password', 'clicking again hides it')
  check((await page.inputValue(box)) === 'Sample-Passw0rd!', 'still with what was typed')

  // The keyboard: from the password box, Tab lands on the toggle, Space works it.
  await page.focus(box)
  await page.keyboard.press('Tab')
  check(await page.evaluate(() => document.activeElement?.classList.contains('password-toggle') ?? false), 'Tab from the box lands on the toggle')
  await page.keyboard.press('Space')
  check((await typeOf(page, box)) === 'text', 'Space operates it')
  await page.keyboard.press('Enter')
  check((await typeOf(page, box)) === 'password', 'so does Enter')

  // It must never submit the form: no sign-in request, no error box.
  check(!posts.some((u) => u.includes('/auth/login')), 'using the toggle never sent a sign-in request', posts.join(', ') || 'no POSTs')
  check(!/incorrect|required|invalid/i.test((await page.textContent('body')) ?? ''), 'and never raised an error')

  // It has to look like the box above it.
  const email = await style(page, 'input[name="email"]')
  const pw = await style(page, box)
  check(email.font === pw.font && email.border === pw.border && email.height === pw.height && email.radius === pw.radius && email.bg === pw.bg,
    'the password box looks like the email box above it', `email=${JSON.stringify(email)} password=${JSON.stringify(pw)}`)

  // ── a phone ────────────────────────────────────────────────────────────────
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(500)
  const phoneTarget = await page.locator(toggle).boundingBox()
  check(!!phoneTarget && Math.round(phoneTarget.width) >= 44 && Math.round(phoneTarget.height) >= 44, 'still 44 by 44 on a phone')
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  check(overflow <= 2, 'and the page does not scroll sideways', `${overflow}px`)
  await page.screenshot({ path: `${OUT}/password-phone.png` })

  // ── the Account page: two fields that must not share state ────────────────
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.fill('input[name="email"]', EMAIL)
  await page.fill(box, PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3500)
  await page.goto(`${BASE}/#/account`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('input[name="currentPassword"]', { timeout: 15000 })

  check((await page.locator(toggle).count()) >= 2, 'the change-password form has a toggle on both fields', `${await page.locator(toggle).count()} toggles`)
  // A toggle must span its own box. `.lifecycle-form button { align-self:end }` is
  // aimed at that form's submit buttons; it also caught the toggle, shrinking it
  // to 18px and pinning it to the bottom -- a target far under 44px, with the
  // icon sitting low. Measured against the input, because "a toggle exists" and
  // "a toggle you can hit" are different claims.
  // Let the page's entry animation finish, then read BOTH boxes in one synchronous
  // pass. Two separate reads straddled the animation and reported a 1px difference
  // that was the page moving, not the layout.
  await page.waitForTimeout(1200)
  for (const which of ['currentPassword', 'newPassword']) {
    const m = await page.evaluate((name) => {
      const input = document.querySelector(`input[name="${name}"]`) as HTMLElement
      const button = input.parentElement!.querySelector('button.password-toggle') as HTMLElement
      const i = input.getBoundingClientRect(), b = button.getBoundingClientRect()
      return { inputY: i.y, inputH: i.height, buttonY: b.y, buttonH: b.height }
    }, which)
    check(Math.abs(m.buttonY - m.inputY) <= 1 && Math.round(m.buttonH) >= 44 && Math.abs(m.buttonH - m.inputH) <= 2,
      `${which}: the toggle spans the whole box and is at least 44px tall`,
      `input ${m.inputH.toFixed(1)}px at y=${m.inputY.toFixed(1)}, toggle ${m.buttonH.toFixed(1)}px at y=${m.buttonY.toFixed(1)}`)
  }

  const current = 'input[name="currentPassword"]'
  const fresh = 'input[name="newPassword"]'
  await page.locator(toggle).first().click()
  check((await typeOf(page, current)) === 'text' && (await typeOf(page, fresh)) === 'password', 'revealing one leaves the other hidden')
  await page.screenshot({ path: `${OUT}/password-account.png` })

  check(errors.length === 0, 'no browser errors', errors.join(' | '))
  await browser.close()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nthe toggle works')
  process.exit(fails.length ? 1 : 0)
}
main()
