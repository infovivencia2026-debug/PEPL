import type { PoolClient } from 'pg'

/**
 * End a departed employee's access to the product.
 *
 * Marking the EMPLOYEE exited changes payroll; it does nothing to the LOGIN, which is a
 * separate row. Without this a person who had left kept a working session and any API
 * key they had made. Deactivates the linked login, then revokes every session and key
 * it holds, in the caller's transaction so a rollback undoes all of it together.
 *
 * Erased accounts are left as they are (they are already unusable and say so), and the
 * password hash is kept: reinstating a rehired person is an administrator's decision, and
 * a disabled login already cannot sign in.
 */
export async function endAccessForEmployee(tx: PoolClient, employeeId: string): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `UPDATE app_users SET status = 'disabled'
      WHERE employee_id = $1 AND status = 'active'
      RETURNING id`, [employeeId])
  for (const u of rows) {
    await tx.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id])
    await tx.query(`UPDATE api_keys SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id])
  }
  return rows.length
}
