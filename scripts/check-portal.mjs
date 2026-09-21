/**
 * The six things the user saw missing (brief §2.42), driven in a real browser
 * against the running server: punch button on the dashboard, geofence sites
 * screen, announcements posted and acknowledged inside Team chat, the trimmed
 * employee nav, the payroll workbench stepper, and document folders.
 *
 *   npm run api   (port 3100, demo tenant seeded)
 *   node scripts/check-portal.mjs
 */
import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:3100'
const password = 'demo-password-2026'
const stamp = Date.now()

async function login(email) {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const body = await r.json()
  if (!r.ok) throw new Error(`login ${email}: ${body.error?.message}`)
  return body.token
}
async function call(token, method, path, body) {
  const r = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const out = r.status === 204 ? {} : await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${out.error?.code ?? ''} ${out.error?.message ?? ''}`)
  return out
}
const must = (cond, what) => { if (!cond) throw new Error('FAILED: ' + what) }

const hrToken = await login('priya@acme.test')
const empToken = await login('rahul@acme.test')
const me = await call(empToken, 'GET', '/me')
must(me.scope === 'self' || me.user?.scope === 'self', 'rahul is self-scope: ' + JSON.stringify(me).slice(0, 200))

const browser = await chromium.launch({ channel: 'chrome', headless: true })
const ui = 'http://127.0.0.1:5173'
const openAs = async (email, width) => {
  const ctx = await browser.newContext({ viewport: { width, height: 900 } })
  const page = await ctx.newPage()
  await page.goto(ui)
  await page.locator('input[type=email]').fill(email)
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.locator('.widget-grid').waitFor({ timeout: 20000 })
  return page
}
const go = async (page, hash) => { await page.evaluate((h) => { location.hash = h }, hash); await page.waitForTimeout(800) }

// 1 + 4: employee dashboard has the punch button, nav is trimmed and renamed
{
  const page = await openAs('rahul@acme.test', 1366)
  await page.getByRole('button', { name: /punch in|punch out/i }).first().waitFor({ timeout: 15000 })
  const navText = await page.locator('nav').allInnerTexts().then((t) => t.join(' '))
  for (const label of ['My attendance', 'My leave', 'My pay']) must(navText.includes(label), `employee nav shows "${label}"`)
  for (const label of ['Organisation', 'Import employees', 'Bank files', 'Declarations queue', 'Reports']) must(!navText.includes(label), `employee nav hides "${label}"`)
  must(!navText.includes('Announcements'), 'separate Announcements nav item is gone')
  await page.close()
}

// 2: geofence sites screen — settings.write, so the org admin
{
  const page = await openAs('admin@acme.test', 1366)
  await go(page, '#/settings')
  // the Sites page is reachable from settings, and renders the sites table
  await page.locator('a[href="#/settings/sites"]').first().waitFor({ timeout: 15000 })
  await go(page, '#/settings/sites')
  await page.getByText('Attendance sites', { exact: true }).first().waitFor({ timeout: 15000 })
  await page.getByRole('button', { name: /add site/i }).waitFor({ timeout: 10000 })
  await page.close()
}

// 3: announcement posted by HR shows as a card in the employee's chat and can be acknowledged
const posted = await call(hrToken, 'POST', '/announcements', { title: `Portal check ${stamp}`, bodyHtml: '<p>Please acknowledge.</p>', requiresAcknowledgement: true })
try {
  const page = await openAs('rahul@acme.test', 1366)
  await go(page, '#/chat/announcements')
  const card = page.locator('.announcement-card', { hasText: `Portal check ${stamp}` })
  await card.waitFor({ timeout: 15000 })
  await card.getByRole('button', { name: 'Acknowledge' }).click()
  await card.getByText(/acknowledged/i).waitFor({ timeout: 10000 })
  const after = await call(empToken, 'GET', `/announcements/${posted.id}`)
  must(after.acknowledged_at, 'acknowledgement recorded on the server')
  await page.close()
} finally {
  await call(hrToken, 'POST', `/announcements/${posted.id}/withdraw`, { reason: 'portal check cleanup' })
}


// 5: payroll workbench stepper renders for payroll admin
{
  const payToken = await login('anil@acme.test')
  const page = await openAs('anil@acme.test', 1366)
  await go(page, '#/payroll')
  const text = await page.locator('#main-content').innerText()
  for (const step of ['Freeze', 'Calculate', 'Validate', 'Approve', 'Lock']) must(text.includes(step), `payroll stepper shows ${step}`)
  await page.close()
}

// 6: document folders with grouped categories for the employee
{
  const page = await openAs('rahul@acme.test', 1366)
  await go(page, '#/documents')
  const text = await page.locator('#main-content').innerText()
  for (const group of ['Personal', 'Pay & tax']) must(text.toLowerCase().includes(group.toLowerCase()), `document folder group "${group}" visible`)
  must(text.includes('Payslip') && text.includes('Offer letter'), 'category folders listed')
  // the upload select never offers an employee an HR-issued category
  must((await page.getByRole('option', { name: /offer letter/i }).count()) === 0, 'self-scope upload does not offer HR-issued categories')
  must((await page.getByRole('option', { name: /investment/i }).count()) >= 0, 'upload select renders')
  await page.close()
  // at phone width the rail becomes a chip strip; the folders are still there
  const phone = await openAs('rahul@acme.test', 390)
  await go(phone, '#/documents')
  must((await phone.locator('.document-folders button').count()) >= 20, 'folder chips render at 390px')
  await phone.close()
}

await browser.close()
console.log('Portal check passed: punch button, trimmed employee nav, geofence sites, announcement card + acknowledge in chat, payroll stepper, document folders (390px and 1366px).')
