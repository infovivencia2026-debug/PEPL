/**
 * Geofences: where a person may punch, decided by the server.
 *
 * The phone sends coordinates; it does not send a verdict. The verdict is the
 * haversine distance from those coordinates to the nearest site the person
 * belongs to, compared with that site's radius. Three outcomes:
 *
 *   inside    within radius of an allowed site      -> accepted
 *   outside   has sites, is not within any          -> recorded, or rejected when enforced
 *   unfenced  no sites apply to this person         -> recorded; nothing to check against
 *
 * An `exempt` member (field staff) is always unfenced. A site with
 * `applies_to_all` fences everyone who is not exempt.
 */
import type { PoolClient } from 'pg'

export class GeofenceError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'GeofenceError'
  }
}

export interface Site {
  id: string
  code: string
  name: string
  lat: number
  lng: number
  radius_m: number
  applies_to_all: boolean
  location_code: string | null
  status: 'active' | 'retired'
}

const COLUMNS = 'id, code, name, lat::float8 AS lat, lng::float8 AS lng, radius_m, applies_to_all, location_code, status'

/** Great-circle distance in metres. Good to well under a metre at these scales. */
export function distanceMetres(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000
  const toRad = (d: number): number => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

function checkCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new GeofenceError('VALIDATION_FAILED', 'lat must be within ±90 and lng within ±180')
  }
}

export async function listSites(tx: PoolClient, opts: { includeRetired?: boolean } = {}): Promise<Site[]> {
  const { rows } = await tx.query<Site>(
    `SELECT ${COLUMNS} FROM geofence_sites WHERE $1 OR status = 'active' ORDER BY name`, [opts.includeRetired ?? false])
  return rows
}

export async function createSite(
  tx: PoolClient,
  args: { code: string; name: string; lat: number; lng: number; radiusM: number; appliesToAll?: boolean; locationCode?: string | null },
): Promise<Site> {
  const code = args.code.trim().toUpperCase()
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(code)) throw new GeofenceError('VALIDATION_FAILED', 'code is 1–24 characters: letters, digits, _ or -')
  if (!args.name.trim() || args.name.length > 120) throw new GeofenceError('VALIDATION_FAILED', 'name is 1–120 characters')
  checkCoords(args.lat, args.lng)
  if (!Number.isInteger(args.radiusM) || args.radiusM < 25 || args.radiusM > 5000) {
    throw new GeofenceError('VALIDATION_FAILED', 'radiusM is a whole number of metres between 25 and 5000')
  }
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  const dup = await tx.query(`SELECT 1 FROM geofence_sites WHERE code = $1`, [code])
  if (dup.rowCount) throw new GeofenceError('SITE_EXISTS', `site ${code} already exists`)
  const { rows } = await tx.query<Site>(
    `INSERT INTO geofence_sites (tenant_id, code, name, lat, lng, radius_m, applies_to_all, location_code)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING ${COLUMNS}`,
    [tid, code, args.name.trim(), args.lat, args.lng, args.radiusM, args.appliesToAll ?? false, args.locationCode?.trim().toUpperCase() || null])
  return rows[0]!
}

export async function updateSite(
  tx: PoolClient,
  id: string,
  patch: { name?: string; lat?: number; lng?: number; radiusM?: number; appliesToAll?: boolean; locationCode?: string | null },
): Promise<Site> {
  const { rows: cur } = await tx.query<Site>(`SELECT ${COLUMNS} FROM geofence_sites WHERE id = $1`, [id])
  const s = cur[0]
  if (!s) throw new GeofenceError('NOT_FOUND', 'no such site')
  if (s.status === 'retired') throw new GeofenceError('SITE_RETIRED', 'reinstate it before editing')
  const lat = patch.lat ?? s.lat, lng = patch.lng ?? s.lng, radius = patch.radiusM ?? s.radius_m
  checkCoords(lat, lng)
  if (!Number.isInteger(radius) || radius < 25 || radius > 5000) throw new GeofenceError('VALIDATION_FAILED', 'radiusM is 25–5000')
  const name = patch.name?.trim() ?? s.name
  if (!name || name.length > 120) throw new GeofenceError('VALIDATION_FAILED', 'name is 1–120 characters')
  const { rows } = await tx.query<Site>(
    `UPDATE geofence_sites SET name = $2, lat = $3, lng = $4, radius_m = $5, applies_to_all = $6, location_code = $7
      WHERE id = $1 RETURNING ${COLUMNS}`,
    [id, name, lat, lng, radius, patch.appliesToAll ?? s.applies_to_all,
     patch.locationCode === undefined ? s.location_code : patch.locationCode?.trim().toUpperCase() || null])
  return rows[0]!
}

export async function retireSite(tx: PoolClient, id: string): Promise<Site> {
  const { rows } = await tx.query<Site>(
    `UPDATE geofence_sites SET status = 'retired', retired_at = now() WHERE id = $1 AND status = 'active' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new GeofenceError('NOT_FOUND', 'no active site with that id')
  // Members of a retired site would otherwise be fenced to nowhere.
  await tx.query(`DELETE FROM geofence_members WHERE site_id = $1`, [id])
  return rows[0]
}

export async function reinstateSite(tx: PoolClient, id: string): Promise<Site> {
  const { rows } = await tx.query<Site>(
    `UPDATE geofence_sites SET status = 'active', retired_at = NULL WHERE id = $1 AND status = 'retired' RETURNING ${COLUMNS}`, [id])
  if (!rows[0]) throw new GeofenceError('NOT_FOUND', 'no retired site with that id')
  return rows[0]
}

export interface Membership { employeeId: string; siteIds: string[]; exempt: boolean }

/** Replaces a person's membership wholesale: the list IS the state. */
export async function setMembership(tx: PoolClient, m: Membership): Promise<Membership> {
  if (m.exempt && m.siteIds.length) throw new GeofenceError('VALIDATION_FAILED', 'an exempt person has no sites')
  const tid = (await tx.query<{ t: string }>('SELECT current_tenant()::text AS t')).rows[0]!.t
  if (m.siteIds.length) {
    const ok = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM geofence_sites WHERE id = ANY($1) AND status = 'active'`, [m.siteIds])
    if (Number(ok.rows[0]!.n) !== new Set(m.siteIds).size) throw new GeofenceError('NOT_FOUND', 'one of those sites does not exist or is retired')
  }
  await tx.query(`DELETE FROM geofence_members WHERE employee_id = $1`, [m.employeeId])
  for (const siteId of new Set(m.siteIds)) {
    await tx.query(`INSERT INTO geofence_members (tenant_id, employee_id, site_id) VALUES ($1,$2,$3)`, [tid, m.employeeId, siteId])
  }
  if (m.exempt) await tx.query(`INSERT INTO geofence_members (tenant_id, employee_id, exempt) VALUES ($1,$2,true)`, [tid, m.employeeId])
  return getMembership(tx, m.employeeId)
}

export async function getMembership(tx: PoolClient, employeeId: string): Promise<Membership> {
  const { rows } = await tx.query<{ site_id: string | null; exempt: boolean }>(
    `SELECT site_id, exempt FROM geofence_members WHERE employee_id = $1`, [employeeId])
  return { employeeId, siteIds: rows.map((r) => r.site_id).filter((s): s is string => !!s), exempt: rows.some((r) => r.exempt) }
}

export interface Verdict {
  status: 'inside' | 'outside' | 'unfenced'
  siteId: string | null
  siteCode: string | null
  distanceM: number | null
}

/** The sites this person may punch from: theirs, plus every applies-to-all site; none if exempt. */
export async function evaluatePunch(tx: PoolClient, employeeId: string, geo: { lat: number; lng: number } | undefined): Promise<Verdict> {
  const { rows: sites } = await tx.query<Site>(
    `SELECT ${COLUMNS} FROM geofence_sites s
      WHERE s.status = 'active'
        AND NOT EXISTS (SELECT 1 FROM geofence_members x WHERE x.employee_id = $1 AND x.exempt)
        AND (s.applies_to_all OR EXISTS (SELECT 1 FROM geofence_members m WHERE m.employee_id = $1 AND m.site_id = s.id))`,
    [employeeId])
  if (!sites.length) return { status: 'unfenced', siteId: null, siteCode: null, distanceM: null }
  if (!geo) return { status: 'outside', siteId: null, siteCode: null, distanceM: null }
  let best: { site: Site; d: number } | null = null
  for (const site of sites) {
    const d = distanceMetres(geo, site)
    if (!best || d < best.d) best = { site, d }
  }
  const d = Math.round(best!.d)
  return {
    status: d <= best!.site.radius_m ? 'inside' : 'outside',
    siteId: best!.site.id, siteCode: best!.site.code, distanceM: d,
  }
}
