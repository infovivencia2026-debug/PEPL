/**
 * Organisation masters: codes are canonical, retire keeps history, departments
 * nest without cycles, and once masters exist an assignment must name one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { resetAndSeed, controlPool, type Tenant } from './fixtures.ts'
import { withTenant } from '../src/db/tenant-tx.ts'
import { closePools } from '../src/db/pool.ts'
import { createUnit, listUnits, reinstateUnit, resolveUnitCode, retireUnit, updateUnit } from '../src/people/org.ts'
import { changeAssignment } from '../src/people/history.ts'

let A: Tenant
let B: Tenant
beforeAll(async () => { const s = await resetAndSeed(); A = s.a; B = s.b })
afterAll(async () => { await closePools(); await controlPool.end() })

describe('units', () => {
  it('creates with an upper-cased code, refuses duplicates and bad shapes, lists per kind', async () => {
    await withTenant(A.id, async (tx) => {
      const sales = await createUnit(tx, { kind: 'department', code: 'sales', name: 'Sales' })
      expect(sales.code).toBe('SALES')
      await expect(createUnit(tx, { kind: 'department', code: 'SALES', name: 'Again' })).rejects.toMatchObject({ code: 'UNIT_EXISTS' })
      await expect(createUnit(tx, { kind: 'department', code: 'bad code!', name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createUnit(tx, { kind: 'team' as never, code: 'X', name: 'x' })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createUnit(tx, { kind: 'grade', code: 'G1', name: 'Grade 1', attributes: { minCtcPaise: 10, maxCtcPaise: 5 } }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(createUnit(tx, { kind: 'location', code: 'HYD', name: 'Hyderabad', attributes: { stateCode: 'Telangana' } }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      const hyd = await createUnit(tx, { kind: 'location', code: 'HYD', name: 'Hyderabad', attributes: { stateCode: 'TS' } })
      expect(hyd.attributes).toEqual({ stateCode: 'TS' })
      // a location cannot have a parent
      await expect(createUnit(tx, { kind: 'location', code: 'CHE', name: 'Chennai', parentId: hyd.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      expect((await listUnits(tx, 'department')).map((u) => u.code)).toEqual(['SALES'])
      expect((await listUnits(tx, 'location')).map((u) => u.code)).toEqual(['HYD'])
    })
  })

  it('departments nest, never in a cycle; retire needs the children gone; reinstate restores', async () => {
    await withTenant(A.id, async (tx) => {
      const [sales] = await listUnits(tx, 'department')
      const north = await createUnit(tx, { kind: 'department', code: 'SALES_N', name: 'Sales North', parentId: sales!.id })
      await expect(updateUnit(tx, sales!.id, { parentId: north.id })).rejects.toMatchObject({ code: 'VALIDATION_FAILED' })
      await expect(retireUnit(tx, sales!.id)).rejects.toMatchObject({ code: 'UNIT_HAS_CHILDREN' })
      // retire the child, then the parent; the retired one is hidden but keeps its code
      await retireUnit(tx, north.id)
      expect((await listUnits(tx, 'department')).map((u) => u.code)).toEqual(['SALES'])
      expect((await listUnits(tx, 'department', { includeRetired: true })).map((u) => u.code).sort()).toEqual(['SALES', 'SALES_N'])
      await expect(createUnit(tx, { kind: 'department', code: 'SALES_N', name: 'x' })).rejects.toMatchObject({ code: 'UNIT_EXISTS' })
      await expect(updateUnit(tx, north.id, { name: 'renamed' })).rejects.toMatchObject({ code: 'UNIT_RETIRED' })
      const back = await reinstateUnit(tx, north.id)
      expect(back.status).toBe('active')
      const renamed = await updateUnit(tx, north.id, { name: 'Sales — North', attributes: { costCentre: 'CC-1' } })
      expect(renamed.name).toBe('Sales — North')
      expect(renamed.code).toBe('SALES_N')
    })
  })

  it('is invisible across tenants', async () => {
    await withTenant(B.id, async (tx) => {
      expect(await listUnits(tx, 'department', { includeRetired: true })).toEqual([])
    })
  })
})

describe('assignments against the masters', () => {
  it('free text while a kind has no masters; canonical code or 422 once it does', async () => {
    await withTenant(A.id, async (tx) => {
      // designations: none defined -> free text stands
      expect(await resolveUnitCode(tx, 'designation', 'Wizard ')).toBe('Wizard')
      // departments: defined -> name or code resolves to the code, retired or unknown is refused
      expect(await resolveUnitCode(tx, 'department', 'sales')).toBe('SALES')
      expect(await resolveUnitCode(tx, 'department', 'Sales — North')).toBe('SALES_N')
      await expect(resolveUnitCode(tx, 'department', 'Marketing')).rejects.toMatchObject({ code: 'UNKNOWN_UNIT' })
      const [, north] = (await listUnits(tx, 'department')).sort((a, b) => a.code.localeCompare(b.code))
      await retireUnit(tx, north!.id)
      await expect(resolveUnitCode(tx, 'department', 'SALES_N')).rejects.toThrow(/retired/)

      // and changeAssignment enforces it
      const id = await changeAssignment(tx, { employeeId: A.employeeId, department: 'sales', designation: 'Engineer', effectiveFrom: '2027-01-01' })
      const { rows } = await tx.query<{ department: string; designation: string }>(
        `SELECT department, designation FROM employee_assignments WHERE id = $1`, [id])
      expect(rows[0]).toEqual({ department: 'SALES', designation: 'Engineer' })
      await expect(changeAssignment(tx, { employeeId: A.employeeId, department: 'Marketing', designation: 'x', effectiveFrom: '2027-02-01' }))
        .rejects.toMatchObject({ code: 'UNKNOWN_UNIT' })

      // the retire report counts current assignments on the unit
      const [sales] = await listUnits(tx, 'department')
      const r = await retireUnit(tx, sales!.id)
      expect(r.inUseBy).toBe(1)
    })
  })
})
