/// <reference lib="dom" />
/**
 * Every screen a role is entitled to, opened one at a time.
 *
 * The first walkthrough only clicked the nav items rendered as links, which is
 * the top six. The rest live behind the overflow menu and were never opened --
 * so "no findings" meant "no findings in the part I looked at". This asks the
 * server which items the role should see (the same workspace payload the app
 * itself filters on) and opens every one.
 */
import { chromium, type Page, type Browser } from 'playwright-core'

const BASE = process.env.DEEP_BASE ?? 'https://pepl.onrol.in'
const PASSWORD = 'demo-password-2026'
const USERS = ['admin@acme.test', 'priya@acme.test', 'anil@acme.test',
  'finance@acme.test', 'arjun@acme.test', 'rahul@acme.test', 'auditor@acme.test']

interface Finding { who: string; screen: string; kind: string; detail: string }
const findings: Finding[] = []
const note = (f: Finding) => { findings.push(f); console.log(`    ${f.kind.padEnd(11)} ${f.screen.padEnd(22)} ${f.detail.slice(0, 120)}`) }

/** Every nav id in the app, with what it needs. Kept in step with web/src/app/nav.ts. */
const SCREENS: Array<{ id: string; permission?: string; module?: string; employeeRequired?: boolean }> = [
  { id: 'dashboard' }, { id: 'people', permission: 'employee.read' },
  { id: 'attendance', permission: 'attendance.read', module: 'attendance' },
  { id: 'leave', permission: 'leave.read', module: 'leave' },
  { id: 'payroll', permission: 'payroll.read', module: 'payroll' },
  { id: 'approvals', permission: 'approval.act' }, { id: 'tasks', permission: 'task.read' },
  { id: 'engage' }, { id: 'growth', permission: 'learning.read', module: 'learning' },
  { id: 'performance', permission: 'performance.read', module: 'performance' },
  { id: 'hiring', permission: 'recruit.read', module: 'recruitment' },
  { id: 'organisation', permission: 'settings.write' }, { id: 'company', permission: 'settings.write' },
  { id: 'import', permission: 'import.run' },
  { id: 'bank-files', permission: 'bank.read', module: 'payroll' },
  { id: 'my-tax', permission: 'payroll.read', module: 'payroll', employeeRequired: true },
  { id: 'tax-declarations', permission: 'payroll.process', module: 'payroll' },
  { id: 'documents', permission: 'document.read', module: 'documents' },
  { id: 'chat', module: 'chat' }, { id: 'mail', module: 'mail' },
  { id: 'notification-settings' }, { id: 'account' },
  { id: 'reports', permission: 'report.read' }, { id: 'activity', permission: 'audit.read' },
  { id: 'settings', permission: 'settings.write' },
]

const main = async () => {
  const browser: Browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const email of USERS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    const page: Page = await ctx.newPage()
    let screen = 'login'
    page.on('pageerror', (e) => note({ who: email, screen, kind: 'JS ERROR', detail: e.message }))
    page.on('response', (r) => {
      if (!r.url().includes('/api/')) return
      const s = r.status()
      if (s >= 500) note({ who: email, screen, kind: 'SERVER 5xx', detail: `${s} ${r.url().replace(BASE, '')}` })
      else if (s === 403) note({ who: email, screen, kind: 'FORBIDDEN', detail: `${s} ${r.url().replace(BASE, '')}` })
    })

    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(700)
    await page.fill('input[type="email"]', email)
    await page.fill('input[type="password"]', PASSWORD)
    await page.click('button[type="submit"]')
    await page.waitForTimeout(2800)

    // What the app itself would allow this user to see.
    const ws = await page.evaluate(async () => {
      const r = await fetch('/api/ui/workspace', { credentials: 'same-origin' })
      return r.ok ? await r.json() : null
    }) as { permissions?: string[]; modules?: Record<string, boolean>; user?: { employeeId?: string } } | null
    if (!ws) { note({ who: email, screen: 'login', kind: 'NO SESSION', detail: 'workspace did not load' }); await ctx.close(); continue }

    const allowed = SCREENS.filter((s) =>
      (!s.permission || (ws.permissions ?? []).includes(s.permission)) &&
      (!s.module || (ws.modules ?? {})[s.module]) &&
      (!s.employeeRequired || Boolean(ws.user?.employeeId)))
    console.log(`\n=== ${email} — ${allowed.length} entitled screens ===`)

    for (const s of allowed) {
      screen = s.id
      await page.goto(`${BASE}/#/${s.id}`, { waitUntil: 'domcontentloaded' })
      await page.waitForTimeout(1500)
      const body = (await page.textContent('body')) ?? ''
      if (/Something went wrong|Unexpected error|Page not found|Failed to load/i.test(body)) {
        note({ who: email, screen, kind: 'BROKEN', detail: body.replace(/\s+/g, ' ').slice(0, 110) })
      }
    }
    await ctx.close()
  }
  await browser.close()

  console.log(`\n${'='.repeat(70)}`)
  if (!findings.length) { console.log('no findings'); return }
  console.log(`${findings.length} findings\n`)
  const byKind = new Map<string, Finding[]>()
  for (const f of findings) byKind.set(f.kind, [...(byKind.get(f.kind) ?? []), f])
  for (const [kind, list] of [...byKind].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`${kind} (${list.length})`)
    const seen = new Set<string>()
    for (const f of list) {
      const key = `${f.screen}|${f.detail}`
      if (seen.has(key)) continue
      seen.add(key)
      console.log(`   ${f.who.padEnd(20)} ${f.screen.padEnd(20)} ${f.detail.slice(0, 100)}`)
    }
    console.log()
  }
}
main()
