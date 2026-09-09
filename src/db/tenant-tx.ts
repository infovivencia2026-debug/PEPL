import type { PoolClient } from 'pg'
import { appPool } from './pool.ts'

/**
 * The ONLY way application code reaches Postgres.
 *
 * Opens a transaction and pins the tenant for its duration with SET LOCAL
 * (via set_config's is_local=true). SET LOCAL rather than SET is mandatory:
 * PgBouncer in transaction-pooling mode does not preserve session state
 * between transactions, so a connection-scoped tenant would leak across
 * tenants intermittently under load.
 *
 * There is deliberately no default tenant and no way to call this without one.
 */
export async function withTenant<T>(
  tenantId: string,
  fn: (tx: PoolClient) => Promise<T>,
  opts: { userId?: string } = {},
): Promise<T> {
  if (!tenantId) throw new Error('withTenant: tenantId is required')
  const client = await appPool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId])
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [opts.userId ?? ''])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/**
 * Escape hatch used ONLY by the no-context fuzz gate: a transaction on the app
 * role with app.tenant_id deliberately unset. Every tenant-scoped query run
 * inside must return zero rows. Not exported for application use.
 */
export async function withoutTenantForTesting<T>(fn: (tx: PoolClient) => Promise<T>): Promise<T> {
  const client = await appPool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}
