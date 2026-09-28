/// <reference lib="dom" />
/**
 * Drives the ONE login form in a real browser, both ways.
 *
 * The unit tests prove the endpoint returns the right `kind`. They cannot prove
 * the browser does the right thing with it -- that the operator token lands
 * under the key the console reads, that the redirect goes somewhere that
 * exists, and that a tenant user is unaffected. That is what this checks.
 */
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.E2E_BASE ?? 'http://127.0.0.1:3100'
const OPS_EMAIL = process.env.E2E_OPS_EMAIL!
const OPS_PASSWORD = process.env.E2E_OPS_PASSWORD!
const TENANT_EMAIL = process.env.E2E_TENANT_EMAIL ?? 'admin@acme.test'
const TENANT_PASSWORD = process.env.E2E_TENANT_PASSWORD ?? 'demo-password-2026'
const OUT = 'docs/ui-checks'

const fail: string[] = []
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) fail.push(what)
}

async function signIn(page: Page, email: string, password: string) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"], input[name="email"]', email)
  await page.fill('input[type="password"], input[name="password"]', password)
  await Promise.all([
    page.waitForLoadState('networkidle').catch(() => undefined),
    page.click('button[type="submit"], form button'),
  ])
  await page.waitForTimeout(2500)
}

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const errors: string[] = []

  // ── the operator ──────────────────────────────────────────────────────────
  const opCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const op = await opCtx.newPage()
  op.on('pageerror', (e) => errors.push(`operator: ${e.message}`))
  await signIn(op, OPS_EMAIL, OPS_PASSWORD)

  check(/\/admin/.test(op.url()), `operator lands on the console (url=${op.url()})`)
  const stored = await op.evaluate(() => sessionStorage.getItem('pepl.platform.token'))
  check(!!stored, 'the token is under the key the console reads')
  const body = (await op.textContent('body')) ?? ''
  // Not enrolled yet, so the console must be demanding a second factor rather
  // than showing any customer data.
  check(/second factor|authenticator|Verify/i.test(body), 'the console demands the second factor before opening')
  check(!/Sign in to operations/i.test(body), 'the console shows no password form of its own')
  await op.screenshot({ path: `${OUT}/unified-operator.png`, fullPage: false })

  // ── the customer ──────────────────────────────────────────────────────────
  const tCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const t = await tCtx.newPage()
  t.on('pageerror', (e) => errors.push(`tenant: ${e.message}`))
  await signIn(t, TENANT_EMAIL, TENANT_PASSWORD)

  check(!/\/admin/.test(t.url()), `a customer is NOT sent to the console (url=${t.url()})`)
  const tStored = await t.evaluate(() => sessionStorage.getItem('pepl.platform.token'))
  check(tStored === null, 'a customer login leaves no operator token behind')
  await t.screenshot({ path: `${OUT}/unified-tenant.png`, fullPage: false })

  // ── a direct visit to the console with no session ─────────────────────────
  const dCtx = await browser.newContext()
  const d = await dCtx.newPage()
  await d.goto(`${BASE}/admin.html`, { waitUntil: 'domcontentloaded' })
  await d.waitForTimeout(2500)
  check(!/\/admin/.test(d.url()), `an anonymous visit to the console bounces to the login page (url=${d.url()})`)

  check(errors.length === 0, `no browser errors${errors.length ? ': ' + errors.join(' | ') : ''}`)
  await browser.close()

  console.log(fail.length ? `\n${fail.length} FAILED` : '\nall checks passed')
  process.exit(fail.length ? 1 : 0)
}
main()
