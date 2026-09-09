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
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUser } from '../src/auth/index.ts'
import { changeAssignment, changeCompensation } from '../src/people/history.ts'
import { appendEntry, accrueMonthly } from '../src/leave/ledger.ts'
import { recordPunch, recomputeDay } from '../src/attendance/index.ts'

const COMPANY = 'Acme Manufacturing Pvt Ltd'
const PASSWORD = 'demo-password-2026'
const L = (rupees: number): number => rupees * 100

interface Person {
  number: string
  first: string
  last: string
  email: string
  role: string
  department: string
  designation: string
  ctc: number
  basic: number
  hra: number
  special: number
  isManager?: boolean
}

const PEOPLE: Person[] = [
  { number: 'ACM-001', first: 'Priya', last: 'Sharma', email: 'priya@acme.test', role: 'hr_admin',
    department: 'Human Resources', designation: 'HR Manager',
    ctc: 900_000, basic: 30_000, hra: 15_000, special: 30_000 },
  { number: 'ACM-002', first: 'Anil', last: 'Verma', email: 'anil@acme.test', role: 'payroll_admin',
    department: 'Finance', designation: 'Payroll Officer',
    ctc: 780_000, basic: 26_000, hra: 13_000, special: 26_000 },
  { number: 'ACM-003', first: 'Arjun', last: 'Rao', email: 'arjun@acme.test', role: 'manager',
    department: 'Engineering', designation: 'Engineering Manager', isManager: true,
    ctc: 1_800_000, basic: 60_000, hra: 30_000, special: 60_000 },
  { number: 'ACM-004', first: 'Rahul', last: 'Nair', email: 'rahul@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Senior Developer',
    ctc: 1_200_000, basic: 40_000, hra: 20_000, special: 40_000 },
  { number: 'ACM-005', first: 'Sneha', last: 'Iyer', email: 'sneha@acme.test', role: 'employee',
    department: 'Engineering', designation: 'Developer',
    ctc: 840_000, basic: 28_000, hra: 14_000, special: 28_000 },
  { number: 'ACM-006', first: 'Vikram', last: 'Singh', email: 'vikram@acme.test', role: 'employee',
    department: 'Production', designation: 'Machine Operator',
    ctc: 300_000, basic: 12_000, hra: 6_000, special: 7_000 },
  { number: 'ACM-007', first: 'Meera', last: 'Das', email: 'meera@acme.test', role: 'employee',
    department: 'Production', designation: 'Quality Inspector',
    ctc: 360_000, basic: 14_000, hra: 7_000, special: 9_000 },
  { number: 'ACM-008', first: 'Kavya', last: 'Reddy', email: 'kavya@acme.test', role: 'employee',
    department: 'Sales', designation: 'Sales Executive',
    ctc: 600_000, basic: 20_000, hra: 10_000, special: 20_000 },
]

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
async function purgeTenant(tenantId: string): Promise<void> {
  const client = await controlDb.connect()
  try {
    // BASE TABLES only: views such as current_employee_profile also expose a
    // tenant_id column, and DELETE against one fails at rewrite time.
    const { rows: tables } = await client.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND a.attname = 'tenant_id' AND NOT a.attisdropped`)

    await client.query('BEGIN')
    await client.query(`SET LOCAL session_replication_role = replica`)
    for (const t of tables) {
      await client.query(`DELETE FROM "${t.table_name}" WHERE tenant_id = $1`, [tenantId])
    }
    await client.query(`DELETE FROM control_plane.subscriptions WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM control_plane.provisioning_jobs WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM control_plane.support_access_grants WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM control_plane.platform_audit WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM control_plane.audit_seals WHERE tenant_id = $1`, [tenantId])
    await client.query(`DELETE FROM tenants WHERE id = $1`, [tenantId])
    await client.query('COMMIT')
    console.log(`purged previous demo tenant ${tenantId}`)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

async function main(): Promise<void> {
  // Replace any previous demo tenant so re-running is safe.
  const existing = await controlDb.query<{ id: string }>(
    `SELECT id FROM tenants WHERE legal_name = $1`, [COMPANY])
  for (const t of existing.rows) await purgeTenant(t.id)

  const { tenantId } = await provisionTenant({
    legalName: COMPANY,
    displayName: 'Acme',
    planCode: 'professional',
    adminEmail: 'admin@acme.test',
    adminName: 'Acme Administrator',
  })
  console.log(`tenant ${tenantId}`)

  // Statutory reference data (global) — payroll cannot run without it.
  await controlDb.query(
    `INSERT INTO statutory_configs
       (effective_from, pf_employee_rate, pf_employer_rate, pf_wage_ceiling_paise,
        esi_employee_rate, esi_employer_rate, esi_gross_threshold_paise, notes)
     VALUES (DATE '2026-04-01', 0.12, 0.12, $1, 0.0075, 0.0325, $2, 'demo seed')
     ON CONFLICT (effective_from) DO NOTHING`,
    [String(L(15_000)), String(L(21_000))])

  for (const [from, to, amount] of [
    [0, L(15_000), 0], [L(15_000), L(20_000), L(150)], [L(20_000), null, L(200)],
  ] as const) {
    await controlDb.query(
      `INSERT INTO pt_slabs (state_code, effective_from, gross_from_paise, gross_to_paise, amount_paise)
       VALUES ('TS', DATE '2026-04-01', $1, $2, $3)`,
      [String(from), to === null ? null : String(to), String(amount)])
  }

  const ids: Record<string, string> = {}

  await withTenant(tenantId, async (tx) => {
    // admin login
    await createUser(tx, {
      tenantId, email: 'admin@acme.test', fullName: 'Acme Administrator',
      password: PASSWORD, roles: ['org_admin'],
    })

    for (const p of PEOPLE) {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining)
         VALUES ($1,$2,$3,$4, DATE '2025-06-01') RETURNING id`,
        [tenantId, p.number, p.first, p.last])
      ids[p.number] = rows[0]!.id

      await createUser(tx, {
        tenantId, email: p.email, fullName: `${p.first} ${p.last}`,
        password: PASSWORD, roles: [p.role], employeeId: rows[0]!.id,
      })
    }

    const managerId = ids['ACM-003']!

    for (const p of PEOPLE) {
      const employeeId = ids[p.number]!
      await tx.query(
        `INSERT INTO employee_assignments
           (tenant_id, employee_id, department, designation, manager_employee_id,
            location, employment_type, effective_from, change_reason)
         VALUES ($1,$2,$3,$4,$5,'Hyderabad','full_time', DATE '2025-06-01', 'initial assignment')`,
        [tenantId, employeeId, p.department, p.designation,
         p.isManager || p.role === 'hr_admin' ? null : managerId])

      await changeCompensation(tx, {
        employeeId, annualCtcPaise: L(p.ctc),
        components: { basic: L(p.basic), hra: L(p.hra), special: L(p.special) },
        effectiveFrom: '2025-06-01', reason: 'offer',
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
          localDate: date, direction: 'in', source: 'mobile', withinGeofence: true,
          clientPunchId: `seed-${p.number}-${date}-in`,
        })
        await recordPunch(tx, {
          employeeId: ids[p.number]!, punchedAt: `${date}T18:30:00Z`,
          localDate: date, direction: 'out', source: 'mobile', withinGeofence: true,
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

    // An announcement awaiting acknowledgement.
    await tx.query(
      `INSERT INTO announcements (tenant_id, title, body_html, requires_acknowledgement, status)
       VALUES ($1, 'Updated leave policy, effective 1 October',
               '<p>Earned leave carry-forward is capped at 15 days from the new cycle.</p>',
               true, 'draft')`,
      [tenantId])
  }, { userId: undefined })

  console.log(`
Demo tenant seeded.

  Company    ${COMPANY}
  Employees  ${PEOPLE.length}
  Password   ${PASSWORD}   (every account)

  admin@acme.test    org_admin       sees everything
  priya@acme.test    hr_admin        people, attendance, leave — NOT salary
  anil@acme.test     payroll_admin   payroll and compensation
  arjun@acme.test    manager         his own reports only
  rahul@acme.test    employee        his own record only

  API:  npm run api      -> http://localhost:4010
  Docs: npm run openapi  -> openapi.json
`)
  await closePools()
  await controlDb.end()
}

main().catch((e) => { console.error(e); process.exit(1) })
