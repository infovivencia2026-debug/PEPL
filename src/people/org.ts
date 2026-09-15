/**
 * Organisation masters — see 037_org_units.sql.
 *
 * The one behavioural rule: once a company has defined ANY active units of a
 * kind, an assignment must name one of them. A company with no departments
 * defined keeps free text, so nothing breaks on day one; the moment they
 * create the first department, typos stop being departments.
 */
import type { PoolClient } from 'pg'

export type UnitKind = 'department' | 'location' | 'designation' | 'grade'
export const UNIT_KINDS: readonly UnitKind[] = ['department', 'location', 'designation', 'grade']

export class OrgError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'OrgError'
  }
}

export interface OrgUnit {
  id: string
  kind: UnitKind
  code: string
  name: string
  parent_id: string | null
  attributes: Record<string, unknown>
  sort_order: number
  status: 'active' | 'retired'
  retired_at: string | null
  updated_at: string
}

const COLUMNS = 'id, kind, code, name, parent_id, attributes, sort_order, status, retired_at::text, updated_at::text'

/** Per-kind attribute rules: the few that payroll or PT depend on. */
function checkAttributes(kind: UnitKind, a: Record<string, unknown>): void {
  if (kind === 'grade') {
    const min = a.minCtcPaise, max = a.maxCtcPaise
    for (const v of [min, max]) {
      if (v !== undefined && (!Number.isSafeInteger(v) || (v as number) < 0)) {
        throw new OrgError('VALIDATION_FAILED', 'minCtcPaise / maxCtcPaise must be non-negative integers')
      }
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      throw new OrgError('VALIDATION_FAILED', 'minCtcPaise cannot exceed maxCtcPaise')
    }
  }
  if (kind === 'location' && a.stateCode !== undefined && !/^[A-Z]{2}$/.test(String(a.stateCode))) {
    throw new OrgError('VALIDATION_FAILED', 'stateCode is a two-letter code, e.g. TS')
  }
}

function assertKind(kind: string): asserts kind is UnitKind {
  if (!UNIT_KINDS.includes(kind as UnitKind)) {
    throw new OrgError('VALIDATION_FAILED', `kind must be one of ${UNIT_KINDS.join(', ')}`)
  }
}

export async function listUnits(
  tx: PoolClient,
  kind: string,
  opts: { includeRetired?: boolean } = {},
): Promise<OrgUnit[]> {
  assertKind(kind)
  const { rows } = await tx.query<OrgUnit>(
    `SELECT ${COLUMNS} FROM org_units WHERE kind = $1 AND ($2 OR status = 'active')
      ORDER BY sort_order, name`, [kind, opts.includeRetired ?? false])
  return rows
}

export async function createUnit(
  tx: PoolClient,
  args: { kind: string; code: string; name: string; parentId?: string | null; attributes?: Record<string, unknown>; sortOrder?: number },
): Promise<OrgUnit> {
  assertKind(args.kind)
  const code = args.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) {
    throw new OrgError('VALIDATION_FAILED', 'code is 1–24 characters: letters, digits, _ or -')
  }
  const name = args.name.trim()
  if (!name || name.length > 120) throw new OrgError('VALIDATION_FAILED', 'name is 1–120 characters')
  if (args.parentId && args.kind !== 'department') {
    throw new OrgError('VALIDATION_FAILED', 'only departments nest')
  }
  const attributes = args.attributes ?? {}
  checkAttributes(args.kind, attributes)

  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if (args.parentId) {
    const p = await tx.query(`SELECT 1 FROM org_units WHERE id = $1 AND kind = 'department' AND status = 'active'`, [args.parentId])
    if (!p.rowCount) throw new OrgError('NOT_FOUND', 'parent department not found or retired')
  }
  const dup = await tx.query(`SELECT 1 FROM org_units WHERE kind = $1 AND code = $2`, [args.kind, code])
  if (dup.rowCount) throw new OrgError('UNIT_EXISTS', `${args.kind} ${code} already exists (retired units keep their code)`)

  const { rows } = await tx.query<OrgUnit>(
    `INSERT INTO org_units (tenant_id, kind, code, name, parent_id, attributes, sort_order)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) RETURNING ${COLUMNS}`,
    [tid, args.kind, code, name, args.parentId ?? null, JSON.stringify(attributes), args.sortOrder ?? 0])
  return rows[0]!
}

/** Rename, re-parent, re-attribute. The code is the identity and does not change. */
export async function updateUnit(
  tx: PoolClient,
  id: string,
  patch: { name?: string; parentId?: string | null; attributes?: Record<string, unknown>; sortOrder?: number },
): Promise<OrgUnit> {
  const { rows: cur } = await tx.query<OrgUnit>(`SELECT ${COLUMNS} FROM org_units WHERE id = $1`, [id])
  const unit = cur[0]
  if (!unit) throw new OrgError('NOT_FOUND', 'no such unit')
  if (unit.status === 'retired') throw new OrgError('UNIT_RETIRED', 'reinstate it before editing')
  const name = patch.name !== undefined ? patch.name.trim() : unit.name
  if (!name || name.length > 120) throw new OrgError('VALIDATION_FAILED', 'name is 1–120 characters')
  const attributes = patch.attributes !== undefined ? { ...unit.attributes, ...patch.attributes } : unit.attributes
  checkAttributes(unit.kind, attributes)
  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (unit.kind !== 'department') throw new OrgError('VALIDATION_FAILED', 'only departments nest')
    if (patch.parentId === id) throw new OrgError('VALIDATION_FAILED', 'a department cannot be its own parent')
    // No cycles: walk up from the proposed parent.
    let cursor: string | null = patch.parentId
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === id) throw new OrgError('VALIDATION_FAILED', 'that parent is a descendant of this department')
      const r: { rows: { parent_id: string | null }[] } = await tx.query(`SELECT parent_id FROM org_units WHERE id = $1`, [cursor])
      if (!r.rows[0]) throw new OrgError('NOT_FOUND', 'parent department not found')
      cursor = r.rows[0].parent_id
    }
  }
  const { rows } = await tx.query<OrgUnit>(
    `UPDATE org_units SET name = $2, parent_id = $3, attributes = $4::jsonb, sort_order = $5, updated_at = now()
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, name, patch.parentId === undefined ? unit.parent_id : patch.parentId,
     JSON.stringify(attributes), patch.sortOrder ?? unit.sort_order])
  return rows[0]!
}

/**
 * Retire: hidden from pickers, refused on new assignments, kept for history.
 * Reports how many current assignments still point at it so HR can move them.
 */
export async function retireUnit(tx: PoolClient, id: string): Promise<{ unit: OrgUnit; inUseBy: number }> {
  // Checked BEFORE the update: a throw after it would leave the row retired.
  const children = await tx.query(`SELECT 1 FROM org_units WHERE parent_id = $1 AND status = 'active' LIMIT 1`, [id])
  if (children.rowCount) {
    throw new OrgError('UNIT_HAS_CHILDREN', 'retire or re-parent its child departments first')
  }
  const { rows } = await tx.query<OrgUnit>(
    `UPDATE org_units SET status = 'retired', retired_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id])
  const unit = rows[0]
  if (!unit) throw new OrgError('NOT_FOUND', 'no active unit with that id')
  const column = unit.kind === 'department' ? 'department' : unit.kind === 'designation' ? 'designation' : null
  let inUseBy = 0
  if (column) {
    const r = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM employee_assignments
        WHERE ${column} = $1 AND superseded_at IS NULL AND (effective_to IS NULL OR effective_to > CURRENT_DATE)`,
      [unit.code])
    inUseBy = Number(r.rows[0]!.n)
  }
  return { unit, inUseBy }
}

export async function reinstateUnit(tx: PoolClient, id: string): Promise<OrgUnit> {
  const { rows } = await tx.query<OrgUnit>(
    `UPDATE org_units SET status = 'active', retired_at = NULL, updated_at = now()
      WHERE id = $1 AND status = 'retired' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new OrgError('NOT_FOUND', 'no retired unit with that id')
  return rows[0]
}

/**
 * The enforcement point for assignments. Returns the canonical code when the
 * value names an active unit; throws when the kind has masters and it does not;
 * passes free text through when the company has defined none.
 */
export async function resolveUnitCode(tx: PoolClient, kind: UnitKind, value: string): Promise<string> {
  const { rows } = await tx.query<{ code: string; status: string }>(
    `SELECT code, status FROM org_units WHERE kind = $1 AND (code = upper($2) OR lower(name) = lower($2))
      ORDER BY (status = 'active') DESC LIMIT 1`, [kind, value.trim()])
  if (rows[0]?.status === 'active') return rows[0].code
  const any = await tx.query(`SELECT 1 FROM org_units WHERE kind = $1 AND status = 'active' LIMIT 1`, [kind])
  if (!any.rowCount) return value.trim()      // no masters yet: free text stands
  throw new OrgError('UNKNOWN_UNIT',
    rows[0] ? `${kind} "${value}" is retired` : `"${value}" is not a defined ${kind}; pick one from the list or add it first`)
}
