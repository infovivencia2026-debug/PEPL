/**
 * Which tables are tenant-owned, and which legitimately are not.
 *
 * ONE source of truth, imported by every gate. Keeping a second copy inline in a
 * gate script is how the two lists drift and a real finding gets masked by a
 * false one — which is exactly what happened before this file existed.
 *
 * Adding a name here is a deliberate decision that the data is NOT customer
 * data. It is the review point the isolation gates exist to force.
 */

/** No tenant_id, and correctly so. */
export const GLOBAL_TABLES: ReadonlySet<string> = new Set([
  '_migrations',
  // Statutory rates and slabs are the law, not a customer preference. Read-only
  // to the application role; a tenant deviates by acknowledged override.
  'statutory_configs',
  'pt_slabs',
  'tax_slabs',
  'tax_rules',
  // Written BEFORE any tenant is known — it is what rate-limits the login that
  // would resolve the tenant. Holds an email, an IP and a success flag; no
  // tenant data.
  'login_attempts',
])

/** Tenant-scoped, but keyed on their own id rather than a tenant_id column. */
export const TENANT_ROOT_TABLES: ReadonlySet<string> = new Set(['tenants'])

export const isGlobal = (table: string): boolean => GLOBAL_TABLES.has(table)
export const isTenantRoot = (table: string): boolean => TENANT_ROOT_TABLES.has(table)
