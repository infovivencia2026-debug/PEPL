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

    // Generic: `npm run shoot -- route <hash-route> [name]` shoots one screen at
    // desktop and phone. SHOOT_EMAIL picks the persona.
    if (only === 'public') {
      const route = process.argv[3] ?? 'signup'
      const fresh = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 }); const fp = await fresh.newPage()
      fp.on('pageerror', (e) => console.error('pageerror:', e.message)); fp.on('console', (m) => { if (m.type() === 'error') console.error('console:', m.text().slice(0, 300)) })
      await fp.goto(`${BASE}/#/${route}`); await fp.waitForTimeout(1500)
      if (process.env.SHOOT_CLICK) { await fp.getByRole('button', { name: new RegExp(process.env.SHOOT_CLICK, 'i') }).first().click(); await fp.waitForTimeout(600) }
      for (const pair of (process.env.SHOOT_FILL ?? '').split(';').filter(Boolean)) { const [label, value] = pair.split('=') as [string, string]; await fp.getByLabel(new RegExp(label, 'i')).first().fill(value) }
      if (process.env.SHOOT_CLICK2) { await fp.getByRole('button', { name: new RegExp(process.env.SHOOT_CLICK2, 'i') }).first().click(); await fp.waitForTimeout(1200) }
      await fp.screenshot({ path: `${OUT}/${process.argv[4] ?? route}.png`, fullPage: true }); console.log(`${OUT}/${process.argv[4] ?? route}.png`)
      await fresh.close(); return
    }

    if (only === 'route') {
      const route = process.argv[3] ?? 'dashboard'
      const name = process.argv[4] ?? route.replace(/[^\w-]+/g, '-')
      await page.goto(`${BASE}/#/${route}`)
      await page.waitForTimeout(1200)
      // SHOOT_SELECT="label=value;label=value" picks options in <select>s (by accessible label) before the shot
      for (const pair of (process.env.SHOOT_SELECT ?? '').split(';').filter(Boolean)) { const [label, value] = pair.split('=') as [string, string]; await page.getByLabel(new RegExp(label, 'i')).first().selectOption({ label: value }).catch(async () => page.getByLabel(new RegExp(label, 'i')).first().selectOption(value)); await page.waitForTimeout(700) }
      // SHOOT_CLICK="Select all" clicks a button by name before the shot (to show a selected state)
      if (process.env.SHOOT_CLICK) { await page.getByRole('button', { name: new RegExp(process.env.SHOOT_CLICK, 'i') }).first().click(); await page.waitForTimeout(500) }
      await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
      console.log(`${OUT}/${name}.png`)
      // SHOOT_EVAL="<js expression>" prints a measurement from the page (layout assertions, not eyeballing)
      if (process.env.SHOOT_EVAL) console.log('eval:', JSON.stringify(await page.evaluate(process.env.SHOOT_EVAL)))
      const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
      const mp = await mobile.newPage()
      await login(mp)
      await mp.goto(`${BASE}/#/${route}`)
      await mp.waitForTimeout(1200)
      await mp.screenshot({ path: `${OUT}/${name}-mobile.png`, fullPage: true })
      console.log(`${OUT}/${name}-mobile.png`)
      await mobile.close()
      return
    }

    // `npm run shoot -- mfa`: enable 2FA for SHOOT_EMAIL through the real UI (setup → code → recovery codes),
    // sign out, sign in again and prove the code gate appears and lets a valid code through. Disables it afterwards.
    if (only === 'mfa') {
      const { totp, stepAt } = await import('../src/auth/mfa.ts')
      const b32decode = (str: string): Buffer => { const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'; let bits = 0, val = 0; const out: number[] = []; for (const ch of str.replace(/=+$/, '')) { val = (val << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xff); bits -= 8 } } return Buffer.from(out) }
      await page.goto(`${BASE}/#/account`); await page.waitForTimeout(1200)
      if (await page.locator('.mfa-pill.on').count()) { console.error('2FA is already on for this account (a previous run died?) — disable it in Account first'); process.exitCode = 1; return }
      await page.getByRole('button', { name: /^set up$/i }).click(); await page.waitForTimeout(1500)
      const secret = (await page.locator('code.secret').textContent())!.trim()
      await page.getByLabel(/six-digit code/i).fill(totp(b32decode(secret), stepAt()))
      await page.getByRole('button', { name: /continue/i }).click(); await page.waitForTimeout(1200)
      await page.screenshot({ path: `${OUT}/mfa-recovery-codes.png` }); console.log(`${OUT}/mfa-recovery-codes.png`)
      const codes = await page.locator('.mfa-codes code').allTextContents()
      if (codes.length !== 8) { console.error(`FAIL: expected 8 recovery codes, saw ${codes.length}`); process.exitCode = 1 }
      await page.getByRole('button', { name: /i have saved them/i }).click(); await page.waitForTimeout(800)
      // sign out, sign in: the gate must appear
      await page.getByRole('button', { name: /account menu/i }).click(); await page.getByRole('button', { name: /^sign out$/i }).click(); await page.waitForTimeout(1500)
      await page.locator('input[type="email"]').first().fill(EMAIL); await page.locator('input[type="password"]').first().fill(PASSWORD); await page.locator('button[type="submit"]').first().click()
      await page.getByRole('heading', { name: /one more step/i }).waitFor({ timeout: 15_000 })
      await page.screenshot({ path: `${OUT}/mfa-gate.png` }); console.log(`${OUT}/mfa-gate.png`)
      await page.getByLabel(/six-digit code/i).fill('000000'); await page.getByRole('button', { name: /continue/i }).click(); await page.waitForTimeout(1000)
      const wrong = await page.getByText(/did not match/i).count()
      // the enrolment consumed the current step and the server refuses a step already used — use the next one (±1 drift is accepted)
      await page.getByLabel(/six-digit code/i).fill(totp(b32decode(secret), stepAt() + 1)); await page.getByRole('button', { name: /continue/i }).click()
      // the hash survives sign-out, so we land back on Account: the workspace shell (account menu) is the proof of admission
      await page.getByRole('button', { name: /account menu/i }).waitFor({ timeout: 20_000 })
      await page.screenshot({ path: `${OUT}/mfa-after-code.png` })
      console.log(`gate: wrong code refused=${wrong > 0}, right code admitted=true`)
      // tidy: disable so the demo account stays password-only for the next rig run
      await page.goto(`${BASE}/#/account`); await page.waitForTimeout(1200)
      await page.getByRole('button', { name: /^disable$/i }).click(); await page.waitForTimeout(600)
      await page.waitForTimeout(31_000); await page.getByLabel(/six-digit code, or a recovery code/i).fill(totp(b32decode(secret), stepAt() + 1)); await page.getByRole('button', { name: /continue/i }).click(); await page.waitForTimeout(1200)
      console.log(`disabled again: ${(await page.locator('.mfa-pill.off').count()) > 0}`)
      if (wrong === 0) process.exitCode = 1
      return
    }

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
