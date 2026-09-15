import { chromium } from 'playwright-core'
const browser=await chromium.launch({channel:'chrome',headless:true})
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}})
 await page.goto('http://127.0.0.1:5173')
 await page.locator('input[type=email]').fill('admin@acme.test');await page.locator('input[type=password]').fill('demo-password-2026');await page.locator('button[type=submit]').click();await page.locator('.widget-grid').waitFor()
 for(const route of ['chat','mail']){await page.evaluate(r=>location.hash='#/'+r,route);await page.locator('.comms-empty h2').waitFor();await page.waitForTimeout(600);await page.screenshot({path:`docs/ui-checks/${route}-setup.png`})}
 let sent=false
 await page.route('**/api/v1/mail/**',async route=>{const url=route.request().url();let result={};if(url.includes('/folders'))result={folders:[{id:'inbox',name:'Inbox',role:'inbox',unread:0}]};else if(route.request().method()==='POST'){sent=true;result={id:'draft'}}else result={envelopes:[]};await route.fulfill({json:result})})
 await page.reload();await page.getByRole('button',{name:'Compose mail'}).click();await page.getByLabel('To',{exact:true}).fill('colleague@example.test');await page.getByLabel('Subject',{exact:true}).fill('UI test only');await page.getByLabel('Message',{exact:true}).fill('This request is intercepted locally.');await page.getByRole('button',{name:'Save draft'}).click();await page.getByRole('status').filter({hasText:'Draft saved.'}).waitFor();if(!sent)throw Error('Draft request not submitted')
 console.log('Chat and mailbox setup screens rendered; compose and draft flow passed with intercepted API. No messages sent.')
}finally{await browser.close()}
