/// <reference lib="dom" />
/**
 * Walks the product as each demo user does, through the real UI.
 *
 * The smoke rig proves the API answers. This proves the SCREENS work: that a
 * nav item a role can see actually opens, that nothing throws in the browser,
 * that no request 500s, and that a page does not scroll sideways on a phone.
 *
 * A 403 here is a finding, not a pass: if a role can SEE a nav item, clicking
 * it should not be refused. Either the item should be hidden or the permission
 * is wrong.
 */
import { chromium, type Page, type Browser } from 'playwright-core'
import { mkdir } from 'node:fs/promises'

const BASE = process.env.WALK_BASE ?? 'https://pepl.onrol.in'
const PASSWORD = process.env.WALK_PASSWORD ?? 'demo-password-2026'
const OUT = 'docs/ui-checks/walkthrough'

const USERS: Array<{ email: string; role: string }> = [
  { email: 'admin@acme.test', role: 'org_admin' },
  { email: 'priya@acme.test', role: 'hr_admin' },
  { email: 'anil@acme.test', role: 'payroll_admin' },
  { email: 'finance@acme.test', role: 'finance' },
  { email: 'arjun@acme.test', role: 'manager' },
  { email: 'rahul@acme.test', role: 'employee' },
  { email: 'auditor@acme.test', role: 'auditor' },
]

interface Finding { role: string; screen: string; kind: string; detail: string }
const findings: Finding[] = []
const note = (f: Finding) => { findings.push(f); console.log(`  ${f.kind.padEnd(12)} ${f.screen.padEnd(22)} ${f.detail.slice(0, 150)}`) }

async function signIn(page: Page, email: string): Promise<boolean> {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.fill('input[name="email"], input[type="email"]', email)
  await page.fill('input[name="password"], input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3000)
  const text = (await page.textContent('body')) ?? ''
  return !/incorrect|Sign in to take care/i.test(text)
}

const walkRole = async (browser: Browser, user: { email: string; role: string }) => {
  console.log(`\n=== ${user.role}  (${user.email}) ===`)
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  let screen = 'login'

  page.on('pageerror', (e) => note({ role: user.role, screen, kind: 'JS ERROR', detail: e.message }))
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) {
      note({ role: user.role, screen, kind: 'CONSOLE', detail: m.text() })
    }
  })
  page.on('response', async (r) => {
    if (!r.url().includes('/api/')) return
    const s = r.status()
    if (s >= 500) note({ role: user.role, screen, kind: 'SERVER 5xx', detail: `${s} ${r.url().replace(BASE, '')}` })
    else if (s === 403) note({ role: user.role, screen, kind: 'FORBIDDEN', detail: `${s} ${r.url().replace(BASE, '')}` })
    else if (s >= 400 && s !== 401 && s !== 404) note({ role: user.role, screen, kind: `HTTP ${s}`, detail: r.url().replace(BASE, '') })
  })

  if (!(await signIn(page, user.email))) {
    note({ role: user.role, screen: 'login', kind: 'LOGIN FAIL', detail: 'could not sign in' })
    await ctx.close()
    return
  }

  // Whatever this role can actually see in the nav.
  const navItems = await page.evaluate(() =>
    Array.from(document.querySelectorAll('nav a, aside a, [role="navigation"] a'))
      .map((a) => ({ label: (a.textContent ?? '').trim(), href: (a as HTMLAnchorElement).getAttribute('href') ?? '' }))
      .filter((n) => n.label && n.href && n.href !== '#'))
  const seen = new Set<string>()
  const unique = navItems.filter((n) => !seen.has(n.href) && seen.add(n.href))
  console.log(`  nav items visible: ${unique.length}`)

  for (const item of unique) {
    screen = item.label
    try {
      await page.goto(`${BASE}/${item.href.replace(/^\/?#?\/?/, '#/')}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1600)
      const body = (await page.textContent('body')) ?? ''
      if (/Something went wrong|Unexpected error|Page not found/i.test(body)) {
        note({ role: user.role, screen, kind: 'BROKEN', detail: body.replace(/\s+/g, ' ').slice(0, 120) })
      }
      // A screen that renders nothing at all is a finding too.
      const visible = await page.evaluate(() => (document.querySelector('main')?.textContent ?? '').trim().length)
      if (visible < 20) note({ role: user.role, screen, kind: 'EMPTY', detail: `main has ${visible} chars` })
    } catch (e) {
      note({ role: user.role, screen, kind: 'NAV ERROR', detail: (e as Error).message })
    }
  }

  // Phone width: the product is used on phones and sideways scroll is a defect.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(2000)
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  if (overflow > 2) note({ role: user.role, screen: 'dashboard@390', kind: 'OVERFLOW', detail: `${overflow}px of sideways scroll` })
  await page.screenshot({ path: `${OUT}/${user.role}-390.png` })

  await ctx.close()
}

const main = async () => {
  await mkdir(OUT, { recursive: true })
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const u of USERS) await walkRole(browser, u)
  await browser.close()

  console.log(`\n${'='.repeat(70)}`)
  if (!findings.length) { console.log('no findings'); return }
  const byKind = new Map<string, Finding[]>()
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  console.log(`${findings.length} findings\n`)
  for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${kind} (${list.length})`)
    for (const f of list.slice(0, 12)) console.log(`   ${f.role.padEnd(14)} ${f.screen.padEnd(20)} ${f.detail.slice(0, 110)}`)
    if (list.length > 12) console.log(`   ... and ${list.length - 12} more`)
    console.log()
  }
}
main()
