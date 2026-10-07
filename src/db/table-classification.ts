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
  // Who a state exempts from professional tax -- Maharashtra exempts women up
  // to Rs 25,000. The same kind of fact as a slab: the law, not a customer
  // preference, and read-only to the application role.
  'pt_exemptions',
  'tax_slabs',
  'tax_rules',
  'lwf_rates',
  // Written BEFORE any tenant is known — it is what rate-limits the login that
  // would resolve the tenant. Holds an email, an IP and a success flag; no
  // tenant data.
  'login_attempts',
  // Same reason: keyed by IP or hashed token, before a tenant exists.
  'rate_limit_buckets',
  // A login that has proved its password and is choosing between the companies
  // it opened. It exists precisely BEFORE a tenant is known, so it cannot be
  // scoped to one; it holds an email and ids, never tenant data.
  'login_choices',
])

/**
 * The global tables the runtime role MAY write, and why. Every other global table is
 * the law (rates, slabs, exemptions) and read-only to the application: `gate:launch`
 * and test/reference-tables-readonly.test.ts fail on a write grant outside this list.
 * 099 forgot the revoke for pt_exemptions; adding a name here is the review point.
 */
export const RUNTIME_WRITABLE_GLOBAL_TABLES: ReadonlyMap<string, string> = new Map([
  ['login_attempts', 'records a login before any tenant is known'],
  ['rate_limit_buckets', 'rate-limits requests before any tenant is known'],
  ['login_choices', 'a proved password choosing between companies, before a tenant is fixed'],
])

/**
 * Tables the runtime role may only INSERT into and read: history and evidence. Default
 * privileges grant UPDATE and DELETE on every new table (003), so an append-only table is
 * append-only only because a migration REVOKEd it -- and `gate:launch` and
 * test/append-only-grants.test.ts fail when one is not. Add a table here when nothing in
 * `src/` needs to change a row after it is written.
 */
export const APPEND_ONLY_TABLES: readonly string[] = [
  'audit_events', 'config_change_log', 'leave_ledger', 'attendance_punches',
  'attendance_corrections', 'approval_actions', 'ticket_events',
  // The thread of a ticket is what was said; editing or deleting it rewrites a grievance.
  'ticket_messages',
  // Opening year-to-date figures a TDS projection is built on: a correction is a new row, the latest wins.
  'payroll_opening_ytd',
  // Lockout counters. If the runtime role could UPDATE or DELETE them, one compromised
  // request would reset every brute-force limit -- and the limit is what stops guessing.
  'login_attempts',
]

/**
 * Updated by the application (soft-delete, supersede, erase) but never HARD-deleted:
 * a document or a bank account is a record, and is retired, not removed.
 */
export const NO_DELETE_TABLES: readonly string[] = ['documents', 'employee_bank_accounts']

/** Tenant-scoped, but keyed on their own id rather than a tenant_id column. */
export const TENANT_ROOT_TABLES: ReadonlySet<string> = new Set(['tenants'])

export const isGlobal = (table: string): boolean => GLOBAL_TABLES.has(table)
export const isTenantRoot = (table: string): boolean => TENANT_ROOT_TABLES.has(table)
