import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:3100'
const password = 'demo-password-2026'
const subject = `Mailbox UI verification ${Date.now()}`

async function login(email) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message ?? 'Login failed')
  return result.token
}

async function call(token, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
  const result = response.status === 204 ? {} : await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error?.message ?? ''}`)
  return result
}

const token = await login('admin@acme.test')
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto('http://127.0.0.1:5173')
  await page.locator('input[type=email]').fill('admin@acme.test')
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.locator('.widget-grid').waitFor()
  await page.evaluate(() => { location.hash = '#/mail' })
  await page.getByRole('button', { name: /compose/i }).waitFor()
  await page.getByRole('button', { name: /compose/i }).click()

  const to = page.getByLabel('To recipient')
  await to.fill('admin@acme.test')
  await to.press('Enter')
  await page.getByPlaceholder('What is this about?').fill(subject)
  await page.getByRole('textbox', { name: 'Message body' }).fill('A complete composer and a safe reading pane.')
  await page.locator('.mail-attach-button input').setInputFiles({ name: 'verification.txt', mimeType: 'text/plain', buffer: Buffer.from('PEPL mail attachment verification') })
  await page.getByText('verification.txt').waitFor()
  await page.getByRole('button', { name: /^send$/i }).click()
  await page.getByText(/Delivered to 1/i).waitFor()

  await page.getByRole('button', { name: /Inbox/ }).click()
  const row = page.getByRole('button', { name: new RegExp(subject) })
  await row.waitFor()
  await row.click()
  const frame = page.locator('iframe[title="Message content"]')
  await frame.waitFor()
  if ((await frame.getAttribute('sandbox')) !== '') throw new Error('Mail HTML iframe is not fully sandboxed')
  await page.getByRole('button', { name: /reply all/i }).click()
  await page.getByLabel('To recipient').waitFor()
  if (!await page.getByText('admin@acme.test', { exact: true }).count()) throw new Error('Reply-all did not preset the sender')
  await page.getByRole('button', { name: /close composer/i }).click()

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  if (overflow) throw new Error('Desktop mailbox has horizontal page overflow')
  await page.screenshot({ path: `${process.env.TEMP}/pepl-mail-desktop.png`, fullPage: true })

  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: new RegExp(subject) }).click()
  await page.getByText('Mailbox', { exact: true }).waitFor()
  await page.waitForTimeout(350)
  const detailBounds = await page.locator('.mail-detail').boundingBox()
  if (!detailBounds || detailBounds.x > 16 || detailBounds.width < 370) throw new Error(`Mobile reading pane does not cover the workspace: ${JSON.stringify(detailBounds)}`)
  const mobileOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  if (mobileOverflow) throw new Error('Mobile mailbox has horizontal page overflow')
  await page.screenshot({ path: `${process.env.TEMP}/pepl-mail-mobile.png`, fullPage: true })

  const folders = await call(token, 'GET', '/mail/folders')
  const inbox = folders.folders.find(folder => folder.role === 'inbox')
  const list = await call(token, 'GET', `/mail/messages?folderId=${inbox.id}&q=${encodeURIComponent('Mailbox UI verification')}`)
  for (const envelope of list.envelopes) await call(token, 'DELETE', `/mail/messages/${envelope.id}`, {})
  const trash = folders.folders.find(folder => folder.role === 'trash')
  const trashed = await call(token, 'GET', `/mail/messages?folderId=${trash.id}&q=${encodeURIComponent('Mailbox UI verification')}`)
  for (const envelope of trashed.envelopes) await call(token, 'DELETE', `/mail/messages/${envelope.id}`, {})
  console.log('Mail composer, attachment, sandboxed reader, reply preset, desktop and mobile layouts passed.')
} finally {
  await browser.close()
}
