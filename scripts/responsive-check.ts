/// <reference lib="dom" />
/**
 * Responsive sweep. Measures the things that actually break a layout on a real
 * device, at real device widths:
 *
 *   - horizontal overflow (the cardinal sin: a page you can swipe sideways)
 *   - any element wider than the viewport, named so it can be fixed
 *   - tap targets under 44px
 *   - text under 12px
 *   - total content height vs the viewport
 *
 * Exit 1 on a hard failure so it can gate a build.
 */
import { chromium } from 'playwright-core'

const BASE = process.env.SHOOT_BASE ?? 'http://127.0.0.1:3100'
const DEVICES: [string, number, number][] = [
  ['iPhone SE', 375, 667],
  ['iPhone 14', 390, 844],
  ['Pixel 7', 412, 915],
  ['iPad mini portrait', 768, 1024],
  ['iPad Pro landscape', 1024, 768],
  ['Laptop 1366', 1366, 768],
  ['Laptop 1440', 1440, 900],
  ['Desktop 1920', 1920, 1080],
]

const failures: string[] = []

const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  for (const [name, width, height] of DEVICES) {
    const context = await browser.newContext({
      viewport: { width, height },
      deviceScaleFactor: 1,
      // A tablet is a touch device even at 1024px wide; testing it as a mouse
      // surface hides every tap-target problem an iPad user would hit.
      isMobile: width < 768,
      hasTouch: width <= 1024,
    })
    const page = await context.newPage()
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await page.locator('input[type="email"]').first().fill('admin@acme.test')
    await page.locator('input[type="password"]').first().fill('demo-password-2026')
    await page.locator('button[type="submit"]').first().click()
    await page.getByRole('heading', { name: /at a glance/i }).waitFor({ timeout: 20_000 })
    await page.waitForTimeout(600)

    const touch = width <= 1024
    const report = await page.evaluate(({ vw, touch }) => {
      const doc = document.documentElement
      const overflow = doc.scrollWidth - vw
      const wide: string[] = []
      const small: string[] = []
      const tiny: string[] = []
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const r = el.getBoundingClientRect()
        if (r.width === 0 || r.height === 0) continue
        if (r.right > vw + 1 || r.left < -1) {
          const id = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}`
          if (!wide.includes(id) && wide.length < 6) wide.push(id)
        }
        const style = getComputedStyle(el)
        // 44px is a FINGERTIP requirement. A mouse hits a 32px target fine, so
        // enforcing it on desktop cries wolf and trains people to ignore the gate.
        if (
          touch &&
          (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' || el.tagName === 'SELECT') &&
          style.display !== 'none' && (r.height < 44 || r.width < 24)
        ) {
          const id = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}:${Math.round(r.width)}x${Math.round(r.height)}`
          if (!small.includes(id) && small.length < 6) small.push(id)
        }
        // Chart captions live inside a ring and are exempt; everything a person
        // reads as prose is held to the floor.
        const size = parseFloat(style.fontSize)
        const inChart = el.closest('.donut') !== null
        if (!inChart && size > 0 && size < (touch ? 12 : 11) &&
            (el.textContent ?? '').trim().length > 2 && el.children.length === 0) {
          const id = `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}:${size}px`
          if (!tiny.includes(id) && tiny.length < 6) tiny.push(id)
        }
      }
      return { overflow, wide, small, tiny, scrollHeight: doc.scrollHeight }
    }, { vw: width, touch })

    const status = report.overflow > 1 ? `HORIZONTAL OVERFLOW ${report.overflow}px` : 'no h-scroll'
    console.log(`\n${name.padEnd(20)} ${width}x${height}  ${status}`)
    console.log(`  content height ${report.scrollHeight}px (viewport ${height}px)`)
    if (report.wide.length) console.log(`  overflowing: ${report.wide.join(', ')}`)
    if (report.small.length) console.log(`  small targets: ${report.small.join(', ')}`)
    if (report.tiny.length) console.log(`  text < 12px: ${report.tiny.join(', ')}`)

    if (report.overflow > 1) failures.push(`${name}: ${report.overflow}px horizontal overflow`)
    if (report.small.length) failures.push(`${name}: ${report.small.length} tap target(s) under 44px`)
    if (report.tiny.length) failures.push(`${name}: ${report.tiny.length} text run(s) below the floor`)
    await page.screenshot({ path: `docs/ui-checks/resp-${width}.png`, fullPage: false })
    await context.close()
  }
} finally {
  await browser.close()
}

console.log('')
if (failures.length) {
  console.error(`RESPONSIVE FAILURES (${failures.length}):`)
  for (const f of failures) console.error(`  x ${f}`)
  process.exit(1)
}
console.log('No horizontal overflow at any tested width.')
