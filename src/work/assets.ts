/**
 * Assets: catalogue, serialised items, issue and return, maintenance.
 *
 * An issue is a record the employee acknowledges; a return records the
 * condition and, for damage or loss, a recovery amount that the exit
 * settlement can pick up. Default categories are seeded on first use and
 * each names the exit-clearance area that must see the item back.
 */
import type { PoolClient } from 'pg'
import { notify } from '../comms/index.ts'

export class AssetError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code; this.name = 'AssetError' }
}
const tenantId = async (tx: PoolClient): Promise<string> => (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t

export const DEFAULT_CATEGORIES: Array<{ code: string; name: string; clearanceArea: 'it' | 'admin' | 'finance' | 'manager'; returnable: boolean }> = [
  { code: 'LAPTOP', name: 'Laptop / desktop', clearanceArea: 'it', returnable: true },
  { code: 'PHONE', name: 'Mobile phone', clearanceArea: 'it', returnable: true },
  { code: 'SIM', name: 'SIM / data card', clearanceArea: 'it', returnable: true },
  { code: 'LICENCE', name: 'Software licence seat', clearanceArea: 'it', returnable: true },
  { code: 'ID_CARD', name: 'ID card / access card', clearanceArea: 'admin', returnable: true },
  { code: 'KEYS', name: 'Keys', clearanceArea: 'admin', returnable: true },
  { code: 'UNIFORM', name: 'Uniform', clearanceArea: 'admin', returnable: false },
  { code: 'PPE', name: 'Safety equipment (PPE)', clearanceArea: 'admin', returnable: false },
  { code: 'TOOL', name: 'Tools & instruments', clearanceArea: 'manager', returnable: true },
  { code: 'VEHICLE', name: 'Vehicle', clearanceArea: 'admin', returnable: true },
]

export interface AssetCategory { id: string; code: string; name: string; clearance_area: string; returnable: boolean }
export async function listCategories(tx: PoolClient): Promise<AssetCategory[]> {
  const tid = await tenantId(tx)
  if ((await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM asset_categories`)).rows[0]!.n === '0') {
    for (const c of DEFAULT_CATEGORIES) {
      await tx.query(`INSERT INTO asset_categories (tenant_id, code, name, clearance_area, returnable) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (tenant_id, code) DO NOTHING`, [tid, c.code, c.name, c.clearanceArea, c.returnable])
    }
  }
  return (await tx.query<AssetCategory>(`SELECT id, code, name, clearance_area, returnable FROM asset_categories ORDER BY name`)).rows
}
export async function upsertCategory(tx: PoolClient, args: { code: string; name: string; clearanceArea?: string; returnable?: boolean }): Promise<AssetCategory> {
  const tid = await tenantId(tx)
  const code = args.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 24)
  if (!code || !args.name?.trim()) throw new AssetError('VALIDATION_FAILED', 'code and name are required')
  if (args.clearanceArea && !['it', 'admin', 'finance', 'manager'].includes(args.clearanceArea)) throw new AssetError('VALIDATION_FAILED', 'clearanceArea is it, admin, finance or manager')
  const { rows } = await tx.query<AssetCategory>(
    `INSERT INTO asset_categories (tenant_id, code, name, clearance_area, returnable) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (tenant_id, code) DO UPDATE SET name = EXCLUDED.name, clearance_area = EXCLUDED.clearance_area, returnable = EXCLUDED.returnable RETURNING id, code, name, clearance_area, returnable`,
    [tid, code, args.name.trim(), args.clearanceArea ?? 'it', args.returnable ?? true])
  return rows[0]!
}

export interface Asset { id: string; category_id: string; category_code: string; tag: string; name: string; serial_no: string | null; purchased_on: string | null; cost_paise: string | null; warranty_until: string | null; location_code: string | null; status: string; notes: string | null; holder_employee_id: string | null; holder_name: string | null }
const A_COLS = `a.id, a.category_id, c.code AS category_code, a.tag, a.name, a.serial_no, a.purchased_on::text, a.cost_paise::text, a.warranty_until::text, a.location_code, a.status, a.notes,
  h.employee_id AS holder_employee_id, (SELECT concat_ws(' ', e.first_name, e.last_name) FROM employees e WHERE e.id = h.employee_id) AS holder_name`
const A_FROM = `FROM assets a JOIN asset_categories c ON (c.tenant_id, c.id) = (a.tenant_id, a.category_id) LEFT JOIN asset_assignments h ON h.asset_id = a.id AND h.returned_on IS NULL`

export async function addAsset(tx: PoolClient, args: { categoryId: string; tag: string; name: string; serialNo?: string | null; purchasedOn?: string | null; costPaise?: number | null; warrantyUntil?: string | null; locationCode?: string | null; notes?: string | null }): Promise<Asset> {
  const tid = await tenantId(tx)
  if (!args.tag?.trim() || !args.name?.trim()) throw new AssetError('VALIDATION_FAILED', 'tag and name are required')
  if ((await tx.query(`SELECT 1 FROM assets WHERE tag = $1`, [args.tag.trim()])).rowCount) throw new AssetError('ASSET_TAG_TAKEN', 'that tag is already in the register')
  if (!(await tx.query(`SELECT 1 FROM asset_categories WHERE id = $1`, [args.categoryId])).rowCount) throw new AssetError('NOT_FOUND', 'no such category')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO assets (tenant_id, category_id, tag, name, serial_no, purchased_on, cost_paise, warranty_until, location_code, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [tid, args.categoryId, args.tag.trim(), args.name.trim(), args.serialNo?.trim() || null, args.purchasedOn ?? null, args.costPaise ?? null, args.warrantyUntil ?? null, args.locationCode ?? null, args.notes ?? null])
  return (await getAsset(tx, rows[0]!.id))!
}
export async function getAsset(tx: PoolClient, id: string): Promise<Asset | null> {
  return (await tx.query<Asset>(`SELECT ${A_COLS} ${A_FROM} WHERE a.id = $1`, [id])).rows[0] ?? null
}
export async function listAssets(tx: PoolClient, args: { status?: string; categoryId?: string; employeeId?: string; q?: string }): Promise<Asset[]> {
  return (await tx.query<Asset>(
    `SELECT ${A_COLS} ${A_FROM} WHERE ($1::text IS NULL OR a.status = $1) AND ($2::uuid IS NULL OR a.category_id = $2) AND ($3::uuid IS NULL OR h.employee_id = $3)
        AND ($4::text IS NULL OR a.tag ILIKE '%' || $4 || '%' OR a.name ILIKE '%' || $4 || '%' OR a.serial_no ILIKE '%' || $4 || '%') ORDER BY a.tag LIMIT 500`,
    [args.status ?? null, args.categoryId ?? null, args.employeeId ?? null, args.q?.trim() || null])).rows
}
export async function setAssetStatus(tx: PoolClient, id: string, status: 'in_stock' | 'in_repair' | 'lost' | 'retired', note?: string): Promise<Asset> {
  const a = await getAsset(tx, id)
  if (!a) throw new AssetError('NOT_FOUND', 'no such asset')
  if (a.holder_employee_id) throw new AssetError('ASSET_ISSUED', 'take it back from the holder first')
  await tx.query(`UPDATE assets SET status = $2, notes = coalesce($3, notes) WHERE id = $1`, [id, status, note ?? null])
  return (await getAsset(tx, id))!
}

export interface Assignment { id: string; asset_id: string; tag: string; name: string; category_code: string; employee_id: string; issued_on: string; issue_condition: string | null; acknowledged_at: string | null; returned_on: string | null; return_condition: string | null; return_note: string | null; recovery_paise: string }
const AS_COLS = `s.id, s.asset_id, a.tag, a.name, c.code AS category_code, s.employee_id, s.issued_on::text, s.issue_condition, s.acknowledged_at::text, s.returned_on::text, s.return_condition, s.return_note, s.recovery_paise::text`
const AS_FROM = `FROM asset_assignments s JOIN assets a ON (a.tenant_id, a.id) = (s.tenant_id, s.asset_id) JOIN asset_categories c ON (c.tenant_id, c.id) = (a.tenant_id, a.category_id)`

export async function issueAsset(tx: PoolClient, args: { assetId: string; employeeId: string; issuedOn?: string; condition?: string; actorUserId: string }): Promise<Assignment> {
  const tid = await tenantId(tx)
  const a = await getAsset(tx, args.assetId)
  if (!a) throw new AssetError('NOT_FOUND', 'no such asset')
  if (a.status !== 'in_stock') throw new AssetError('ASSET_UNAVAILABLE', `the asset is ${a.status.replace('_', ' ')}`)
  const emp = (await tx.query<{ status: string }>(`SELECT status FROM employees WHERE id = $1`, [args.employeeId])).rows[0]
  if (!emp || emp.status !== 'active') throw new AssetError('VALIDATION_FAILED', 'issue only to an active employee')
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO asset_assignments (tenant_id, asset_id, employee_id, issued_on, issued_by_user_id, issue_condition) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [tid, args.assetId, args.employeeId, args.issuedOn ?? new Date().toISOString().slice(0, 10), args.actorUserId, args.condition?.trim() || null])
  await tx.query(`UPDATE assets SET status = 'issued' WHERE id = $1`, [args.assetId])
  const u = (await tx.query<{ id: string }>(`SELECT id FROM app_users WHERE employee_id = $1 AND status = 'active' LIMIT 1`, [args.employeeId])).rows[0]?.id
  if (u) await notify(tx, { userId: u, eventType: 'asset.issued', title: `${a.name} (${a.tag}) issued to you`, body: 'Please acknowledge receipt in My assets.', entityType: 'asset_assignment', entityId: rows[0]!.id, dedupeKey: `asset:${rows[0]!.id}` })
  return (await tx.query<Assignment>(`SELECT ${AS_COLS} ${AS_FROM} WHERE s.id = $1`, [rows[0]!.id])).rows[0]!
}

export async function acknowledgeAsset(tx: PoolClient, args: { assignmentId: string; employeeId: string }): Promise<void> {
  const r = await tx.query(`UPDATE asset_assignments SET acknowledged_at = now() WHERE id = $1 AND employee_id = $2 AND returned_on IS NULL AND acknowledged_at IS NULL`, [args.assignmentId, args.employeeId])
  if (!r.rowCount) throw new AssetError('NOT_FOUND', 'nothing of yours to acknowledge here')
}

export async function returnAsset(
  tx: PoolClient, args: { assignmentId: string; condition: 'good' | 'damaged' | 'lost'; note?: string; recoveryPaise?: number; returnedOn?: string; actorUserId: string },
): Promise<Assignment> {
  if (!['good', 'damaged', 'lost'].includes(args.condition)) throw new AssetError('VALIDATION_FAILED', 'condition is good, damaged or lost')
  const recovery = Math.round(args.recoveryPaise ?? 0)
  if (args.condition !== 'good' && !args.note?.trim()) throw new AssetError('VALIDATION_FAILED', 'say what happened to it')
  if (args.condition === 'good' && recovery > 0) throw new AssetError('VALIDATION_FAILED', 'a good return has no recovery')
  const { rows } = await tx.query<{ asset_id: string }>(
    `UPDATE asset_assignments SET returned_on = $2, return_condition = $3, return_note = $4, recovery_paise = $5, received_by_user_id = $6 WHERE id = $1 AND returned_on IS NULL RETURNING asset_id`,
    [args.assignmentId, args.returnedOn ?? new Date().toISOString().slice(0, 10), args.condition, args.note?.trim() || null, recovery, args.actorUserId])
  if (!rows[0]) throw new AssetError('NOT_FOUND', 'no such open issue')
  await tx.query(`UPDATE assets SET status = $2 WHERE id = $1`, [rows[0].asset_id, args.condition === 'lost' ? 'lost' : args.condition === 'damaged' ? 'in_repair' : 'in_stock'])
  return (await tx.query<Assignment>(`SELECT ${AS_COLS} ${AS_FROM} WHERE s.id = $1`, [args.assignmentId])).rows[0]!
}

export async function assignmentsFor(tx: PoolClient, args: { employeeIds?: string[] | null; employeeId?: string; open?: boolean }): Promise<Assignment[]> {
  return (await tx.query<Assignment>(
    `SELECT ${AS_COLS} ${AS_FROM} WHERE ($1::uuid[] IS NULL OR s.employee_id = ANY($1)) AND ($2::uuid IS NULL OR s.employee_id = $2) AND ($3::boolean IS NULL OR ($3 AND s.returned_on IS NULL) OR (NOT $3 AND s.returned_on IS NOT NULL))
      ORDER BY s.returned_on NULLS FIRST, s.issued_on DESC LIMIT 500`, [args.employeeIds ?? null, args.employeeId ?? null, args.open ?? null])).rows
}

/** Returnable items a leaver still holds, grouped by the clearance area that must see them back. */
export async function openReturnables(tx: PoolClient, employeeId: string): Promise<Array<{ area: string; tag: string; name: string }>> {
  return (await tx.query<{ area: string; tag: string; name: string }>(
    `SELECT c.clearance_area AS area, a.tag, a.name ${AS_FROM} WHERE s.employee_id = $1 AND s.returned_on IS NULL AND c.returnable ORDER BY c.clearance_area, a.tag`, [employeeId])).rows
}

export async function openMaintenance(tx: PoolClient, args: { assetId: string; kind?: 'repair' | 'service' | 'upgrade'; vendor?: string; note?: string }): Promise<{ id: string }> {
  const tid = await tenantId(tx)
  const a = await getAsset(tx, args.assetId)
  if (!a) throw new AssetError('NOT_FOUND', 'no such asset')
  if (a.holder_employee_id) throw new AssetError('ASSET_ISSUED', 'take it back from the holder first')
  const { rows } = await tx.query<{ id: string }>(`INSERT INTO asset_maintenance (tenant_id, asset_id, kind, vendor, note) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [tid, args.assetId, args.kind ?? 'repair', args.vendor ?? null, args.note ?? null])
  await tx.query(`UPDATE assets SET status = 'in_repair' WHERE id = $1`, [args.assetId])
  return rows[0]!
}
export async function closeMaintenance(tx: PoolClient, args: { maintenanceId: string; costPaise?: number; note?: string; backInStock?: boolean }): Promise<void> {
  const { rows } = await tx.query<{ asset_id: string }>(`UPDATE asset_maintenance SET closed_on = CURRENT_DATE, cost_paise = $2, note = coalesce($3, note) WHERE id = $1 AND closed_on IS NULL RETURNING asset_id`, [args.maintenanceId, args.costPaise ?? null, args.note ?? null])
  if (!rows[0]) throw new AssetError('NOT_FOUND', 'no such open maintenance')
  await tx.query(`UPDATE assets SET status = $2 WHERE id = $1`, [rows[0].asset_id, args.backInStock === false ? 'retired' : 'in_stock'])
}

export async function assetSummary(tx: PoolClient): Promise<{ total: number; byStatus: Record<string, number>; byCategory: Array<{ code: string; total: number; issued: number }>; warrantyExpiring: number }> {
  const { rows } = await tx.query<{ status: string; n: string }>(`SELECT status, count(*)::text AS n FROM assets GROUP BY status`)
  const cats = await tx.query<{ code: string; total: string; issued: string }>(`SELECT c.code, count(a.id)::text AS total, count(a.id) FILTER (WHERE a.status = 'issued')::text AS issued FROM asset_categories c LEFT JOIN assets a ON a.category_id = c.id GROUP BY c.code ORDER BY c.code`)
  const w = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM assets WHERE warranty_until BETWEEN CURRENT_DATE AND CURRENT_DATE + 60 AND status <> 'retired'`)
  return { total: rows.reduce((s, r) => s + Number(r.n), 0), byStatus: Object.fromEntries(rows.map((r) => [r.status, Number(r.n)])), byCategory: cats.rows.map((c) => ({ code: c.code, total: Number(c.total), issued: Number(c.issued) })), warrantyExpiring: Number(w.rows[0]!.n) }
}
