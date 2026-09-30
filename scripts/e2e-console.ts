/// <reference lib="dom" />
/**
 * The sales action, driven the way a salesperson does it.
 *
 * Sign in at the ordinary login page, land in the console, clear the mandatory
 * second factor, create a company, confirm it exists and is billable, then put
 * everything back.
 *
 * It uses a THROWAWAY operator: enrolling writes a TOTP secret, and doing that
 * to the real account would leave its owner facing a "enter your code" screen
 * for a QR they never saw.
 */
import { chromium, type Page } from 'playwright-core'
import { totp, stepAt } from '../src/auth/mfa.ts'

const BASE = process.env.CONSOLE_BASE ?? 'https://pepl.onrol.in'
const EMAIL = process.env.CONSOLE_EMAIL!
const PASSWORD = process.env.CONSOLE_PASSWORD!

const fails: string[] = []
const check = (ok: boolean, what: string, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  — ' + extra : ''}`)
  if (!ok) fails.push(what)
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const base32Decode = (v: string): Buffer => {
  let bits = 0, value = 0
  const out: number[] = []
  for (const c of v.toUpperCase().replace(/[^A-Z2-7]/g, '')) {
    value = (value << 5) | B32.indexOf(c); bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8 }
  }
  return Buffer.from(out)
}

const platform = async (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(`/api/platform${p as string}`, {
      method: m as string,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${sessionStorage.getItem('pepl.platform.token')}`,
      },
      body: b ? JSON.stringify(b) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }, [method, path, body] as const)

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => check(false, 'no browser errors', e.message))
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) check(false, 'no 5xx', `${r.status()} ${r.url()}`)
  })

  // ── 1. the ordinary login page sends an operator to the console ───────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(900)
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3500)
  check(/\/admin/.test(page.url()), 'the shared login sends an operator to the console', page.url())

  // ── 2. the second factor is mandatory and the console shows the QR ────────
  const bodyText = (await page.textContent('body')) ?? ''
  check(/second factor|authenticator|scan/i.test(bodyText), 'the console demands enrolment on first sign-in')
  const secret = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('code')).map((c) => (c.textContent ?? '').trim())
    return el.find((t) => /^[A-Z2-7]{16,}$/.test(t)) ?? ''
  })
  check(Boolean(secret), 'the enrolment secret is shown so it can be scanned', secret ? `${secret.length} chars` : 'not found')
  if (!secret) { await browser.close(); process.exit(1) }

  // A wrong code, then a reload -- exactly what a person does when a code does
  // not take. It used to answer 401, which the console read as "signed out":
  // straight back to the login page, and signing in again minted a NEW secret,
  // so the QR already on their phone was stale and every retry failed.
  const codeBox = 'input[inputmode="numeric"], input[autocomplete="one-time-code"]'
  await page.fill(codeBox, '000000')
  await page.click('button[type="submit"], form button')
  await page.waitForTimeout(2500)
  const stayed = /\/admin/.test(page.url())
  check(stayed, 'a wrong code keeps you on the console instead of the login page', page.url())
  if (!stayed) { await browser.close(); console.log('\nstopped: the loop reproduced'); process.exit(1) }
  check(/not right|codes change/i.test((await page.textContent('body')) ?? ''), 'the wrong code is explained where you typed it')

  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2500)
  const secretAfterReload = await page.evaluate(() =>
    Array.from(document.querySelectorAll('code')).map((c) => (c.textContent ?? '').trim()).find((t) => /^[A-Z2-7]{16,}$/.test(t)) ?? '')
  check(secretAfterReload === secret, 'a reload shows the SAME secret, so the QR on your phone stays valid')

  await page.fill(codeBox, totp(base32Decode(secret), stepAt()))
  await page.click('button[type="submit"], form button')
  await page.waitForTimeout(3500)
  const afterVerify = (await page.textContent('body')) ?? ''
  check(!/second factor|scan this code/i.test(afterVerify), 'a valid code opens the console')

  // ── 3. create a company, the way a rep does ───────────────────────────────
  const stamp = Date.now()
  const legalName = `E2E Test Company ${stamp}`
  const created = await platform(page, 'POST', '/tenants', {
    legalName, adminEmail: `e2e-admin-${stamp}@example.test`, adminName: 'E2E Admin',
    planCode: 'starter', stateCode: 'TS',
  })
  check(created.status === 200 || created.status === 201, 'a company can be created from the console',
    `status ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`)
  const tenantId = (created.body as { tenantId?: string; id?: string }).tenantId
    ?? (created.body as { id?: string }).id

  // ── 4. it is visible and billable ─────────────────────────────────────────
  const list = await platform(page, 'GET', '/tenants')
  check(JSON.stringify(list.body).includes(legalName), 'the new company appears in the console list')

  const plans = await platform(page, 'GET', '/plans')
  check(plans.status === 200, 'plans load', `status ${plans.status}`)

  if (tenantId) {
    const detail = await platform(page, 'GET', `/tenants/${tenantId}`)
    check(detail.status === 200, 'the company detail opens', `status ${detail.status}`)
    // Invoices arrive INSIDE the detail payload -- there is no /tenants/:id/invoices
    // route, and asking for one returned a 404 that looked like a missing feature.
    check('invoices' in (detail.body as Record<string, unknown>),
      'its invoices come back with the detail', Object.keys(detail.body as object).join(','))
  }

  const revenue = await platform(page, 'GET', '/revenue')
  check(revenue.status === 200, 'the revenue dashboard loads', `status ${revenue.status}`)

  // ── 5. an operator still cannot reach inside a customer ───────────────────
  const inside = await platform(page, 'GET', '/employees')
  check(inside.status >= 400, 'an operator has no route into customer data', `status ${inside.status}`)

  await page.screenshot({ path: 'docs/ui-checks/console-after-create.png' })
  console.log(`\nCREATED_TENANT=${tenantId ?? ''}`)
  await browser.close()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nconsole flow clean')
  process.exit(fails.length ? 1 : 0)
}
main()
