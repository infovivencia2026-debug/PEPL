import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const employee = { id:'10000000-0000-0000-0000-000000000001',user_id:'10000000-0000-0000-0000-000000000002',employee_number:'PEPL-001',first_name:'Asha',last_name:'Rao',status:'exited',date_of_joining:'2020-04-01',department:'Product',designation:'Designer' }
const run = { id:'10000000-0000-0000-0000-000000000003',label:'September 2026',status:'locked',revision:1,employee_count:1,gross_paise:'10000000',deductions_paise:'1000000',net_paise:'9000000',period_start:'2026-09-01',period_end:'2026-09-30',pay_date:'2026-09-30' }
const workspace = { user:{id:employee.user_id,full_name:'Asha Rao',email:'asha@example.test',employeeId:employee.id,scope:'all',roles:['org_admin']},company:'PEPL',today:'2026-09-15',date:'2026-09-15',permissions:['employee.read','employee.write','compensation.read','compensation.write','payroll.read','payroll.process','roles.write'],modules:{payroll:true},employees:[employee],payroll:[run],periods:[],attendance:[],leaves:[],approvals:[],leaveTypes:[],balances:[],payslips:[],tasks:[],announcements:[],notifications:[],activity:[],settings:[] }
const settlement={gratuity:{eligible:true,yearsCounted:6,amountPaise:100000,computedPaise:100000,note:'Gratuity within statutory ceiling'},encashment:{days:2,amountPaise:20000,byType:[{leaveTypeCode:'EL',days:2,amountPaise:20000}]},notice:{servedDays:20,shortfallDays:10,amountPaise:30000},recoveriesPaise:0,adhoc:[]}
const separation={id:'separation-one',reason:'resignation',last_working_day:'2026-09-30',status:'initiated',settlement:null,settlement_run_id:null}
let eligible=false,forgotLimited=false,finalPreview=false,patched,eraseCalls=0
const browser=await chromium.launch({channel:'chrome',headless:true})
try{
  for(const width of [390,1366]){
    const context=await browser.newContext({viewport:{width,height:844},acceptDownloads:true})
    const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/api/**',async route=>{
      const request=route.request();const path=new URL(request.url()).pathname;let json={};let status=200;let headers={}
      if(path==='/api/ui/workspace')json=workspace
      else if(path===`/api/ui/employees/${employee.id}`)json={employee,assignments:[],compensation:[]}
      else if(path.endsWith('/statutory-ids')){if(request.method()==='PATCH'){patched=request.postDataJSON();json={statutoryIds:{uan:'100123456789',pan:null}}}else json={statutoryIds:null}}
      else if(path.endsWith('/settlement-preview'))json={settlement,final:finalPreview,...(finalPreview?{runId:run.id}:{})}
      else if(path.endsWith('/separation'))json={separation}
      else if(path.includes('/filings/'))json={fileName:'filing.csv',contentType:'text/csv',rows:0,totalPaise:'0',omitted:[{employeeNumber:employee.employee_number,name:'Asha Rao',reason:'PAN missing; employee omitted'}],contentBase64:'aGVhZGVy'}
      else if(path.endsWith('/erasure-eligibility'))json=eligible?{ok:true}:{ok:false,reason:'Statutory retention runs until 2034-10-20'}
      else if(path.endsWith('/erase')){eraseCalls++;json={anonymised:{employees:1}}}
      else if(path.endsWith('/data-export'))json={export:{generatedAt:'2026-09-15',tables:{employees:[employee]},documents:[],messagesAuthored:[]}}
      else if(path==='/api/v1/auth/sessions')json={sessions:[{id:'session-one',issued_at:'2026-09-15',last_seen_at:'2026-09-15',expires_at:'2026-10-15',ip:'127.0.0.1',user_agent:'Browser test',current:true}]}
      else if(path==='/api/v1/auth/change-password')json={sessionsRevoked:2}
      else if(path==='/api/v1/auth/forgot-password'){status=forgotLimited?429:202;json=forgotLimited?{error:{code:'RATE_LIMITED',message:'Too many requests'}}:{accepted:true,ttlMinutes:30};if(forgotLimited)headers={'retry-after':'60'}}
      else if(path==='/api/v1/auth/reset-password'){status=400;json={error:{code:'RESET_TOKEN_INVALID',message:'invalid'}}}
      else if(path==='/api/v1/employees')json={employees:[employee]}
      await route.fulfill({status,json,headers})
    })
    await page.goto('http://127.0.0.1:5173/#/account')
    await page.getByRole('heading',{name:'Account settings'}).waitFor()
    await page.getByLabel('Current password',{exact:true}).fill('current-test-password')
    await page.getByLabel('New password',{exact:true}).fill('new-test-password')
    await page.getByRole('button',{name:'Change password',exact:true}).click()
    await page.getByText('Password changed. 2 other sessions signed out. This session remains active.').waitFor()
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Account must fit horizontally')
    await page.screenshot({path:`docs/ui-checks/lifecycle-account-${width}.png`})
    await page.evaluate(()=>location.hash='#/payroll')
    await page.getByRole('heading',{name:'Statutory filings'}).waitFor()
    await page.getByText('PAN missing; employee omitted').first().waitFor()
    const omission=page.locator('.filing-report').first().locator('.filing-omissions');const download=page.locator('.filing-report').first().getByRole('button')
    assert((await omission.boundingBox()).y<(await download.boundingBox()).y,'Omissions must precede download')
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Filings must fit horizontally')
    await page.evaluate(id=>location.hash=`#/people/${id}`,employee.id)
    await page.getByRole('button',{name:'Private payroll',exact:true}).click()
    await page.getByText('Missing PAN — excluded from 24Q').waitFor()
    await page.getByRole('textbox',{name:'UAN',exact:false}).fill('100123456789')
    await page.getByRole('button',{name:'Save identifiers'}).click()
    assert.deepEqual(patched,{uan:'100123456789'},'Only populated identifier fields are sent')
    await page.getByRole('button',{name:'Exit',exact:true}).click()
    await page.getByRole('button',{name:'View settlement preview'}).click()
    await page.getByText('Live settlement estimate — balances may change').waitFor()
    finalPreview=true
    await page.getByRole('button',{name:'View settlement preview'}).click()
    await page.getByText('Final settlement — fixed at freeze, awaiting lock').waitFor()
    assert.equal(await page.getByRole('link',{name:'View final payroll run'}).getAttribute('href'),`#/payroll/${run.id}`)
    assert.equal(await page.getByRole('button',{name:'Settle',exact:true}).count(),0)
    await page.getByRole('button',{name:'Privacy',exact:true}).click()
    await page.getByText('Statutory retention runs until 2034-10-20').waitFor()
    eligible=true;await page.reload();await page.getByRole('button',{name:'Privacy',exact:true}).click()
    const review=page.getByRole('button',{name:'Review erasure'});await review.waitFor();assert(await review.isDisabled())
    await page.getByLabel('Type the reason for erasure').fill('Data subject request PEPL-41')
    await review.click();await page.getByRole('heading',{name:'Confirm irreversible erasure'}).waitFor()
    assert.equal(eraseCalls,0,'Review must not perform erasure')
    await page.getByRole('button',{name:'Close dialog'}).click()
    const exportDownload=page.waitForEvent('download');await page.getByRole('button',{name:'Download my data'}).click();assert((await exportDownload).suggestedFilename().endsWith('.json'))
    await page.goto('http://127.0.0.1:5173/#/forgot-password');await page.getByLabel('Work email').fill('unknown@example.test');await page.getByRole('button',{name:'Send reset link'}).click();await page.getByText('If that address has an account, a link is on its way.').waitFor()
    forgotLimited=true;await page.reload();await page.getByLabel('Work email').fill('unknown@example.test');await page.getByRole('button',{name:'Send reset link'}).click();await page.getByText('Too many requests. Wait 60 seconds.').waitFor()
    await page.goto('http://127.0.0.1:5173/reset-password?token=invalid');await page.getByLabel('New password').fill('new-test-password');await page.getByRole('button',{name:'Reset password',exact:true}).click();await page.getByText('This reset link is invalid or has expired. Request a new link.').waitFor()
    assert.deepEqual(errors,[])
    await context.close();eligible=false;forgotLimited=false;finalPreview=false
  }
  console.log('Lifecycle browser checks passed at 390px and 1366px: omission-first filings, private IDs, exit preview, typed erasure review, JSON export, account change, and password recovery. All mutations intercepted; no erasure performed.')
}finally{await browser.close()}
