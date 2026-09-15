import { chromium } from 'playwright-core'
import assert from 'node:assert/strict'

const employee = { id:'10000000-0000-0000-0000-000000000001', user_id:'10000000-0000-0000-0000-000000000002', employee_number:'PEPL-001', first_name:'Asha', last_name:'Rao', status:'active', date_of_joining:'2020-04-01', department:'Sales', designation:'Designer' }
const run = { id:'10000000-0000-0000-0000-000000000003', period_id:'10000000-0000-0000-0000-000000000004', label:'September 2026', status:'draft', revision:1, employee_count:0, gross_paise:'0', deductions_paise:'0', net_paise:'0', period_start:'2026-09-01', period_end:'2026-09-30', pay_date:'2026-09-30' }
const department = { id:'department-one',code:'SALES',name:'Sales',parent_id:null,status:'active',sort_order:0,attributes:{costCentre:'CC-10'},inUseBy:3 }
const workspace = { user:{id:employee.user_id,full_name:'Asha Rao',email:'asha@example.test',employeeId:employee.id,scope:'all',roles:['org_admin']},company:'PEPL',today:'2026-09-15',date:'2026-09-15',permissions:['employee.read','employee.write','compensation.read','compensation.write','payroll.read','payroll.process','settings.write'],modules:{payroll:true,attendance:true},employees:[employee],payroll:[run],periods:[],attendance:[],leaves:[],approvals:[],leaveTypes:[],balances:[],payslips:[],tasks:[],announcements:[],notifications:[],activity:[],settings:[] }
const summary = { employeeId:employee.id,employeeNumber:'PEPL-001',name:'Asha Rao',calendarDays:30,payableDays:28,lopDays:2,paidLeaveDays:1,unmarkedDays:2,lateMarks:3,lateHalfDays:0.5,otMinutes:120,joinedMidPeriod:false,exitedMidPeriod:false,warnings:['2 unmarked days need review'],row:{annualCtcPaise:'120000000'} }
const browser = await chromium.launch({channel:'chrome',headless:true})
try {
  for (const width of [390,1366]) {
    const context = await browser.newContext({viewport:{width,height:844}}), page = await context.newPage()
    let frozen, assignment, retired=0, pickerError=false
    const errors=[]; page.on('pageerror',error=>errors.push(error.message))
    await page.route('**/api/**',async route=>{
      const request=route.request(),url=new URL(request.url()),path=url.pathname;let json={},status=200
      if(path==='/api/ui/workspace')json=workspace
      else if(path.startsWith('/api/v1/org/')) {
        if(path.endsWith('/retire')) { retired++; json={inUseBy:3} }
        else if(pickerError&&!url.search) { status=503;json={error:{code:'UNAVAILABLE',message:'Organisation unavailable'}} }
        else json={units:path.includes('/department')?[department]:[]}
      }
      else if(path===`/api/ui/employees/${employee.id}`)json={employee,assignments:[{department:'Sales',designation:'Designer',effective_from:'2020-04-01',effective_to:null}],compensation:[]}
      else if(path.endsWith('/assignments')) { assignment=request.postDataJSON();json={saved:true} }
      else if(path===`/api/v1/payroll/runs/${run.id}`)json={run}
      else if(path==='/api/v1/attendance/summary') { assert.equal(url.searchParams.get('periodId'),run.period_id);json={period:run,employees:[summary,{...summary,employeeId:'missing-comp',employeeNumber:'PEPL-002',name:'No Salary',row:null,warnings:['no salary structure in force']}]}}
      else if(path.endsWith('/freeze-from-attendance')) { frozen=request.postDataJSON();json={frozen:1,skipped:1,overridden:1,warnings:[]} }
      await route.fulfill({status,json})
    })
    await page.goto('http://127.0.0.1:5173/#/organisation')
    await page.getByRole('heading',{name:'Organisation',exact:true}).waitFor()
    await page.getByRole('button',{name:'Retire',exact:true}).click()
    await page.getByText('3 existing assignments use this unit.',{exact:false}).waitFor()
    assert.equal(retired,0,'Opening retirement confirmation must not retire')
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.getByRole('button',{name:'Add department',exact:true}).click()
    await page.getByLabel('Permanent code').fill('NORTH')
    await page.getByLabel('Department head').selectOption(employee.user_id)
    await page.screenshot({path:`docs/ui-checks/organisation-${width}.png`,animations:'disabled'})
    await page.getByRole('button',{name:'Cancel',exact:true}).click()
    await page.evaluate(id=>location.hash=`#/people/${id}`,employee.id)
    await page.getByRole('button',{name:'Change assignment',exact:true}).click()
    const dialog=page.getByRole('dialog')
    await dialog.getByRole('combobox',{name:'Department',exact:false}).waitFor()
    assert.equal(await dialog.locator('select[name=department]').inputValue(),'SALES','Legacy names select their permanent code')
    assert.equal(await dialog.locator('input[name=designation]').inputValue(),'Designer','Empty designation master retains free text')
    await dialog.locator('textarea[name=reason]').fill('Transfer review')
    await dialog.getByRole('button',{name:'Save changes',exact:false}).click()
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
    assert.equal(assignment.department,'SALES')
    pickerError=true
    await page.getByRole('button',{name:'Change assignment',exact:true}).click()
    await page.getByText('Organisation unavailable',{exact:true}).waitFor()
    assert(await page.getByRole('dialog').getByRole('button',{name:'Save changes',exact:false}).isDisabled(),'Picker failure blocks free-text bypass')
    await page.getByRole('button',{name:'Close dialog'}).click();pickerError=false
    await page.evaluate(()=>location.hash='#/payroll')
    await page.getByRole('button',{name:'Review inputs',exact:true}).click()
    await page.getByText('2 unmarked days need review',{exact:true}).waitFor()
    assert(await page.getByRole('link',{name:'Configure compensation',exact:true}).isVisible())
    await page.getByLabel('Payable days for Asha Rao',{exact:true}).fill('29')
    await page.getByRole('button',{name:'Freeze reviewed inputs',exact:true}).click()
    await page.getByText('Payable days and loss of pay cannot exceed calendar days.',{exact:false}).waitFor()
    assert.equal(frozen,undefined,'Invalid overrides must not submit')
    await page.getByLabel('Loss of pay days for Asha Rao',{exact:true}).fill('1')
    await page.locator('.attendance-freeze').evaluate(element => { element.scrollLeft = 0 })
    await page.screenshot({path:`docs/ui-checks/attendance-freeze-${width}.png`,animations:'disabled'})
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Screen must not overflow horizontally')
    await page.getByRole('button',{name:'Freeze reviewed inputs',exact:true}).click()
    await page.waitForFunction(()=>!document.querySelector('[role=dialog]'))
    assert.deepEqual(frozen,{skipEmployeeIds:['missing-comp'],overrides:[{employeeId:employee.id,payableDays:29,lopDays:1}]})
    assert.deepEqual(errors,[])
    await context.close()
  }
  console.log('Masters and attendance review passed at 390px and 1366px: independent pickers, code selection, failure blocking, retirement review, warnings, skips, and exception-only freeze. All mutations intercepted.')
} finally { await browser.close() }
