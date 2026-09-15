import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const employee={id:'10000000-0000-0000-0000-000000000001',user_id:'10000000-0000-0000-0000-000000000002',employee_number:'PEPL-001',first_name:'Asha',last_name:'Rao',status:'active',date_of_joining:'2020-04-01'}
const run={id:'10000000-0000-0000-0000-000000000003',label:'September 2026',status:'locked',revision:1,employee_count:1,gross_paise:'10000000',deductions_paise:'1000000',net_paise:'9000000',period_start:'2026-09-01',period_end:'2026-09-30',pay_date:'2026-09-30'}
const workspace={user:{id:employee.user_id,full_name:'Asha Rao',email:'asha@example.test',employeeId:employee.id,scope:'all',roles:['org_admin']},company:'PEPL',today:'2026-09-15',date:'2026-09-15',permissions:['employee.read','employee.write','compensation.read','compensation.write','payroll.read','payroll.process','attendance.read','attendance.correct','settings.write'],modules:{payroll:true,attendance:true},employees:[employee],payroll:[run],periods:[],attendance:[],leaves:[],approvals:[],leaveTypes:[],balances:[],payslips:[{id:'payslip-one',run_id:run.id,employee_id:employee.id,first_name:'Asha',last_name:'Rao',label:run.label,gross_paise:'10000000',deductions_paise:'1000000',net_paise:'9000000'}],tasks:[],announcements:[],notifications:[],activity:[],settings:[]}
const loan={id:'loan-one',kind:'advance',principal_paise:'5000000',annual_interest_pct:'0',instalments:5,instalment_paise:'1000000',starts_on:'2026-09-01',status:'active',total_paise:5000000,repaid_paise:1000000,balance_paise:4000000,instalments_taken:1}
const browser=await chromium.launch({channel:'chrome',headless:true})
try{
 for(const width of [390,1366]){
  const context=await browser.newContext({viewport:{width,height:844},reducedMotion:'reduce'}),page=await context.newPage()
  const errors=[],posts=[];let held=true,profileReads=0
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/api/**',async route=>{
   const req=route.request(),url=new URL(req.url()),path=url.pathname;let json={},status=200
   if(req.method()==='POST'||req.method()==='PATCH')posts.push({path,body:req.postDataJSON()})
   if(path==='/api/ui/workspace')json=workspace
   else if(path===`/api/ui/employees/${employee.id}`){profileReads++;json={employee,assignments:[],compensation:[]}}
   else if(path==='/api/v1/salary/structures')json={structures:[{code:'STD',name:'Standard'}]}
   else if(path==='/api/v1/salary/components')json={components:[]}
   else if(path.includes('/salary/structures/STD/preview'))json={monthlyComponents:{BASIC:5000000,HRA:2000000,SPECIAL:3000000},monthlyTotalPaise:10000000}
   else if(path.endsWith('/compensation')){status=held?202:201;json=held?{held:true,pendingId:'pending-one',approvalRequestId:'approval-one',chain:'manager_then_hr'}:{id:'comp-one'}}
   else if(path==='/api/v1/attendance/corrections'){status=202;json={held:[{pendingId:'pending-two',approvalRequestId:'approval-two',chain:'manager_hr_finance'}]}}
   else if(path===`/api/v1/employees/${employee.id}/loans`)json=req.method()==='GET'?{loans:[loan]}:{loan}
   else if(path==='/api/v1/loans/schedule-preview')json={totalPaise:Number(url.searchParams.get('principalPaise')),instalmentPaise:Math.round(Number(url.searchParams.get('principalPaise'))/Number(url.searchParams.get('instalments')))}
   else if(path.startsWith('/api/v1/loans/'))json={loan}
   else if(path==='/api/v1/statutory/pt-states')json={states:[{code:'TS',name:'Telangana',verifiedOn:'2026-09-01',note:'Verify reference schedule with state authority.',loaded:false,slabs:0,since:null}],exempt:[{code:'DL',name:'Delhi'}]}
   else if(path==='/api/v1/config')json={settings:[{key:'payroll.pt_state_code',module:'payroll',label:'Professional-tax state',help:'The state used for payroll PT',type:'string',value:'TS',changedFromDefault:false,affectsPayroll:true,requiresEffectiveDate:true}]}
   else if(path.startsWith('/api/v1/org/'))json={units:[]}
   else if(path.includes('/filings/'))json={fileName:'filing.csv',contentType:'text/csv',rows:0,totalPaise:'0',omitted:[],contentBase64:'aGVhZGVy'}
   else if(path.endsWith('/lines'))json={lines:[{component_code:'ARREARS',component_type:'earning',amount_paise:'200000',calc_note:null},{component_code:'ARREARS_RECOVERY',component_type:'deduction',amount_paise:'100000',calc_note:null}]}
   await route.fulfill({status,json})
  })
  await page.goto(`http://127.0.0.1:5173/#/people/${employee.id}`)
  await page.getByRole('button',{name:'Compensation',exact:true}).click()
  await page.getByRole('button',{name:'Record salary revision',exact:true}).click()
  await page.getByLabel('Annual CTC (₹)',{exact:true}).fill('1200000')
  await page.getByLabel('Effective from',{exact:true}).fill('2026-08-01')
  await page.getByLabel('Reason for revision',{exact:true}).fill('Annual review')
  await page.getByText('The difference for past months will be paid as arrears in the next payroll.',{exact:true}).waitFor()
  const submit=page.getByRole('button',{name:'Submit revision',exact:true});await submit.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Submit revision'&&!b.disabled))
  const readsBefore=profileReads;await submit.click()
  await page.getByText('Sent for approval → manager then HR',{exact:false}).waitFor()
  assert.equal(profileReads,readsBefore,'Held salary revisions do not refresh as applied')
  assert.deepEqual(posts.at(-1),{path:`/api/v1/employees/${employee.id}/compensation`,body:{annualCtcPaise:120000000,effectiveFrom:'2026-08-01',reason:'Annual review',structureCode:'STD'}})
  await page.screenshot({path:`docs/ui-checks/salary-approval-${width}.png`,animations:'disabled'})
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
  held=false
  await page.getByRole('button',{name:'Record salary revision',exact:true}).click()
  await page.getByLabel('Annual CTC (₹)',{exact:true}).fill('1200000');await page.getByLabel('Reason for revision',{exact:true}).fill('Direct revision')
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='Submit revision'&&!b.disabled));const refreshed=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/ui/employees/${employee.id}`);await page.getByRole('button',{name:'Submit revision',exact:true}).click();await refreshed
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert(profileReads>readsBefore)
  await page.getByRole('button',{name:'Loans',exact:true}).click()
  await page.getByText('1 of 5 instalments taken',{exact:true}).waitFor()
  await page.getByRole('button',{name:'Grant loan / advance',exact:true}).click()
  await page.getByLabel('Principal (₹)',{exact:true}).fill('50000.25')
  await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Grant and start')&&!b.disabled))
  assert.equal(await page.getByLabel('Instalments',{exact:true}).getAttribute('max'),'12')
  await page.getByRole('button',{name:'Grant and start automatic recovery',exact:true}).click()
  await page.waitForFunction(()=>!document.querySelector('[role=dialog]'));assert.equal(posts.at(-1).body.principalPaise,5000025)
  await page.getByRole('button',{name:'Record repayment',exact:true}).click()
  assert.equal(await page.getByLabel('Amount received (₹)',{exact:true}).getAttribute('max'),'40000')
  await page.getByLabel('Amount received (₹)',{exact:true}).fill('1000');await page.getByLabel('Payment reference / note',{exact:true}).fill('NEFT-41')
  await page.getByRole('dialog').getByRole('button',{name:'Record repayment',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
  assert.deepEqual(posts.at(-1),{path:'/api/v1/loans/loan-one/repay',body:{amountPaise:100000,note:'NEFT-41'}})
  await page.getByRole('button',{name:'Close loan',exact:true}).click();await page.getByLabel('Reason',{exact:true}).fill('MD approved write-off')
  await page.getByRole('button',{name:'Confirm closure',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
  assert.deepEqual(posts.at(-1),{path:'/api/v1/loans/loan-one/close',body:{status:'written_off',reason:'MD approved write-off'}})
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
  await page.screenshot({path:`docs/ui-checks/loans-${width}.png`,animations:'disabled'})
  await page.evaluate(()=>location.hash='#/attendance');await page.getByRole('button',{name:'Record correction',exact:true}).click()
  await page.getByRole('dialog').locator('select[name=employeeId]').selectOption(employee.id);await page.getByRole('dialog').locator('select[name=action]').selectOption('mark_present');await page.getByRole('dialog').locator('textarea[name=reason]').fill('Biometric device offline')
  await page.getByRole('dialog').getByRole('button',{name:'Save changes',exact:false}).click();await page.getByText('Sent for approval → manager then HR then finance',{exact:false}).waitFor()
  assert.equal(posts.at(-1).path,'/api/v1/attendance/corrections','Correction must use approval-aware domain route')
  await page.getByRole('dialog').getByRole('button',{name:'Close',exact:true}).click()
  await page.evaluate(()=>location.hash='#/settings');await page.getByRole('button',{name:'Edit',exact:true}).click()
  await page.getByText('No slabs loaded — ask your administrator to run the statutory seed.',{exact:false}).waitFor()
  await page.getByRole('combobox',{name:'Professional-tax state',exact:true}).selectOption('DL');await page.getByText('No professional tax.',{exact:true}).waitFor()
  await page.getByLabel('Reason',{exact:true}).fill('Delhi payroll coverage');await page.getByRole('button',{name:'Save',exact:true}).click()
  assert.equal(posts.at(-1).body.value,'DL')
  await page.evaluate(()=>location.hash='#/organisation');await page.getByRole('button',{name:'Locations',exact:true}).click();await page.getByRole('button',{name:'Add location',exact:true}).click()
  await page.getByLabel('Permanent code',{exact:true}).fill('HYD');await page.getByLabel('Name',{exact:true}).fill('Hyderabad')
  await page.getByRole('combobox',{name:'Professional-tax state',exact:true}).selectOption('TS')
  await page.getByText('No slabs loaded — ask your administrator to run the statutory seed.',{exact:false}).waitFor()
  await page.screenshot({path:`docs/ui-checks/pt-coverage-${width}.png`,animations:'disabled'})
  await page.getByRole('button',{name:'Save unit',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
  assert.equal(posts.at(-1).body.attributes.stateCode,'TS','Location must store selected permanent state code')
  await page.evaluate(()=>location.hash='#/payroll')
  await page.getByRole('button',{name:'Details',exact:true}).click()
  assert.equal(await page.getByRole('dialog').getByText('Arrears',{exact:true}).count(),2)
  assert.deepEqual(errors,[])
  await context.close()
 }
 console.log('Payroll tools passed at 390px and 1366px: held/direct salary revisions, approval-aware corrections, arrears copy/badges, live loan schedules and monetary payloads, repayment/closure, and PT coverage in settings/locations. All mutations intercepted.')
}finally{await browser.close()}
