import pg from 'pg'
import { config } from '../src/config.ts'
import { withTenant } from '../src/db/tenant-tx.ts'

/** Provisioning is a CONTROL-PLANE operation, modelled here with the superuser. */
export const controlPool = new pg.Pool({
  host: config.host,
  port: config.port,
  database: config.db,
  user: config.superUser,
  password: config.superPassword,
})

export type Tenant = {
  id: string
  employeeId: string
  employeeNumber: string
  lastName: string
}

export async function resetAndSeed(): Promise<{ a: Tenant; b: Tenant }> {
  await controlPool.query('TRUNCATE employee_assignments, employees, app_users, tenants CASCADE')
  const a = await provision('Alpha Technologies Pvt Ltd', 'Alpha', 'A-001', 'Sharma')
  const b = await provision('Beta Manufacturing Pvt Ltd', 'Beta', 'B-001', 'Iyer')
  return { a, b }
}

async function provision(
  legal: string,
  display: string,
  num: string,
  lastName: string,
): Promise<Tenant> {
  const { rows } = await controlPool.query<{ id: string }>(
    'INSERT INTO tenants (legal_name, display_name) VALUES ($1, $2) RETURNING id',
    [legal, display],
  )
  const tenantId = rows[0]!.id

  // Employee rows are written through the APP role under tenant context, so the
  // seed itself exercises the WITH CHECK path rather than bypassing it.
  const employeeId = await withTenant(tenantId, async (tx) => {
    const r = await tx.query<{ id: string }>(
      `INSERT INTO employees (tenant_id, employee_number, first_name, last_name, date_of_joining)
       VALUES ($1, $2, $3, $4, DATE '2026-01-01') RETURNING id`,
      [tenantId, num, 'Rahul', lastName],
    )
    const empId = r.rows[0]!.id
    await tx.query(
      `INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from)
       VALUES ($1, $2, $3, $4, DATE '2026-01-01')`,
      [tenantId, empId, 'Engineering', 'Senior Developer'],
    )
    return empId
  })

  return { id: tenantId, employeeId, employeeNumber: num, lastName }
}
