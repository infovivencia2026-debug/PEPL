/// <reference lib="dom" />
import { chromium } from 'playwright-core'
const BASE = process.env.E2E_BASE!
const main = async () => {
  const b = await chromium.launch({ channel: 'chrome', headless: true })
  const p = await b.newPage()
  p.on('console', (m) => console.log('CONSOLE:', m.type(), m.text()))
  p.on('pageerror', (e) => console.log('PAGEERROR:', e.message))
  p.on('response', async (r) => {
    if (r.url().includes('/api/')) {
      let body = ''
      try { body = (await r.text()).slice(0, 300) } catch { /* stream */ }
      console.log('API', r.status(), r.url(), body)
    }
  })
  await p.goto(BASE, { waitUntil: 'domcontentloaded' })
  await p.waitForTimeout(1500)
  console.log('--- form controls ---')
  console.log(await p.evaluate(() => Array.from(document.querySelectorAll('input,button')).map((e) => {
    const el = e as HTMLInputElement
    return `${e.tagName} type=${el.type} name=${el.name || ''} text=${(e.textContent || '').trim().slice(0, 30)}`
  }).join('\n')))
  await p.fill('input[type="email"], input[name="email"]', process.env.E2E_OPS_EMAIL!)
  await p.fill('input[type="password"], input[name="password"]', process.env.E2E_OPS_PASSWORD!)
  await p.click('button[type="submit"], form button')
  await p.waitForTimeout(4000)
  console.log('--- after submit ---')
  console.log('url:', p.url())
  console.log('sessionStorage token:', await p.evaluate(() => sessionStorage.getItem('pepl.platform.token')))
  console.log('visible text:', ((await p.textContent('body')) || '').replace(/\s+/g, ' ').slice(0, 400))
  await b.close()
}
main()
