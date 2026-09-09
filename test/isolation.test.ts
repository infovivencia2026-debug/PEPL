import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant, withoutTenantForTesting } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'

let A: Tenant
let B: Tenant

beforeAll(async () => {
  const seeded = await resetAndSeed()
  A = seeded.a
  B = seeded.b
})

afterAll(async () => {
  await closePools()
  await controlPool.end()
})

describe('read isolation', () => {
  it('lists only its own employees', async () => {
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT tenant_id, employee_number FROM employees')).rows,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].employee_number).toBe(A.employeeNumber)
    expect(rows[0].tenant_id).toBe(A.id)
  })

  it('fetching another tenant employee by id returns zero rows, not a 403', async () => {
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT * FROM employees WHERE id = $1', [B.employeeId])).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('searching for another tenant employee by name returns nothing', async () => {
    const rows = await withTenant(A.id, async (tx) =>
      (await tx.query('SELECT * FROM employees WHERE last_name = $1', [B.lastName])).rows,
    )
    expect(rows).toHaveLength(0)
  })

  it('aggregates are scoped - COUNT(*) sees one tenant only', async () => {
    const count = await withTenant(B.id, async (tx) =>
      Number((await tx.query('SELECT count(*)::int AS n FROM employees')).rows[0].n),
    )
    expect(count).toBe(1)
  })

  it('a join across tables stays inside the tenant', async () => {
    const rows = await withTenant(A.id, async (tx) =>
      (
        await tx.query(
          `SELECT e.employee_number, a.designation
             FROM employees e
             JOIN employee_assignments a
               ON (a.tenant_id, a.employee_id) = (e.tenant_id, e.id)`,
        )
      ).rows,
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].employee_number).toBe(A.employeeNumber)
  })

  it('the tenant registry shows only the calling tenant', async () => {
    const rows = await withTenant(A.id, async (tx) => (await tx.query('SELECT id FROM tenants')).rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe(A.id)
  })
})

describe('write isolation', () => {
  it('updating another tenant employee affects zero rows', async () => {
    const n = await withTenant(A.id, async (tx) =>
      (await tx.query('UPDATE employees SET first_name = $1 WHERE id = $2', ['Hacked', B.employeeId]))
        .rowCount,
    )
    expect(n).toBe(0)

    const still = await withTenant(B.id, async (tx) =>
      (await tx.query('SELECT first_name FROM employees WHERE id = $1', [B.employeeId])).rows[0],
    )
    expect(still.first_name).toBe('Rahul')
  })

  it('deleting another tenant employee affects zero rows', async () => {
    const n = await withTenant(A.id, async (tx) =>
      (await tx.query('DELETE FROM employees WHERE id = $1', [B.employeeId])).rowCount,
    )
    expect(n).toBe(0)
  })

  it('WITH CHECK blocks inserting a row stamped with another tenant', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(
          `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
           VALUES ($1, 'X-999', 'Mallory', DATE '2026-02-01')`,
          [B.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('WITH CHECK blocks re-stamping an own row into another tenant', async () => {
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query('UPDATE employees SET tenant_id = $1 WHERE id = $2', [B.id, A.employeeId]),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('the composite FK makes a cross-tenant reference impossible', async () => {
    // Correctly stamped with tenant A, but pointing at an employee owned by B.
    await expect(
      withTenant(A.id, async (tx) =>
        tx.query(
          `INSERT INTO employee_assignments (tenant_id, employee_id, department, designation, effective_from)
           VALUES ($1, $2, 'Sales', 'Rep', DATE '2026-03-01')`,
          [A.id, B.employeeId],
        ),
      ),
    ).rejects.toThrow(/foreign key/i)
  })
})

describe('missing tenant context fails closed', () => {
  it('returns zero rows from every tenant-scoped table when app.tenant_id is unset', async () => {
    const counts = await withoutTenantForTesting(async (tx) => ({
      tenants: Number((await tx.query('SELECT count(*)::int AS n FROM tenants')).rows[0].n),
      employees: Number((await tx.query('SELECT count(*)::int AS n FROM employees')).rows[0].n),
      users: Number((await tx.query('SELECT count(*)::int AS n FROM app_users')).rows[0].n),
      assignments: Number(
        (await tx.query('SELECT count(*)::int AS n FROM employee_assignments')).rows[0].n,
      ),
    }))
    expect(counts).toEqual({ tenants: 0, employees: 0, users: 0, assignments: 0 })
  })

  it('cannot insert without a tenant context', async () => {
    await expect(
      withoutTenantForTesting(async (tx) =>
        tx.query(
          `INSERT INTO employees (tenant_id, employee_number, first_name, date_of_joining)
           VALUES ($1, 'Z-1', 'Nobody', DATE '2026-01-01')`,
          [A.id],
        ),
      ),
    ).rejects.toThrow(/row-level security/i)
  })

  it('withTenant refuses to run without a tenant id', async () => {
    await expect(withTenant('', async () => 'unreachable')).rejects.toThrow(/tenantId is required/)
  })
})

describe('tenant context does not leak between transactions', () => {
  it('a pooled connection reused after tenant A serves tenant B correctly', async () => {
    for (let i = 0; i < 12; i++) {
      const t = i % 2 === 0 ? A : B
      const rows = await withTenant(t.id, async (tx) =>
        (await tx.query('SELECT employee_number FROM employees')).rows,
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].employee_number).toBe(t.employeeNumber)
    }
  })

  it('SET LOCAL does not survive the transaction that set it', async () => {
    await withTenant(A.id, async (tx) => tx.query('SELECT 1'))
    const leaked = await withoutTenantForTesting(
      async (tx) => (await tx.query(`SELECT current_setting('app.tenant_id', true) AS t`)).rows[0].t,
    )
    expect(leaked === null || leaked === '').toBe(true)
  })
})
