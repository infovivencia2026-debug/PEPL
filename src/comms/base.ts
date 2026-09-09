/** Shared plumbing for the communication modules. */
import type { PoolClient } from 'pg'

export class CommsError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.code = code
    this.name = 'CommsError'
  }
}

export async function tenantId(tx: PoolClient): Promise<string> {
  const { rows } = await tx.query<{ t: string | null }>('SELECT current_tenant()::text AS t')
  const t = rows[0]?.t
  if (!t) throw new CommsError('NO_TENANT_CONTEXT', 'no tenant context')
  return t
}
