import pg from 'pg'
import { config } from '../config.ts'

// A DATE is a calendar day, not an instant. node-pg turns it into local midnight, which serialises as the
// previous day's evening on any server east of UTC (2026-01-05 became 2026-01-04T18:30:00Z). Keep it as text.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value)

const base = { host: config.host, port: config.port, database: config.db }

/** Runtime role: non-owner, NOBYPASSRLS. Every application query uses this. */
export const appPool = new pg.Pool({ ...base, user: config.appUser, password: config.appPassword })

/** Migration/DDL role. Owns the tables. Never used to serve a request. */
export const ownerPool = new pg.Pool({ ...base, user: config.ownerUser, password: config.ownerPassword })

export async function closePools(): Promise<void> {
  await Promise.all([appPool.end(), ownerPool.end()])
}
