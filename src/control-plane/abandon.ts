/**
 * Clearing away a company whose set-up never finished.
 *
 * Provisioning is a sequence of steps that each commit. When one throws part-way
 * -- an unknown organisation type, a database hiccup -- what is left behind is a
 * tenant, a subscription and an admin user with no password, and a job that says
 * "running". That debris used to block the operator's retry with "an account with
 * this email already exists; sign in instead", for an account that has no
 * password and could never sign in.
 *
 * Deleting a company is the one operation in this system that must never reach a
 * real customer, so it is fenced twice:
 *
 *   1. Only a company whose provisioning job did NOT complete. A completed job is
 *      a customer, however new; suspending is how a customer leaves, because a
 *      payroll is a statutory record.
 *   2. Only one that holds no people and has never been signed into. A stuck job
 *      cannot have either unless somebody used the account after the failure, and
 *      in that case it is not debris, whatever the job says.
 *
 * There is no cascade from `tenants`, so this removes rows table by table. The
 * order between tables is not known in advance (foreign keys run every direction),
 * so it makes several passes and lets the ones that fail on a foreign key try
 * again after their dependants are gone. Whatever the passes cannot remove makes
 * the final delete of the tenant row fail loudly, rather than quietly leaving a
 * tenant that is half deleted.
 */
import { controlDb, ControlPlaneError } from './index.ts'

const PASSES = 8

export async function abandonProvisioning(tenantId: string): Promise<void> {
  const tenant = await controlDb.query<{ legal_name: string }>(
    `SELECT legal_name FROM tenants WHERE id = $1`, [tenantId])
  if (!tenant.rowCount) throw new ControlPlaneError('NOT_FOUND', 'no such company')

  const job = await controlDb.query<{ status: string }>(
    `SELECT status FROM control_plane.provisioning_jobs
      WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 1`, [tenantId])
  if (!job.rowCount || job.rows[0]!.status === 'completed') {
    throw new ControlPlaneError('NOT_ABANDONABLE',
      'this company finished setting up, so it is a customer, not debris. Suspend it instead.')
  }

  const used = await controlDb.query<{ n: string }>(
    `SELECT ((SELECT count(*) FROM employees WHERE tenant_id = $1)
           + (SELECT count(*) FROM sessions  WHERE tenant_id = $1))::text AS n`, [tenantId])
  if (Number(used.rows[0]!.n) > 0) {
    throw new ControlPlaneError('NOT_ABANDONABLE',
      'this company already has people or a sign-in on it, so it is not just a failed set-up.')
  }

  // Recorded first, with no tenant attached, so the record outlives the tenant.
  await controlDb.query(
    `INSERT INTO control_plane.platform_audit (action, tenant_id, detail) VALUES ('platform.tenant.abandoned', NULL, $1::jsonb)`,
    [JSON.stringify({ tenantId, legalName: tenant.rows[0]!.legal_name, jobStatus: job.rows[0]!.status })])

  const { rows: tables } = await controlDb.query<{ sch: string; tbl: string }>(
    `SELECT n.nspname AS sch, c.relname AS tbl
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped
      WHERE c.relkind = 'r' AND n.nspname IN ('public', 'control_plane') AND c.relname <> 'tenants'`)

  for (let pass = 0; pass < PASSES; pass++) {
    let removed = 0
    for (const t of tables) {
      try {
        const r = await controlDb.query(`DELETE FROM "${t.sch}"."${t.tbl}" WHERE tenant_id = $1`, [tenantId])
        removed += r.rowCount ?? 0
      } catch {
        // A foreign key from a table not yet emptied, or a table this role may not
        // touch. Either way it is retried on the next pass; the tenant row's own
        // delete below is what reports anything still standing.
      }
    }
    if (removed === 0) break
  }

  try {
    await controlDb.query(`DELETE FROM tenants WHERE id = $1`, [tenantId])
  } catch (e) {
    throw new ControlPlaneError('ABANDON_INCOMPLETE',
      `could not remove every row for this company (${(e as Error).message}); nothing else was touched`)
  }
}
