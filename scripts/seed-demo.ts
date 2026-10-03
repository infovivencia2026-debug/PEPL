/**
 * Demo tenant: a realistic small Indian company, so a UI can be built against
 * data that behaves like the real thing rather than three rows of lorem ipsum.
 *
 *   npm run seed:demo
 *
 * Idempotent by company name: re-running replaces the demo tenant rather than
 * accumulating copies.
 */
import { controlDb, provisionTenant } from '../src/control-plane/index.ts'
import { updateBillingDetails } from '../src/control-plane/billing.ts'
import { purgeTenant } from '../src/control-plane/sandbox.ts'
import { demoSeedRefusal } from '../src/control-plane/demo-guard.ts'
import { setSetting } from '../src/config/write.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeAssignment, changeCompensation } from '../src/people/history.ts'
import { appendEntry, accrueMonthly } from '../src/leave/ledger.ts'
import { applyLeave } from '../src/leave/apply.ts'
import { recognise, upsertCourse, nominateMandatory, listNominations, completeCourse } from '../src/people/learning.ts'
import { resolveConfig } from '../src/config/resolver.ts'
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'
import { PEOPLE } from './demo-roster.ts'
import { leaveRange } from './demo-dates.ts'
import { seedDocuments, seedAssets, seedRecruitment, seedPerformance, seedExpenses, runAugustPayroll } from './demo-operations.ts'

/**
 * PEPL_DEMO_SUFFIX gives a salesperson their own copy. Two reps demoing at the
 * same time share one tenant otherwise, and the first one to approve a leave
 * request changes what the second one is presenting. The suffix lands in the
 * company name and in every login as a plus-address, which keeps each account
 * unique — signup resolves an email across all tenants and refuses a duplicate.
 *
 *   PEPL_DEMO_SUFFIX=ravi npm run seed:demo   ->  admin+ravi@acme.test
 */
const SUFFIX = (process.env.PEPL_DEMO_SUFFIX ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '')
const COMPANY = SUFFIX
  ? `Acme Manufacturing Pvt Ltd (${SUFFIX})`
  : 'Acme Manufacturing Pvt Ltd'
const PASSWORD = 'demo-password-2026'
/** priya@acme.test -> priya+ravi@acme.test */
const mail = (address: string): string =>
  SUFFIX ? address.replace('@', `+${SUFFIX}@`) : address
const L = (rupees: number): number => rupees * 100


/**
 * Deletes every row belonging to one tenant, across every table that carries a
 * tenant_id. Foreign keys between those tables form a graph with no safe single
 * ordering, so replication_role suspends the FK triggers for the duration —
 * a superuser admin operation, used here only to make the demo seed re-runnable.
 *
 * This is a DEVELOPMENT convenience. Production tenant deletion is the
 * control-plane purge described in platform-control-plane.md §6, which honours
 * statutory retention and is two-person approved.
 */
async function main(): Promise<void> {
  // FIRST, before any query: this replaces tenants by name and plants a known password.
  const refusal = demoSeedRefusal(process.env)
  if (refusal) {
    console.error(`Refusing to seed the demo company: ${refusal}.`)
    process.exit(1)
  }

  // Replace any previous demo tenant so re-running is safe.
  const existing = await controlDb.query<{ id: string }>(
    `SELECT id FROM tenants WHERE legal_name = $1`, [COMPANY])
  for (const t of existing.rows) await purgeTenant(t.id)

  const { tenantId } = await provisionTenant({
    legalName: COMPANY,
    displayName: 'Acme',
    planCode: 'enterprise',
    adminEmail: mail('admin@acme.test'),
    adminName: 'Acme Administrator',
    // PEPL_DEMO_TYPE=manufacturing (or education, field_sales, retail, agency) seeds that organisation type's preset
    organisationType: process.env.PEPL_DEMO_TYPE ?? 'office',
  })
  console.log(`tenant ${tenantId}`)

  // Billing details, so a demo can show a real GST invoice. The place of supply
  // is what decides CGST+SGST against IGST; without it the demo's own invoice
  // would print IGST for a Hyderabad company billed from Hyderabad.
  await updateBillingDetails(tenantId, {
    gstin: '36AAACA1111A1Z5',
    address: 'Plot 21, Jeedimetla Industrial Area, Hyderabad 500055',
    email: mail('accounts@acme.test'),
    stateCode: 'TS',
  })

  // Statutory reference data (global) — payroll cannot run without it.
  await controlDb.query(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise, notes)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2, 'demo seed')
     ON CONFLICT (effective_from) DO NOTHING`,
    [String(L(15_000)), String(L(21_000))])

  // Reference data is ADDED when absent and never replaced: `npm run seed:statutory` owns
  // it, every customer's payroll reads it, and this used to insert duplicate slabs on each
  // run and delete the tax tables outright.
  const hasSlabs = (await controlDb.query(`SELECT 1 FROM pt_slabs WHERE state_code = 'TS' AND effective_from = DATE '2026-04-01' LIMIT 1`)).rowCount
  if (!hasSlabs) for (const [from, to, amount] of [
    [0, L(15_000), 0], [L(15_000), L(20_000), L(150)], [L(20_000), null, L(200)],
  ] as const) {
    await controlDb.query(
      `INSERT INTO pt_slabs (state_code, effective_from, gross_from_paise, gross_to_paise, amount_paise)
       VALUES ('TS', DATE '2026-04-01', $1, $2, $3)`,
      [String(from), to === null ? null : String(to), String(amount)])
  }

  // Income tax reference data. REPRESENTATIVE FIGURES: reconcile against the
  // Finance Act in force before paying anyone. They live as data precisely so a
  // compliance owner can correct them without a deploy.
  const hasTax = (await controlDb.query(`SELECT 1 FROM tax_slabs WHERE fiscal_year = '2026-27' LIMIT 1`)).rowCount
    && (await controlDb.query(`SELECT 1 FROM tax_rules WHERE fiscal_year = '2026-27' LIMIT 1`)).rowCount
  if (!hasTax) {
    const newRegime: [number, number | null, number][] = [
      [0, 400_000, 0], [400_000, 800_000, 0.05], [800_000, 1_200_000, 0.10],
      [1_200_000, 1_600_000, 0.15], [1_600_000, 2_000_000, 0.20],
      [2_000_000, 2_400_000, 0.25], [2_400_000, null, 0.30],
    ]
    const oldRegime: [number, number | null, number][] = [
      [0, 250_000, 0], [250_000, 500_000, 0.05], [500_000, 1_000_000, 0.20],
      [1_000_000, null, 0.30],
    ]
    for (const [regime, rows] of [['new', newRegime], ['old', oldRegime]] as const) {
      for (const [from, to, rate] of rows) {
        await controlDb.query(
          `INSERT INTO tax_slabs (regime, fiscal_year, income_from_paise, income_to_paise, rate)
           VALUES ($1, '2026-27', $2, $3, $4)`,
          [regime, String(L(from)), to === null ? null : String(L(to)), rate])
      }
    }
    const surcharge = JSON.stringify([
      { above_paise: L(5_000_000), rate: 0.10 },
      { above_paise: L(10_000_000), rate: 0.15 },
    ])
    await controlDb.query(
      `INSERT INTO tax_rules
         (regime, fiscal_year, standard_deduction_paise, rebate_limit_paise, rebate_max_paise, cess_rate, surcharge_bands)
       VALUES ('new','2026-27',$1,$2,$3,0.04,$4::jsonb),
              ('old','2026-27',$5,$6,$7,0.04,$4::jsonb)`,
      [String(L(75_000)), String(L(1_200_000)), String(L(60_000)), surcharge,
       String(L(50_000)), String(L(500_000)), String(L(12_500))])
  }

  const ids: Record<string, string> = {}
  const userIds: Record<string, string> = {}

  const counts: Record<string, number> = {}
  await withTenant(tenantId, async (tx) => {
    // admin login
    const adminUserId = await createUser(tx, {
      tenantId, email: mail('admin@acme.test'), fullName: 'Acme Administrator',
      password: PASSWORD, roles: ['org_admin'],
    })

    // Chat and mail are off by default for a real company; the demo turns them
    // on so the whole product is visible without hunting through settings.
    for (const key of ['chat.enabled', 'mail.enabled', 'helpdesk.enabled', 'attendance.qr_punch_enabled']) {
      await setSetting(tx, {
        key, value: true,
        actorUserId: adminUserId, reason: 'demo tenant shows every module',
      })
    }

    for (const p of PEOPLE) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1,$2,$3,$4, $5::date) RETURNING id`,
        [tenantId, p.number, p.first, p.last, p.joinedOn])
      ids[p.number] = rows[0]!.id

      userIds[p.number] = await createUser(tx, {
        tenantId, email: mail(p.email), fullName: `${p.first} ${p.last}`,
        password: PASSWORD, roles: [p.role], employeeId: rows[0]!.id,
      })
    }

    for (const p of PEOPLE) {
      const employeeId = ids[p.number]!
      await tx.query(
        `INSERT INTO employee_assignments
           (tenant_id, employee_id, department, designation, manager_employee_id,
            location, employment_type, effective_from, change_reason)
         VALUES ($1,$2,$3,$4,$5,$6,'full_time', $7::date, 'initial assignment')`,
        [tenantId, employeeId, p.department, p.designation,
         p.manager ? ids[p.manager] ?? null : null, p.location, p.joinedOn])

      await changeCompensation(tx, {
        employeeId, annualCtcPaise: L(p.ctc),
        components: { basic: L(p.basic), hra: L(p.hra), special: L(p.special) },
        effectiveFrom: p.joinedOn, reason: 'offer',
      })
    }

    // A promotion, so the timeline shows a progression rather than one flat row.
    await changeAssignment(tx, {
      employeeId: ids['ACM-004']!, department: 'Engineering', designation: 'Lead Developer',
      effectiveFrom: '2026-04-01', reason: 'promotion at annual review',
    })
    await changeCompensation(tx, {
      employeeId: ids['ACM-004']!, annualCtcPaise: L(1_500_000),
      components: { basic: L(50_000), hra: L(25_000), special: L(50_000) },
      effectiveFrom: '2026-04-01', reason: 'promotion increment',
    })

    // Leave: opening balances and accruals to date.
    const { rows: types } = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM leave_types WHERE code IN ('EL','CL','SL')`)
    for (const p of PEOPLE) {
      for (const t of types) {
        await appendEntry(tx, {
          employeeId: ids[p.number]!, leaveTypeId: t.id, entryType: 'opening',
          deltaDays: t.code === 'EL' ? 6 : t.code === 'CL' ? 3 : 2,
          effectiveDate: '2026-04-01', cycleYear: 2026, note: 'carried into the new cycle',
        })
        if (t.code === 'EL') {
          for (const m of ['04', '05', '06', '07', '08']) {
            await accrueMonthly(tx, {
              employeeId: ids[p.number]!, leaveTypeId: t.id, cycleYear: 2026,
              period: `2026-${m}`, units: 1.5, effectiveDate: `2026-${m}-28`,
            })
          }
        }
      }
    }

    // Attendance periods and a fortnight of punches.
    for (const [start, end, status] of [
      ['2026-08-01', '2026-08-31', 'frozen'],
      ['2026-09-01', '2026-09-30', 'open'],
    ] as const) {
      await tx.query(
        `INSERT INTO attendance_periods (tenant_id, period_start, period_end, status)
         VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id, period_start) DO NOTHING`,
        [tenantId, start, end, status])
    }

    for (let day = 1; day <= 14; day++) {
      const date = `2026-09-${String(day).padStart(2, '0')}`
      const dow = new Date(`${date}T00:00:00Z`).getUTCDay()
      if (dow === 0) continue // six-day week: Sunday off
      for (const p of PEOPLE) {
        await recordPunch(tx, {
          employeeId: ids[p.number]!, punchedAt: `${date}T09:${day % 20 < 10 ? '2' : '4'}5:00Z`,
          localDate: date, direction: 'in', source: 'mobile',
          clientPunchId: `seed-${p.number}-${date}-in`,
        })
        await recordPunch(tx, {
          employeeId: ids[p.number]!, punchedAt: `${date}T18:30:00Z`,
          localDate: date, direction: 'out', source: 'mobile',
          clientPunchId: `seed-${p.number}-${date}-out`,
        })
        await recomputeDay(tx, ids[p.number]!, date)
      }
    }

    // A payroll period ready to run.
    await tx.query(
      `INSERT INTO payroll_periods (tenant_id, label, period_start, period_end, pay_date)
       VALUES ($1,'2026-09',DATE '2026-09-01',DATE '2026-09-30',DATE '2026-10-01')
       ON CONFLICT (tenant_id, label) DO NOTHING`,
      [tenantId])

    // A mandatory course, nominated to everyone, with two people already done.
    await upsertCourse(tx, { code: 'POSH_AWARENESS', title: 'POSH awareness', description: 'What the law requires of every workplace, and how to raise a complaint safely.', mode: 'online', mandatory: true, validityMonths: 12, dueDays: 30 })
    await nominateMandatory(tx)
    for (const num of ['ACM-001', 'ACM-003'] as const) {
      const nom = (await listNominations(tx, { employeeId: ids[num]!, courseCode: 'POSH_AWARENESS' }))[0]
      if (nom) await completeCourse(tx, { nominationId: nom.id, byTrainer: true, score: 90, actorUserId: adminUserId })
    }

    // A couple of recognitions so the wall is not empty in the demo.
    for (const [from, to, badge, note] of [
      ['ACM-003', 'ACM-004', 'TEAM_PLAYER', 'Covered the release weekend without being asked.'],
      ['ACM-001', 'ACM-006', 'CUSTOMER_HERO', 'Turned an angry customer into a referral.'],
    ] as const) {
      await recognise(tx, { badgeCode: badge, toEmployeeId: ids[to]!, fromUserId: userIds[from]!, fromEmployeeId: ids[from]!, isManager: true, message: note })
    }

    // Pending approvals so the manager's inbox has something to decide — one from
    // each of the team, and one from the manager himself, which routes to HR.
    const cfg = await resolveConfig(tx, tenantId)
    const el = types.find((t) => t.code === 'EL')!
    const todayIso = new Date().toISOString().slice(0, 10)
    for (const [num, from, to, reason] of [
      ['ACM-004', 21, 23, 'Family wedding in Kochi'],
      ['ACM-005', 28, 28, 'Passport appointment'],
      ['ACM-003', 35, 39, 'Annual trip — team briefed'],
    ] as const) {
      await applyLeave(tx, cfg, { employeeId: ids[num]!, requestedByUserId: userIds[num]!, leaveTypeId: el.id, ...leaveRange(todayIso, from, to), reason })
    }

    // Everything a prospect asks to see beyond the directory: files, assets, a
    // hiring pipeline, a review cycle, claims awaiting a decision, and August's
    // payroll run taken all the way to locked.
    const demo = { tx, tenantId, ids, userIds, adminUserId, cfg }
    counts.documents = await seedDocuments(demo)
    counts.assets = await seedAssets(demo)
    counts.candidates = await seedRecruitment(demo)
    counts.appraisals = await seedPerformance(demo)
    counts.claims = await seedExpenses(demo)
    const payroll = await runAugustPayroll(demo)
    counts.payslips = payroll.employees

    // A site, so the kiosk has a code to show and geofenced punches have a fence.
    await tx.query(
      `INSERT INTO geofence_sites (tenant_id, code, name, lat, lng, radius_m, applies_to_all)
       VALUES ($1, 'HYD-HQ', 'Hyderabad HQ', 17.4435, 78.3772, 150, true) ON CONFLICT DO NOTHING`,
      [tenantId])

    // An announcement awaiting acknowledgement.
    await tx.query(
      `INSERT INTO announcements (tenant_id, title, body_html, requires_acknowledgement, status)
       VALUES ($1, 'Updated leave policy, effective 1 October',
               '<p>Earned leave carry-forward is capped at 15 days from the new cycle.</p>',
               true, 'draft')`,
      [tenantId])
  }, { userId: undefined })

  // A plus-addressed login is longer than the base one.
  const width = SUFFIX ? 30 : 22
  const rows: [string, string, string][] = [
    ['admin@acme.test', 'org_admin', 'Everything, including settings and roles'],
    ['priya@acme.test', 'hr_admin', 'People, attendance, leave, tickets — NOT salary'],
    ['anil@acme.test', 'payroll_admin', 'Payroll, compensation, bank export'],
    ['finance@acme.test', 'finance', 'Payroll read, bank export, approvals'],
    ['arjun@acme.test', 'manager', 'His own reports only — no compensation'],
    ['rahul@acme.test', 'employee', 'His own record only'],
    ['auditor@acme.test', 'auditor', 'Read-only across the company, incl. the log'],
  ]

  const table = rows
    .map(([e, r, d]) => `  ${mail(e).padEnd(width)}${r.padEnd(16)}${d}`)
    .join('\n')

  console.log(`
Demo tenant seeded into "${process.env.PEPL_DB ?? 'pepl_dev'}".

  Company    ${COMPANY}
  Employees  ${PEOPLE.length} across 6 departments and 3 locations
  On file    ${counts.documents} documents · ${counts.assets} assets · ${counts.candidates} candidates
             ${counts.appraisals} appraisals · ${counts.claims} expense claims
  Payroll    August 2026 run LOCKED — ${counts.payslips} payslips, processed by
             anil@acme.test and approved by finance@acme.test (never the same person)
  Password   ${PASSWORD}      <- the same for every account below

  ${'EMAIL'.padEnd(width)}${'ROLE'.padEnd(16)}SEES
  ${'-'.repeat(width + 16 + 44)}
${table}

  Sign in at http://127.0.0.1:3100  (npm start), or http://127.0.0.1:5173 (npm run dev).

  NOTE: \`npm test\` owns a SEPARATE database (pepl_test) and cannot wipe this one.
`)
  await closePools()
  await controlDb.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
