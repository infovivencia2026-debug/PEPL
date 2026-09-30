/// <reference lib="dom" />
/**
 * Proves the Content-Security-Policy blocks nothing the app needs.
 *
 * A CSP that is wrong does not fail loudly: a blocked stylesheet or font just makes a screen
 * look subtly broken, and a blocked fetch looks like a network error. So this drives a real
 * browser over every screen for several roles (and the operator console), records each
 * `securitypolicyviolation` the browser raises, and fails if there is one -- and separately
 * proves the policy is actually being enforced (an injected inline script must NOT run).
 *
 *   CSP_BASE=http://127.0.0.1:3199 npm run e2e:csp        (against a locally built dist/)
 */
import { chromium, type Page } from 'playwright-core'

const BASE = process.env.CSP_BASE ?? 'http://127.0.0.1:3100'
const PASSWORD = 'demo-password-2026'
const USERS = ['admin@acme.test', 'priya@acme.test', 'anil@acme.test', 'arjun@acme.test', 'rahul@acme.test']
const SCREENS = ['dashboard', 'people', 'attendance', 'leave', 'payroll', 'approvals', 'tasks', 'engage', 'growth',
  'performance', 'hiring', 'organisation', 'company', 'import', 'bank-files', 'my-tax', 'tax-declarations', 'documents',
  'chat', 'mail', 'notification-settings', 'account', 'reports', 'activity', 'settings']

interface Violation { who: string; screen: string; directive: string; blocked: string }
const violations: Violation[] = []
let failed = false
const check = (ok: boolean, label: string, detail = ''): void => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`)
  if (!ok) failed = true
}

/** Collects every violation the browser reports, including ones raised before app code runs. */
async function watch(page: Page, who: string, screen: () => string): Promise<void> {
  await page.exposeFunction('__reportCsp', (directive: string, blocked: string) => {
    violations.push({ who, screen: screen(), directive, blocked })
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      void (window as unknown as { __reportCsp: (d: string, b: string) => void }).__reportCsp(e.violatedDirective, e.blockedURI || e.sample || 'inline')
    })
  })
}

const main = async (): Promise<void> => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  // 1. The header is there, on the page and on an API response.
  {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const res = await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    const csp = res?.headers()['content-security-policy'] ?? ''
    check(csp.includes("script-src 'self'"), 'the app page is served with a Content-Security-Policy', csp.slice(0, 60))
    check((res?.headers()['permissions-policy'] ?? '').includes('camera=(self)'), 'and a Permissions-Policy that keeps the camera for QR punch')
    const api = await page.request.get(`${BASE}/health`)
    check((api.headers()['content-security-policy'] ?? '').length > 0, 'an API response carries it too')

    // 2. It is ENFORCED: an inline script injected into the page must not run.
    await page.waitForTimeout(500)
    const ran = await page.evaluate(() => {
      const w = window as unknown as { __injected?: boolean }
      const s = document.createElement('script')
      s.textContent = 'window.__injected = true'
      document.body.appendChild(s)
      return w.__injected === true
    })
    check(!ran, 'an injected inline script does NOT execute (the policy is enforced, not merely present)')

    // ...nor can script call out to another origin.
    const leaked = await page.evaluate(async () => {
      try { await fetch('https://example.com/steal', { mode: 'no-cors' }); return true } catch { return false }
    })
    check(!leaked, 'and fetch to a foreign origin is blocked (connect-src)')
    await ctx.close()
  }

  // 3. Every screen, several roles, zero violations.
  for (const email of USERS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page = await ctx.newPage()
    let screen = 'login'
    await watch(page, email, () => screen)
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForTimeout(2500)
    // A control for the watcher itself: zero violations means nothing if it cannot see one.
    // Provoke one on purpose, require that it is caught, then take it back out of the tally.
    if (email === USERS[0]) {
      const before = violations.length
      await page.evaluate(() => {
        const s = document.createElement('script'); s.textContent = 'void 0'; document.body.appendChild(s)
      })
      await page.waitForTimeout(400)
      check(violations.length === before + 1 && /script-src/.test(violations[before]?.directive ?? ''),
        'the violation watcher catches a deliberate violation (so "0 found" is meaningful)')
      violations.splice(before, 1)
    }
    for (const id of SCREENS) {
      screen = id
      await page.goto(`${BASE}/#/${id}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(900)
    }
    await ctx.close()
  }

  // 4. The operator console is a separate page with its own bundle.
  {
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    let screen = 'console login'
    await watch(page, 'operator console', () => screen)
    await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1500)
    screen = 'console'
    const body = (await page.textContent('body')) ?? ''
    check(body.trim().length > 0, 'the operator console renders under the policy')
    await ctx.close()
  }
  await browser.close()

  const byKind = new Map<string, Violation[]>()
  for (const v of violations) byKind.set(`${v.directive} <- ${v.blocked.slice(0, 80)}`, [...(byKind.get(`${v.directive} <- ${v.blocked.slice(0, 80)}`) ?? []), v])
  for (const [kind, list] of byKind) console.log(`VIOLATION x${list.length}  ${kind}  (e.g. ${list[0]!.who} on ${list[0]!.screen})`)
  check(violations.length === 0, `no CSP violations across ${USERS.length} roles x ${SCREENS.length} screens + the console`, `${violations.length} found`)
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
