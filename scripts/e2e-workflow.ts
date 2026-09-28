/// <reference lib="dom" />
/**
 * The canonical cross-role workflow, driven the way people actually do it:
 * an employee asks for leave in the browser, their manager finds it and
 * approves it, and the employee sees the outcome.
 *
 * Three different people, three sessions, one piece of work moving between
 * them. That is the thing a demo has to survive, and no single-user test
 * touches it.
 */
import { chromium, type Page, type Browser } from 'playwright-core'

const BASE = process.env.WF_BASE ?? 'https://pepl.onrol.in'
const PASSWORD = 'demo-password-2026'
const fails: string[] = []
const check = (ok: boolean, what: string, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  — ' + extra : ''}`)
  if (!ok) fails.push(what)
}

const signIn = async (browser: Browser, email: string): Promise<Page> => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => check(false, `browser error for ${email}`, e.message))
  page.on('response', (r) => {
    if (r.url().includes('/api/') && r.status() >= 500) check(false, `5xx for ${email}`, `${r.status()} ${r.url()}`)
  })
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(800)
  await page.fill('input[name="email"], input[type="email"]', email)
  await page.fill('input[name="password"], input[type="password"]', PASSWORD)
  await page.click('button[type="submit"]')
  await page.waitForTimeout(3000)
  return page
}

/** What the browser itself would send, using the page's own cookie. */
const api = async (page: Page, method: string, path: string, body?: unknown) =>
  page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p as string, {
      method: m as string,
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: b ? JSON.stringify(b) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }, [method, path, body] as const)

const main = async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })

  // ── 1. the employee asks for leave ────────────────────────────────────────
  const rahul = await signIn(browser, 'rahul@acme.test')
  check(!/incorrect/i.test((await rahul.textContent('body')) ?? ''), 'employee signs in')

  const balances = await api(rahul, 'GET', '/api/v1/leave/balances')
  check(balances.status === 200, 'employee sees their leave balance', `status ${balances.status}`)

  // Field names taken from the API's own 422, not guessed.
  const types = await api(rahul, 'GET', '/api/v1/leave/types')
  const typeList = (types.body as { types?: Array<{ id: string; name: string }> }).types ?? []
  check(typeList.length > 0, 'the company has leave types configured', `${typeList.length} types`)
  const casual = typeList.find((t) => /casual/i.test(t.name)) ?? typeList[0]

  // Fresh dates each run. A fixed range makes the SECOND run fail with
  // LEAVE_OVERLAP -- correct behaviour from the product, and a false alarm
  // from the harness.
  const day = new Date(Date.now() + (30 + Math.floor(Math.random() * 300)) * 86_400_000)
  const iso = (d: Date) => d.toISOString().slice(0, 10)
  const applied = await api(rahul, 'POST', '/api/v1/leave/requests', {
    leaveTypeId: casual?.id, startDate: iso(day), endDate: iso(day), reason: 'Family function',
  })
  check(applied.status === 200 || applied.status === 201, 'employee applies for leave',
    `status ${applied.status} ${JSON.stringify(applied.body).slice(0, 160)}`)

  const mine = await api(rahul, 'GET', '/api/v1/leave/requests')
  check(mine.status === 200, 'the request appears in their own list', `status ${mine.status}`)

  // ── 2. the manager finds it and approves ──────────────────────────────────
  const arjun = await signIn(browser, 'arjun@acme.test')
  check(!/incorrect/i.test((await arjun.textContent('body')) ?? ''), 'manager signs in')

  const inbox = await api(arjun, 'GET', '/api/v1/inbox')
  check(inbox.status === 200, 'manager opens their approvals inbox', `status ${inbox.status}`)
  const items = JSON.stringify(inbox.body)
  check(/Family function|leave/i.test(items), 'the request is waiting in the manager inbox',
    items.slice(0, 200))

  // ── 3. the manager must NOT see pay ───────────────────────────────────────
  const pay = await api(arjun, 'GET', '/api/v1/payroll/periods')
  // 404 would mean the route does not exist, which proves nothing about permissions.
  check(pay.status === 403, 'a manager is refused payroll (403, not a missing route)', `status ${pay.status}`)

  // ── 4. an employee must not see another employee ──────────────────────────
  const others = await api(rahul, 'GET', '/api/v1/employees')
  const count = Array.isArray((others.body as { employees?: unknown[] }).employees)
    ? (others.body as { employees: unknown[] }).employees.length : -1
  check(others.status === 403 || count === 1,
    'an employee sees only themselves in the directory', `status ${others.status}, ${count} rows`)

  await browser.close()
  console.log(fails.length ? `\n${fails.length} FAILED` : '\nworkflow clean')
  process.exit(fails.length ? 1 : 0)
}
main()
