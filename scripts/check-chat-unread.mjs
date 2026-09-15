import { chromium } from 'playwright-core'

const base = 'http://127.0.0.1:3100'
const password = 'demo-password-2026'
async function login(email) {
  const response = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
  return (await response.json()).token
}
async function call(token, method, path, body) {
  const response = await fetch(`${base}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${result.error?.message ?? ''}`)
  return result
}

const admin = await login('admin@acme.test')
const colleague = await login('priya@acme.test')
const people = await call(admin, 'GET', '/employees')
const priya = people.employees.find(employee => employee.first_name === 'Priya')
if (!priya?.user_id) throw new Error('Employee directory did not expose Priya’s user id')
const title = `Unread verification ${Date.now()}`
const conversation = await call(admin, 'POST', '/chat/conversations', { kind: 'group', title, participantUserIds: [priya.user_id] })
await call(colleague, 'POST', `/chat/conversations/${conversation.id}/messages`, { clientMessageId: crypto.randomUUID(), body: 'Unread watermark verification' })

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.goto('http://127.0.0.1:5173')
  await page.locator('input[type=email]').fill('admin@acme.test')
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.locator('.widget-grid').waitFor()
  await page.evaluate(() => { location.hash = '#/chat' })
  const row = page.getByRole('button', { name: new RegExp(title) })
  await row.waitFor()
  await row.click()
  await page.getByText('Unread watermark verification').waitFor()
  await page.waitForTimeout(250)
  const list = await call(admin, 'GET', '/chat/conversations')
  const unread = list.conversations.find(item => item.id === conversation.id)?.unread
  if (unread !== 0) throw new Error(`Unread count remained ${unread}`)
  await page.getByRole('button', { name: /new conversation/i }).click()
  await page.getByText('Priya Sharma').waitFor()
  console.log('Chat directory rendered and unread watermark cleared after the message appeared.')
} finally {
  await browser.close()
}
