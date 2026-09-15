import { chromium } from 'playwright-core'

const apiBase = 'http://127.0.0.1:3100'
const password = 'demo-password-2026'
const authResponse = await fetch(`${apiBase}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'admin@acme.test', password }) })
const token = (await authResponse.json()).token
const call = async (method, path, body) => {
  const response = await fetch(`${apiBase}/api/v1${path}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status}`)
  return result
}

const browser = await chromium.launch({ channel: 'chrome', headless: true })
let uploadedId
try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true })
  await page.goto('http://127.0.0.1:5173')
  await page.locator('input[type=email]').fill('admin@acme.test')
  await page.locator('input[type=password]').fill(password)
  await page.locator('button[type=submit]').click()
  await page.locator('.widget-grid').waitFor()

  await page.evaluate(() => { location.hash = '#/settings' })
  await page.locator('.settings-list article').first().waitFor()
  const settingCount = await page.locator('.settings-list article').count()
  if (settingCount < 30) throw new Error(`Only ${settingCount} generated settings rendered`)

  await page.evaluate(() => { location.hash = '#/import' })
  await page.locator('.import-drop input').setInputFiles({ name: 'employees.csv', mimeType: 'text/csv', buffer: Buffer.from('employee_number,first_name,date_of_joining\nUI-CHECK,Review,2026-09-01') })
  await page.getByRole('button', { name: /validate file/i }).click()
  await page.getByText('Validation report').waitFor()

  const fileName = `ui-upload-${Date.now()}.txt`
  await page.evaluate(() => { location.hash = '#/documents' })
  await page.locator('.upload-control input').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: Buffer.from('UI upload verification') })
  await page.getByText(fileName).waitFor()
  const documents = await call('GET', '/documents?ownerType=tenant')
  uploadedId = documents.documents.find(document => document.file_name === fileName)?.id
  if (!uploadedId) throw new Error('Uploaded document was not returned by the API')
  console.log(`${settingCount} generated settings rendered; import review and document upload passed.`)
} finally {
  if (uploadedId) await call('DELETE', `/documents/${uploadedId}`, { reason: 'automated UI verification cleanup' })
  await browser.close()
}
