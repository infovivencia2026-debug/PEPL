/// <reference lib="dom" />
import { chromium } from 'playwright-core'
import { writeFile } from 'node:fs/promises'
const browser = await chromium.launch({channel:'chrome',headless:true})
const reports: unknown[]=[]
const failures: string[]=[]
try {
 for(const [width,height] of ([[375,667],[768,1024],[1024,768],[1366,768],[1440,900],[1920,1080]] as [number,number][])) {
  const context=await browser.newContext({viewport:{width,height},hasTouch:width<=1024})
  const page=await context.newPage()
  page.on('pageerror',e=>failures.push(`${width}: ${e.message}`))
  await page.goto('http://127.0.0.1:5173')
  await page.locator('input[type=email]').fill('admin@acme.test')
  await page.locator('input[type=password]').fill('demo-password-2026')
  await page.locator('button[type=submit]').click()
  await page.locator('.widget-grid').waitFor()
  const routes=['dashboard','people','attendance','leave','payroll','reports','approvals','tasks','announcements','activity','settings','chat','mail','documents','import','bank-files','tax-declarations','notification-settings']
  for(const route of routes) {
   await page.evaluate(route=>{location.hash=`#/${route}`},route)
   await page.waitForTimeout(300)
   if(route==='people') { const href=await page.locator('a[href^="#/people/"]').first().getAttribute('href'); if(href) routes.push(href.replace('#/','')) }
   const report=await page.evaluate(()=>({
    documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,
    width:innerWidth,height:innerHeight,
    mainBottom:document.querySelector('main')!.getBoundingClientRect().bottom,
    scrollTop:document.querySelector('.route-content')?.scrollTop,
    pageRows:document.querySelector('.widget-grid')?.getAttribute('style'),
    pagerBottom:document.querySelector('.widget-pagination')?.getBoundingClientRect().bottom,
   }))
   reports.push({route,...report})
   if(report.documentHeight>height+1 || report.documentWidth>width+1 || report.mainBottom>height+1 || (report.pagerBottom && report.pagerBottom>height+1) || report.scrollTop!==0) failures.push(`${width} ${route}: ${JSON.stringify(report)}`)
   if(route==='dashboard') {
    const seen=new Set<string>()
    for(let n=0;n<20;n++) {
     for(const id of await page.locator('[data-widget-id]').evaluateAll(els=>els.map(e=>e.getAttribute('data-widget-id')!))) seen.add(id)
     const next=page.getByRole('navigation',{name:'Dashboard pages'}).getByRole('button',{name:'Next'})
     if(await next.count() === 0 || await next.isDisabled() || await next.getAttribute('aria-disabled') === 'true') break
     await next.click(); await page.waitForTimeout(80)
    }
    if(seen.size!==14) failures.push(`${width}: only ${seen.size} dashboard widgets reachable`)
    await page.screenshot({path:`docs/ui-checks/viewport-${width}.png`})
   }
  }
  await context.close()
 }
} finally { await browser.close() }
await writeFile('docs/ui-checks/viewport-report.json',JSON.stringify({reports,failures},null,2))
console.log(`${reports.length} screen/viewport checks; ${failures.length} failures`)
failures.forEach(f=>console.log(f))
if(failures.length)process.exitCode=1
