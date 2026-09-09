/// <reference lib="dom" />
/**
 * Screenshot rig.
 *
 * Drives the SYSTEM Chrome via playwright-core (channel: 'chrome') so nothing is
 * downloaded. Logs in through the real UI — the session is an HttpOnly cookie,
 * so there is no way to shortcut it, and shortcutting it would not prove the
 * screens work anyway.
 *
 *   npm run shoot                    # default set
 *   npm run shoot -- widgets         # only the widget-feedback check
 *
 * Every visual fix gets a fresh shot proving it. Output: docs/ui-checks/.
 */
import { mkdir } from 'node:fs/promises'
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.SHOOT_BASE ?? 'http://127.0.0.1:3100'
const EMAIL = process.env.SHOOT_EMAIL ?? 'admin@acme.test'
const PASSWORD = process.env.SHOOT_PASSWORD ?? 'demo-password-2026'
const OUT = 'docs/ui-checks'

const only = process.argv[2]

async function login(page: Page): Promise<void> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  const email = page.locator('input[type="email"], input[name="email"]').first()
  await email.waitFor({ timeout: 15_000 })
  await email.fill(EMAIL)
  await page.locator('input[type="password"], input[name="password"]').first().fill(PASSWORD)
  await page.locator('button[type="submit"]').first().click()
  // The dashboard heading is the signal that the workspace actually loaded.
  await page.getByRole('heading', { name: /at a glance/i }).waitFor({ timeout: 20_000 })
  await page.waitForTimeout(700)
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true })

  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
  })
  const page = await context.newPage()

  try {
    await login(page)

    if (!only || only === 'dashboard') {
      await page.screenshot({ path: `${OUT}/verify-dashboard.png` })
      console.log(`${OUT}/verify-dashboard.png`)
    }

    if (!only || only === 'fit') {
      // A glance surface that needs scrolling is a report. Measure it rather
      // than judging by eye.
      for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768]] as const) {
        await page.setViewportSize({ width: w, height: h })
        await page.waitForTimeout(500)
        const m = await page.evaluate(() => ({
          scroll: document.documentElement.scrollHeight,
          view: window.innerHeight,
        }))
        const overflow = m.scroll - m.view
        console.log(
          `${w}x${h}: content ${m.scroll}px vs viewport ${m.view}px -> ` +
          (overflow <= 2 ? 'FITS' : `${overflow}px over`),
        )
        await page.screenshot({ path: `${OUT}/fit-${w}.png` })
      }
      await page.setViewportSize({ width: 1440, height: 900 })
    }

    if (!only || only === 'widgets') {
      // Proves the transient feedback CLEARS: shoot right after Cancel, then
      // again after the timeout. The second shot must not contain the message.
      await page.getByRole('button', { name: /customize dashboard/i }).click()
      await page.waitForTimeout(400)
      await page.getByRole('button', { name: /^cancel$/i }).click()
      await page.waitForTimeout(300)
      await page.screenshot({ path: `${OUT}/verify-feedback-shown.png` })
      console.log(`${OUT}/verify-feedback-shown.png`)

      await page.waitForTimeout(6500)
      const stillThere = await page.getByText('Changes cancelled.').count()
      await page.screenshot({ path: `${OUT}/verify-feedback-cleared.png` })
      console.log(`${OUT}/verify-feedback-cleared.png  (message present: ${stillThere})`)
      if (stillThere > 0) {
        console.error('FAIL: transient feedback did not clear')
        process.exitCode = 1
      }
    }

    if (!only || only === 'mobile') {
      const mobile = await browser.newContext({
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 2,
        isMobile: true,
        hasTouch: true,
      })
      const mp = await mobile.newPage()
      await login(mp)
      await mp.screenshot({ path: `${OUT}/verify-mobile.png` })
      console.log(`${OUT}/verify-mobile.png`)
      await mobile.close()
    }
  } finally {
    await browser.close()
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
